import { randomUUID } from "node:crypto";
import { GitHubRepo } from "../../smail-mcp/src/github";
import { ToolError } from "../../smail-mcp/src/guard";
import { applyOps, loadSummary, type Attachment } from "./apply";
import { GitHubAdmin, assertAllowedPaths } from "./branch";
import type { Config } from "./config";
import type { Db, Job } from "./db";
import { ClaudeAuthError, ClaudeLimitError, parseRequest } from "./parser";
import * as M from "./messages";
import type { Item, Msg } from "./messages";
import { syncSiteFiles } from "./sitefiles";
import { newSlug, publishPreview, removePreview } from "./preview";

export interface Notifier {
  /** Post/replace the job's status message; returns its ts. */
  status(job: Job, m: Msg): Promise<string>;
  /** A new message in the job's thread (does not replace the status card). */
  note(job: Job, m: Msg): Promise<void>;
  alert(m: Msg): Promise<void>;
}

const repoFor = (c: Config, branch: string) =>
  new GitHubRepo({ owner: c.githubOwner, repo: c.githubRepo, branch, token: c.githubToken, authorName: c.authorName, authorEmail: c.authorEmail });
const adminFor = (c: Config) => new GitHubAdmin({ owner: c.githubOwner, repo: c.githubRepo, token: c.githubToken, base: c.githubBranch });

/** Runs one queued job: parse -> branch -> apply -> validate -> preview -> ask for approval. */
export async function runJob(c: Config, db: Db, n: Notifier, job: Job, attachments: Attachment[]): Promise<void> {
  const admin = adminFor(c);
  try {
    db.update(job.id, { state: "parsing" });
    await n.status(job, M.working());
    const mainRepo = repoFor(c, c.githubBranch);
    const parsed = await parseRequest(c.claudeBin, job.text, attachments.length, await loadSummary(mainRepo), c.claudeTimeoutMs);
    if (!parsed.ops.length) {
      db.update(job.id, { state: "declined", error: parsed.question ?? "No change requested." });
      await n.status(job, parsed.question ? M.needInfo(parsed.question) : M.noChange());
      return;
    }
    if (parsed.ops.some((o) => o.op === "undo")) {
      if (parsed.ops.length > 1) throw new ToolError("Undo cannot be combined with other changes.");
      const head = await mainRepo.head();
      db.update(job.id, { kind: "undo", state: "awaiting_approval", summary: JSON.stringify([{ text: `Undo: ${head.message.split("\n")[0].replace(/^\[smail-mcp\] /, "")}` }]) });
      await n.status(job, M.undoCard(job, head.message.split("\n")[0].replace(/^\[smail-mcp\] /, "")));
      return;
    }

    const branch = `slack/${job.id}`;
    await admin.createBranch(branch);
    db.update(job.id, { branch });
    const slug = newSlug();
    const summary = await applyOps(repoFor(c, branch), parsed.ops, attachments, (path) => `${c.previewBaseUrl}/${slug}/${path}`);
    const lines = summary.map((i) => i.text);
    await syncSiteFiles(repoFor(c, branch));
    assertAllowedPaths(await admin.changedFiles(branch));
    const pr = await admin.openPr(branch, lines.join("; ").slice(0, 120), `Requested in Slack by <@${job.requester}>.\n\n${lines.map((s) => `- ${s}`).join("\n")}`);
    await publishPreview(c.previewRoot, slug, await admin.tarball(branch));
    db.update(job.id, { state: "awaiting_approval", slug, pr, summary: JSON.stringify(summary) });
    db.audit(job.requester, "prepared", job.id, lines.join("; "));
    await n.status(job, M.review(job, summary, `${c.previewBaseUrl}/${slug}/`, { dryRun: c.dryRun }));
  } catch (e) {
    db.update(job.id, { state: "failed", error: e instanceof Error ? e.message.slice(0, 300) : "unknown" });
    await cleanup(c, db, job.id);
    if (e instanceof ClaudeAuthError) {
      await n.alert(M.adminAlert("The Claude login expired. Run `claude setup-token` on a laptop, update `CLAUDE_CODE_OAUTH_TOKEN` on the server, then restart the bot."));
      await n.status(job, M.authDown());
    } else if (e instanceof ClaudeLimitError) {
      await n.status(job, M.limitHit());
    } else if (e instanceof ToolError) {
      await n.status(job, M.failed(e.message));
    } else {
      console.error(JSON.stringify({ job: job.id, err: e instanceof Error ? e.message : String(e) }));
      await n.status(job, M.failedGeneric());
    }
  }
}

/** Remove the branch, PR and preview for a job (best effort). */
export async function cleanup(c: Config, db: Db, id: string): Promise<void> {
  const j = db.getJob(id);
  if (!j) return;
  const admin = adminFor(c);
  if (j.pr) await admin.closePr(j.pr).catch(() => {});
  if (j.branch) await admin.deleteBranch(j.branch).catch(() => {});
  if (j.slug) await removePreview(c.previewRoot, j.slug).catch(() => {});
}

const itemsOf = (job: Job): Item[] => (JSON.parse(job.summary ?? "[]") as (Item | string)[]).map((x) => (typeof x === "string" ? { text: x } : x));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** After a merge, wait (in the background) until GitHub Pages serves it, then flip the message to "Live". */
async function watchDeploy(c: Config, n: Notifier, job: Job, actor: string, items: Item[]): Promise<void> {
  for (let i = 0; i < 18; i++) { // about 6 minutes
    await sleep(c.deployPollMs);
    try {
      const s = await repoFor(c, c.githubBranch).pagesStatus();
      if (s.status === "built" && s.commit === s.headCommit) return void (await n.status(job, M.live(actor, items, c.siteUrl)));
      if (s.status === "errored") break;
    } catch { break; }
  }
  await n.status(job, M.publishedWaiting(actor, items, c.siteUrl)).catch(() => {});
}

export async function approve(c: Config, db: Db, n: Notifier, id: string, actor: string): Promise<void> {
  const job = db.getJob(id);
  if (!job) return;
  if (!db.transition(id, "awaiting_approval", "merging")) return; // already handled (double click)
  db.audit(actor, "approve", id);
  const items = itemsOf(job);
  try {
    if (c.dryRun) { await cleanup(c, db, id); db.update(id, { state: "declined" }); await n.status(job, M.dryRunDone(actor, items)); return; }
    await n.status(job, M.publishing(actor, items)); // buttons disappear immediately
    if (job.kind === "undo") {
      const r = await repoFor(c, c.githubBranch).undoHead();
      db.update(id, { state: "live" });
      await n.status(job, M.undone(actor, r.message));
      return;
    }
    await adminFor(c).mergePr(job.pr!, items.map((i) => i.text).join("; ").slice(0, 120));
    db.update(id, { state: "live" });
    await adminFor(c).deleteBranch(job.branch!).catch(() => {});
    if (job.slug) await removePreview(c.previewRoot, job.slug).catch(() => {});
    void watchDeploy(c, n, job, actor, items);
  } catch (e) {
    db.update(id, { state: "awaiting_approval" });
    // Restore the review card (with its buttons) and explain in a new thread message, so they can retry.
    if (job.slug) await n.status(job, M.review(job, items, `${c.previewBaseUrl}/${job.slug}/`, { dryRun: c.dryRun })).catch(() => {});
    await n.note(job, M.failed(`I couldn't publish this. ${e instanceof ToolError ? e.message : "Something unexpected happened."} The buttons are back, so you can try again.`)).catch(() => {});
  }
}

export async function decline(c: Config, db: Db, n: Notifier, id: string, actor: string): Promise<void> {
  const job = db.getJob(id);
  if (!job || !db.transition(id, "awaiting_approval", "declined")) return;
  db.audit(actor, "decline", id);
  await cleanup(c, db, id);
  await n.status(job, M.declined(actor, itemsOf(job)));
}

export const newJobId = () => randomUUID().slice(0, 8);
