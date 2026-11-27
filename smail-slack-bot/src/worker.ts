import { randomUUID } from "node:crypto";
import { GitHubRepo } from "../../smail-mcp/src/github";
import { ToolError } from "../../smail-mcp/src/guard";
import { applyOps, loadSummary, type Attachment } from "./apply";
import { GitHubAdmin, assertAllowedPaths } from "./branch";
import type { Config } from "./config";
import type { Db, Job } from "./db";
import type { Op } from "./ops";
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
  /** Delete the job's status message (used when a message turns out not to be a request). */
  remove?(job: Job): Promise<void>;
}

const repoFor = (c: Config, branch: string) =>
  new GitHubRepo({ owner: c.githubOwner, repo: c.githubRepo, branch, token: c.githubToken, authorName: c.authorName, authorEmail: c.authorEmail });
const adminFor = (c: Config) => new GitHubAdmin({ owner: c.githubOwner, repo: c.githubRepo, token: c.githubToken, base: c.githubBranch });

/** Runs one queued job: parse -> branch -> apply -> validate -> preview -> ask for approval. */
export async function runJob(c: Config, db: Db, n: Notifier, job: Job, attachments: Attachment[], quiet = false, skipConfirm = false): Promise<void> {
  const admin = adminFor(c);
  try {
    db.update(job.id, { state: "parsing" });
    if (!quiet) await n.status(job, M.working());
    const mainRepo = repoFor(c, c.githubBranch);
    const parsed = await parseRequest(c.claudeBin, job.text, attachments.length, await loadSummary(mainRepo), c.claudeTimeoutMs);
    if (!parsed.ops.length && parsed.ignore) {
      db.update(job.id, { state: "declined", error: "ignored (not a site request)" });
      if (!quiet) await n.remove?.(job);
      return;
    }
    if (quiet) await n.status(job, M.working());
    if (!parsed.ops.length && parsed.choices?.length) {
      db.update(job.id, { state: "awaiting_confirm", summary: JSON.stringify(parsed.choices), ops: null });
      await n.status(job, M.choiceCard(job, parsed.question ?? "That could mean a few things. Which one do you mean?", parsed.choices));
      return;
    }
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

    if (c.confirmFirst && !skipConfirm) {
      const lines = parsed.ops.map(describeOp);
      db.update(job.id, { state: "awaiting_confirm", ops: JSON.stringify(parsed.ops), summary: null });
      await n.status(job, M.confirmCard(job, parsed.understood ?? lines[0], lines));
      return;
    }
    await buildAndReview(c, db, n, job, parsed.ops, attachments);
  } catch (e) {
    await failJob(c, db, n, job, e);
  }
}

/** Plain-English line for one operation (shown before anything is built). */
export function describeOp(o: Op): string {
  const en = (v: any) => (v && typeof v === "object" ? v.en ?? "" : String(v ?? ""));
  switch (o.op) {
    case "upsert_person": {
      const p: any = o.person;
      const bits = [p.group, p.cohort ? `cohort ${p.cohort}` : "", en(p.title), en(p.affiliation)].filter(Boolean).join(", ");
      return `Add or update ${p.name ?? "a person"}${bits ? ` (${bits})` : ""}${o.attachment !== undefined ? ", with the attached photo" : ""}`;
    }
    case "post_news": return `Post news: ${en((o.news as any).title)}`;
    case "update_news": return `Edit the news item ${o.id}`;
    case "set_banner": return `Set the banner: ${en((o.banner as any).text)}`;
    case "upsert_cohort": return `Add or update cohort ${(o.cohort as any).id ?? ""}`.trim();
    case "set_visibility": return `${o.published ? "Show" : "Hide"} the ${o.kind} ${o.id}`;
    case "remove_item": return `Remove the ${o.kind} ${o.id}`;
    default: return "Undo the last change";
  }
}

/** Branch, apply, check, preview, then ask for approval. */
export async function buildAndReview(c: Config, db: Db, n: Notifier, job: Job, ops: Op[], attachments: Attachment[]): Promise<void> {
  const admin = adminFor(c);
  try {
    const parsed = { ops };
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
    await failJob(c, db, n, job, e);
  }
}

async function failJob(c: Config, db: Db, n: Notifier, job: Job, e: unknown): Promise<void> {
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

/** The user said "Yes, go ahead" on the confirm card: build the preview from the saved operations. */
export async function confirm(c: Config, db: Db, n: Notifier, id: string, actor: string, loadAttachments: (urls: string[]) => Promise<Attachment[]>): Promise<void> {
  const job = db.getJob(id);
  if (!job || !job.ops) return;
  if (!db.transition(id, "awaiting_confirm", "parsing")) return; // double click
  db.audit(actor, "confirm", id);
  try {
    await n.status(job, M.working("Great. Building the preview…"));
    const atts = await loadAttachments(JSON.parse(job.files ?? "[]"));
    await buildAndReview(c, db, n, job, JSON.parse(job.ops) as Op[], atts);
  } catch (e) { await failJob(c, db, n, job, e); }
}

/** The user picked one of the readings: parse that exact wording and build without asking again. */
export async function choose(c: Config, db: Db, n: Notifier, id: string, index: number, actor: string, loadAttachments: (urls: string[]) => Promise<Attachment[]>): Promise<void> {
  const job = db.getJob(id);
  if (!job || job.state !== "awaiting_confirm") return;
  const choices = JSON.parse(job.summary ?? "[]") as { label: string; text: string }[];
  const pick = choices[index];
  if (!pick || !db.transition(id, "awaiting_confirm", "queued")) return;
  db.audit(actor, "choose", id, pick.label);
  db.update(id, { text: pick.text, summary: null });
  const fresh = db.getJob(id)!;
  try {
    const atts = await loadAttachments(JSON.parse(job.files ?? "[]"));
    await runJob(c, db, n, fresh, atts, false, true);
  } catch (e) { await failJob(c, db, n, fresh, e); }
}

/** "Not quite" / "None of these": drop it and ask them to say it again. */
export async function notQuite(db: Db, n: Notifier, id: string, actor: string): Promise<void> {
  const job = db.getJob(id);
  if (!job || !db.transition(id, "awaiting_confirm", "declined")) return;
  db.audit(actor, "not_quite", id);
  await n.status(job, M.tellMore());
}
