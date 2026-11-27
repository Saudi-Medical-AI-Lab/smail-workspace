import { App, LogLevel } from "@slack/bolt";
import { loadConfig } from "./config";
import { checkSiblings } from "./preflight";
import { openDb, type Job } from "./db";
import { normalizeImage, downloadSlackFile } from "./images";
import { approve, choose, confirm, decline, newJobId, notQuite, runJob, type Notifier } from "./worker";
import { runClaude } from "./parser";
import type { Attachment } from "./apply";
import * as M from "./messages";
import type { Msg } from "./messages";

checkSiblings();
const c = loadConfig();
const db = openDb(c.dbPath);
// SLACK_API_URL is for local testing against a fake Slack only.
const app = new App({ token: c.slackBotToken, signingSecret: c.slackSigningSecret, logLevel: LogLevel.INFO, port: c.port,
  ...(process.env.SLACK_API_URL ? { clientOptions: { slackApiUrl: process.env.SLACK_API_URL } } : {}) });

// Attachments live in memory only until the job runs (they are re-downloaded from Slack, never stored on disk).
const pending = new Map<string, { urls: string[]; quiet: boolean }>();
/** "*" means everyone in the (private) channel. Used for both requesters and approvers. */
const canRequest = (list: string[], id: string) => list.includes("*") || list.includes(id);

const notifier: Notifier = {
  async status(job: Job, m: Msg) {
    // Always send blocks: updating with text only would leave old buttons on the card.
    if (job.message_ts) { await app.client.chat.update({ channel: job.channel, ts: job.message_ts, text: m.text, blocks: m.blocks }); return job.message_ts; }
    const r = await app.client.chat.postMessage({ channel: job.channel, thread_ts: job.thread_ts, text: m.text, blocks: m.blocks, unfurl_links: false });
    db.update(job.id, { message_ts: r.ts! });
    job.message_ts = r.ts!;
    return r.ts!;
  },
  async note(job: Job, m: Msg) { await app.client.chat.postMessage({ channel: job.channel, thread_ts: job.thread_ts, text: m.text, blocks: m.blocks }); },
  async remove(job: Job) { if (job.message_ts) await app.client.chat.delete({ channel: job.channel, ts: job.message_ts }).catch(() => {}); },
  async alert(m: Msg) { await app.client.chat.postMessage({ channel: c.channelId, text: m.text, blocks: m.blocks }); },
};

let botUserId = "";

/** Earlier messages of the same thread, so a short answer ("female") still makes sense. */
async function threadContext(event: any): Promise<string> {
  if (!event.thread_ts || event.thread_ts === event.ts) return "";
  try {
    const r: any = await app.client.conversations.replies({ channel: event.channel, ts: event.thread_ts, limit: 12 });
    const lines = (r.messages ?? [])
      .filter((m: any) => m.ts !== event.ts)
      .map((m: any) => `${m.user === botUserId || m.bot_id ? "Bot" : "User"}: ${String(m.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim()}`)
      .filter((l: string) => l.length > 6);
    return lines.length ? `EARLIER MESSAGES IN THIS THREAD:\n${lines.join("\n").slice(-1500)}\n\nLATEST MESSAGE:\n` : "";
  } catch { return ""; }
}

/** One handler for @mentions and for plain messages in the channel. Plain messages stay silent unless they are real requests. */
async function handleRequest(event: any, eventId: string, implicit: boolean) {
  if (!db.firstSeen(eventId)) return; // Slack retry
  if (event.channel !== c.channelId) return;
  const user: string = event.user;
  const text: string = String(event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
  const reply = (m: Msg | string) => app.client.chat.postMessage({ channel: event.channel, thread_ts: event.thread_ts ?? event.ts, ...(typeof m === "string" ? { text: m } : { text: m.text, blocks: m.blocks }) });

  if (!canRequest(c.requesters, user)) {
    db.audit(user, "denied_request");
    if (implicit) return;
    return void (await reply(M.failed("You can't ask for changes yet. Ask an admin to add you to the list.")));
  }
  const cmd = text.toLowerCase();
  if (cmd === "pause" || cmd === "resume") {
    if (!canRequest(c.approvers, user)) return void (await reply(M.failed("Only approvers can do that.")));
    db.setPaused(cmd === "pause"); db.audit(user, cmd);
    return void (await reply(cmd === "pause" ? ":double_vertical_bar: Paused. I won't start any new changes until someone says `resume`." : ":arrow_forward: I'm back. You can send requests again."));
  }
  const hasFiles = !!(event.files?.length);
  if (!text && !hasFiles) return implicit ? undefined : void (await reply(M.help()));
  if (/^(help|\?)$/i.test(text)) return void (await reply(M.help()));
  if (db.paused) return implicit ? undefined : void (await reply(":double_vertical_bar: I'm paused by an admin right now. Please try again later."));

  const id = newJobId();
  const urls: string[] = (event.files ?? []).filter((f: any) => /^image\//.test(f.mimetype ?? "")).slice(0, 10).map((f: any) => f.url_private_download ?? f.url_private);
  pending.set(id, { urls, quiet: implicit });
  const context = await threadContext(event);
  db.createJob({ id, channel: event.channel, thread_ts: event.thread_ts ?? event.ts, requester: user, text: (context + (text || "(see attached image)")), kind: "edit" });
  db.update(id, { files: JSON.stringify(urls) });
  db.audit(user, "request", id, text.slice(0, 200));
  void drain();
}

app.event("app_mention", async ({ event, body, ack }: any) => {
  if (ack) await ack();
  await handleRequest(event, body.event_id, false);
});

// Every other message in the channel (no @mention needed). Messages that mention the bot are handled above.
app.message(async ({ message, body, ack }: any) => {
  if (ack) await ack();
  const m: any = message;
  if (m.channel !== c.channelId) return;
  if (m.bot_id || m.user === botUserId || !m.user) return;
  if (m.subtype && m.subtype !== "file_share") return;
  if (botUserId && String(m.text ?? "").includes(`<@${botUserId}>`)) return;
  if (/<@[A-Z0-9]+>/.test(String(m.text ?? ""))) return; // addressed to someone else
  await handleRequest(m, body.event_id, true);
});

/** Download and clean the images for a job straight from Slack (they are never kept on disk). */
async function loadAttachments(urls: string[]): Promise<Attachment[]> {
  return Promise.all(urls.map(async (u, i) => {
    const norm = await normalizeImage(await downloadSlackFile(u, c.slackBotToken));
    return { ...norm, name: `image-${i}` };
  }));
}

let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    for (let job = db.nextQueued(); job; job = db.nextQueued()) {
      const p = pending.get(job.id);
      pending.delete(job.id);
      let atts: Attachment[] = [];
      try {
        atts = await loadAttachments(p?.urls ?? []);
      } catch (e) {
        db.update(job.id, { state: "failed", error: String((e as Error).message).slice(0, 300) });
        await notifier.status(job, M.failed((e as Error).message));
        continue;
      }
      await runJob(c, db, notifier, job, atts, p?.quiet ?? false);
    }
  } finally { draining = false; }
}

// Link buttons still send an interaction event; acknowledge it or Slack shows a warning icon.
app.action("open_preview", async ({ ack }: any) => { await ack(); });

// Confirm card and choice buttons ("Is this what you meant?" / "Which one do you mean?")
for (const action of ["confirm", "not_quite", "choose_0", "choose_1", "choose_2", "choose_3"]) {
  app.action(action, async ({ ack, body, action: a }: any) => {
    await ack();
    const user: string = body.user.id;
    if (!canRequest(c.requesters, user)) return;
    try {
      if (action === "confirm") await confirm(c, db, notifier, a.value, user, loadAttachments);
      else if (action === "not_quite") await notQuite(db, notifier, a.value, user);
      else await choose(c, db, notifier, a.value, Number(action.slice(-1)), user, loadAttachments);
    } catch (e) { console.error(JSON.stringify({ action, err: e instanceof Error ? e.message : String(e) })); }
  });
}

for (const action of ["approve", "decline"] as const) {
  app.action(action, async ({ ack, body, action: a }: any) => {
    await ack();
    const user: string = body.user.id;
    const id: string = a.value;
    if (!canRequest(c.approvers, user)) {
      db.audit(user, "denied_" + action, id);
      return void (await app.client.chat.postEphemeral({ channel: body.channel.id, user, text: M.denied("Only approvers can approve or decline changes.") }));
    }
    await (action === "approve" ? approve : decline)(c, db, notifier, id, user);
  });
}

// Health: if the Claude login expired, tell the channel once, before someone's request fails.
let lastHealthy = true;
async function health() {
  try {
    await runClaude(c.claudeBin, "Reply with the JSON {\"ops\":[]}", 60_000);
    lastHealthy = true;
  } catch (e) {
    if (lastHealthy) await notifier.alert(M.adminAlert(`Claude health check failed (${(e as Error).message}). Requests may fail until the login is renewed.`)).catch(() => {});
    lastHealthy = false;
  }
}

// After a restart, in-memory attachments are gone: fail jobs that were mid-flight instead of leaving them stuck.
for (const state of ["queued", "parsing"] as const) {
  for (const j of (db as any).stuck?.(state) ?? []) { db.update(j.id, { state: "failed", error: "restart" }); await notifier.status(j, M.failed("I restarted while working on this. Please send the request again.")).catch(() => {}); }
}

await app.start();
botUserId = String(((await app.client.auth.test()) as any).user_id ?? "");
console.log(`smail-slack-bot listening on :${c.port} (dryRun=${c.dryRun})`);
setInterval(health, 30 * 60_000).unref();
// Expire stale approvals (older than 24h) so previews and branches do not pile up.
setInterval(async () => {
  for (const j of db.awaiting()) if (Date.now() - j.created_at > 24 * 3600_000 && db.transition(j.id, "awaiting_approval", "expired")) {
    const { cleanup } = await import("./worker");
    await cleanup(c, db, j.id);
    await notifier.status(j, M.expired()).catch(() => {});
  }
  for (const j of db.waitingConfirm()) if (Date.now() - j.created_at > 2 * 3600_000 && db.transition(j.id, "awaiting_confirm", "expired")) {
    await notifier.status(j, M.expired()).catch(() => {});
  }
}, 15 * 60_000).unref();
