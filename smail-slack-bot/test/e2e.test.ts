// Runs the whole pipeline with no network: fake Claude CLI, in-memory GitHub, fake Slack notifier.
// Slack message -> parse -> branch -> apply -> sync site files -> allow-list -> PR -> preview -> approve/decline/undo.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db";
import { normalizeImage } from "../src/images";
import { notQuite, confirm, choose, approve, decline, runJob, type Notifier } from "../src/worker";

// ── in-memory GitHub ──────────────────────────────────────
type Tree = Map<string, string>;
function fakeGitHub(initial: Record<string, string>) {
  const trees = new Map<string, Tree>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const refs = new Map<string, string>();
  const blobs = new Map<string, string>();
  const prs = new Map<number, { head: string; state: string }>();
  let n = 0;
  const id = (p: string) => `${p}${++n}`;
  const mkCommit = (tree: Tree, parents: string[], message: string) => {
    const t = id("tree"), c = id("commit");
    trees.set(t, new Map(tree)); commits.set(c, { tree: t, parents, message });
    return c;
  };
  const treeOf = (commit: string) => trees.get(commits.get(commit)!.tree)!;
  refs.set("main", mkCommit(new Map(Object.entries(initial)), [], "initial human commit"));
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

  const handler = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace(/^\/repos\/o\/r/, ""));
    const m = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : {};
    let r: RegExpMatchArray | null;
    if ((r = path.match(/^\/git\/ref\/heads\/(.+)$/))) return refs.has(r[1]) ? json({ object: { sha: refs.get(r[1]) } }) : json({}, 404);
    if ((r = path.match(/^\/git\/commits\/(.+)$/)) && m === "GET") { const c = commits.get(r[1])!; return json({ message: c.message, parents: c.parents.map((sha) => ({ sha })), tree: { sha: c.tree } }); }
    if ((r = path.match(/^\/contents\/(.+)$/))) { const t = treeOf(u.searchParams.get("ref")!); return t.has(r[1]) ? new Response(t.get(r[1])) : new Response("", { status: 404 }); }
    if (path === "/git/blobs") { const s = id("blob"); blobs.set(s, "base64:" + body.content); return json({ sha: s }, 201); }
    if (path === "/git/trees") {
      const t = new Map(trees.get(body.base_tree)!);
      for (const e of body.tree) { if (e.sha === null) t.delete(e.path); else t.set(e.path, e.sha ? blobs.get(e.sha)! : e.content); }
      const s = id("tree"); trees.set(s, t); return json({ sha: s }, 201);
    }
    if (path === "/git/commits" && m === "POST") { const c = id("commit"); commits.set(c, { tree: body.tree, parents: body.parents, message: body.message }); return json({ sha: c }, 201); }
    if (path === "/git/refs" && m === "POST") { refs.set(body.ref.replace("refs/heads/", ""), body.sha); return json({}, 201); }
    if ((r = path.match(/^\/git\/refs\/heads\/(.+)$/))) {
      if (m === "PATCH") { refs.set(r[1], body.sha); return json({}); }
      if (m === "DELETE") { refs.delete(r[1]); return new Response(null, { status: 204 }); }
    }
    if ((r = path.match(/^\/compare\/(.+)\.\.\.(.+)$/))) {
      const a = treeOf(refs.get(r[1])!), b = treeOf(refs.get(r[2])!);
      const files = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).map((filename) => ({ filename }));
      return json({ files });
    }
    if (path === "/pulls") { const num = prs.size + 1; prs.set(num, { head: body.head, state: "open" }); return json({ number: num }, 201); }
    if ((r = path.match(/^\/pulls\/(\d+)$/)) && m === "PATCH") { prs.get(Number(r[1]))!.state = body.state; return json({}); }
    if ((r = path.match(/^\/pulls\/(\d+)\/merge$/))) {
      const pr = prs.get(Number(r[1]))!;
      const sha = mkCommit(treeOf(refs.get(pr.head)!), [refs.get("main")!], body.commit_title);
      refs.set("main", sha); pr.state = "merged"; return json({ sha });
    }
    if ((r = path.match(/^\/tarball\/(.+)$/))) {
      const t = treeOf(refs.get(r[1])!); const dir = mkdtempSync(join(tmpdir(), "tb-")); const top = join(dir, "repo-abc");
      for (const [p, v] of t) { const f = join(top, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, v.startsWith("base64:") ? Buffer.from(v.slice(7), "base64") : v); }
      return new Response(execFileSync("tar", ["-czf", "-", "-C", dir, "repo-abc"], { maxBuffer: 1e8 }));
    }
    if (path === "/pages/builds/latest") return json({ status: "built", commit: refs.get("main") });
    return json({ error: "unhandled " + m + " " + path }, 500);
  };
  return { handler, refs, prs, main: () => treeOf(refs.get("main")!), branch: (b: string) => (refs.has(b) ? treeOf(refs.get(b)!) : null), mainHead: () => commits.get(refs.get("main")!)! };
}

const ld = (people: unknown[]) => `<script type="application/ld+json">\n{"@graph":${JSON.stringify(people)}}\n</script>`;
const SITE = {
  "data/people.json": JSON.stringify([{ id: "tala-jad", group: "staff", cohort: null, order: 0, published: true, name: "Tala Jad", image: "images/Female-icon.png" }]),
  "data/cohorts.json": "[]", "data/news.json": "[]", "data/site.json": "{}",
  "staff.html": `<html>${ld([{ "@type": "Organization", "@id": "https://smail.org.sa/#organization", name: "SMAIL" }, { "@type": "Person", "@id": "https://smail.org.sa/staff.html#tala-jad", name: "Tala Jad" }])}<a href="/">Home</a></html>`,
  "index.html": `<a href="/">Home</a><a href="/#about">About</a>`,
  "llms.txt": "Current program stats: 0+ mentors, 0+ students, cohorts ongoing.",
};

// ── harness ───────────────────────────────────────────────
const SARA = { ops: [{ op: "upsert_person", attachment: 0, person: { name: "Sara Ali", group: "staff", title: { en: "Coordinator", ar: "منسقة" } } }] };
let dir: string, gh: ReturnType<typeof fakeGitHub>, db: ReturnType<typeof openDb>, c: ReturnType<typeof loadConfig>, sent: any[], alerts: any[];
let jobN = 0;

const fakeClaude = (response: unknown, opts: { fail?: string } = {}) => {
  const resp = join(dir, "resp.json"); writeFileSync(resp, JSON.stringify({ is_error: false, structured_output: response }));
  const bin = join(dir, "claude"); writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\n${opts.fail ? `echo '${opts.fail}' >&2; exit 1` : `cat ${resp}`}\n`); chmodSync(bin, 0o755);
};
const notifier: Notifier = {
  async status(job, m) { sent.push({ job: job.id, m }); if (!job.message_ts) job.message_ts = "1.1"; return "1.1"; },
  async note(job, m) { sent.push({ job: job.id, m, note: true }); },
  async alert(m) { alerts.push(m); },
};
const newJob = (text: string) => { const id = `job${++jobN}`; db.createJob({ id, channel: "C1", thread_ts: "1.0", requester: "U1", text, kind: "edit" }); return db.getJob(id)!; };
const last = (id: string) => sent.filter((s) => s.job === id).at(-1)!.m;
const photo = async () => ({ ...(await normalizeImage(await sharp({ create: { width: 900, height: 900, channels: 3, background: "#468" } }).png().toBuffer())), name: "p" });
const texts = (m: any) => JSON.stringify(m.blocks);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e-")); jobN = 0; sent = []; alerts = [];
  gh = fakeGitHub(SITE); vi.stubGlobal("fetch", (u: any, i: any) => gh.handler(String(u), i));
  db = openDb(":memory:");
  Object.assign(process.env, { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "x", SLACK_CHANNEL_ID: "C1", GITHUB_OWNER: "o", GITHUB_REPO: "r", GITHUB_TOKEN: "t", PREVIEW_BASE_URL: "https://p.example.com", PREVIEW_ROOT: join(dir, "previews"), CLAUDE_BIN: join(dir, "claude"), DEPLOY_POLL_MS: "5", DRY_RUN: "0", CONFIRM_FIRST: "0" });
  delete process.env.ANTHROPIC_API_KEY;
  c = loadConfig();
});
afterEach(() => vi.unstubAllGlobals());

describe("whole pipeline, no network", () => {
  it("add staff member with photo: preview first, main untouched, then Approve goes live", async () => {
    fakeClaude(SARA);
    const job = newJob("add Sara Ali as staff, coordinator");
    await runJob(c, db, notifier, job, [await photo()]);

    const j = db.getJob(job.id)!;
    expect(j.state).toBe("awaiting_approval");
    // main is untouched while waiting
    expect(gh.main().get("data/people.json")).not.toContain("Sara");
    // the branch has the person, the photo, and the synced mirror files
    const b = gh.branch(j.branch!)!;
    expect(JSON.parse(b.get("data/people.json")!).map((p: any) => p.name)).toContain("Sara Ali");
    expect(b.get("images/staff/sara-ali.jpg")).toMatch(/^base64:/);
    expect(b.get("staff.html")).toContain("staff.html#sara-ali");
    expect(b.get("llms.txt")).toContain("0+ mentors");
    // a PR exists and the preview is on disk with links kept inside the preview
    expect(gh.prs.get(j.pr!)!.state).toBe("open");
    const pdir = join(c.previewRoot, j.slug!);
    expect(readFileSync(join(pdir, "index.html"), "utf8")).toContain(`href="/${j.slug}/#about"`);
    expect(existsSync(join(pdir, "robots.txt"))).toBe(true);
    // the Slack card: plain wording, photo, preview link, and both buttons
    const card = last(job.id); const t = texts(card);
    expect(card.text).toMatch(/^Please check this change/);
    expect(t).toContain(`https://p.example.com/${j.slug}/`);
    expect(t).toContain(`https://p.example.com/${j.slug}/images/staff/sara-ali.jpg`);
    expect(t).toContain('"action_id":"approve"');

    // Approve
    await approve(c, db, notifier, job.id, "U9");
    await approve(c, db, notifier, job.id, "U9"); // double click does nothing
    await new Promise((r) => setTimeout(r, 60)); // let the "is it live yet" check run
    expect(gh.main().get("data/people.json")).toContain("Sara Ali");
    expect(gh.mainHead().message).toMatch(/^\[smail-mcp\] /);
    expect(gh.refs.has(j.branch!)).toBe(false); // branch deleted
    expect(existsSync(pdir)).toBe(false); // preview deleted
    expect(db.getJob(job.id)!.state).toBe("live");
    expect(last(job.id).text).toBe("It's live!");
    expect(texts(last(job.id))).not.toContain('"actions"'); // buttons gone
    expect(sent.filter((s) => s.m.text === "Publishing…")).toHaveLength(1);
  });

  it("Decline cleans up everything and leaves main alone", async () => {
    fakeClaude(SARA);
    const job = newJob("add Sara"); await runJob(c, db, notifier, job, [await photo()]);
    const j = db.getJob(job.id)!; const before = gh.refs.get("main");
    await decline(c, db, notifier, job.id, "U9");
    expect(gh.refs.get("main")).toBe(before);
    expect(gh.refs.has(j.branch!)).toBe(false);
    expect(gh.prs.get(j.pr!)!.state).toBe("closed");
    expect(existsSync(join(c.previewRoot, j.slug!))).toBe(false);
    expect(last(job.id).text).toBe("Declined");
  });

  it("Undo takes back the last bot change, with a confirm card first", async () => {
    fakeClaude(SARA);
    const a = newJob("add Sara"); await runJob(c, db, notifier, a, [await photo()]); await approve(c, db, notifier, a.id, "U9");
    expect(gh.main().get("data/people.json")).toContain("Sara Ali");
    fakeClaude({ ops: [{ op: "undo" }] });
    const u = newJob("undo"); await runJob(c, db, notifier, u, []);
    expect(last(u.id).text).toMatch(/^Undo the last change/);
    await approve(c, db, notifier, u.id, "U9");
    expect(gh.main().get("data/people.json")).not.toContain("Sara");
    expect(last(u.id).text).toMatch(/^Done/);
  });

  it("a request that is not a site edit asks a question and changes nothing", async () => {
    fakeClaude({ ops: [], question: "Which cohort is Sara in?" });
    const job = newJob("add Sara"); await runJob(c, db, notifier, job, []);
    expect(last(job.id).text).toBe("Which cohort is Sara in?");
    expect(gh.refs.size).toBe(1); expect(gh.prs.size).toBe(0);
  });

  it("bad model output (missing Arabic) stops cleanly: friendly message, no branch, no PR, nothing left behind", async () => {
    fakeClaude({ ops: [{ op: "upsert_person", person: { name: "Sara Ali", group: "mentor", cohort: 3, title: { en: "Prof" }, affiliation: { en: "KFSH", ar: "x" } } }] });
    const job = newJob("add Sara"); await runJob(c, db, notifier, job, []);
    expect(last(job.id).text).toMatch(/^Nothing was changed/);
    expect(db.getJob(job.id)!.state).toBe("failed");
    expect(gh.refs.size).toBe(1); // the temporary branch was cleaned up
    expect(gh.main().get("data/people.json")).not.toContain("Sara");
  });

  it("expired Claude login: tells the person and alerts the admin", async () => {
    fakeClaude({}, { fail: "401 Invalid bearer token" });
    const job = newJob("add Sara"); await runJob(c, db, notifier, job, []);
    expect(last(job.id).text).toMatch(/Claude login ran out/);
    expect(alerts).toHaveLength(1); expect(alerts[0].text).toMatch(/setup-token/);
  });

  it("test mode (DRY_RUN) never publishes", async () => {
    process.env.DRY_RUN = "1"; c = loadConfig(); fakeClaude(SARA);
    const job = newJob("add Sara"); await runJob(c, db, notifier, job, [await photo()]);
    const before = gh.refs.get("main"); await approve(c, db, notifier, job.id, "U9");
    expect(gh.refs.get("main")).toBe(before);
    expect(last(job.id).text).toBe("Test run only. Nothing was published.");
  });
});

describe("confirm what I understood, and ask when unclear", () => {
  const withUnderstood = { ...SARA, understood: "Add Sara Ali as a staff member (Coordinator), with the attached photo." };
  const noFiles = async () => [] as any[];
  const NOPHOTO = { ops: [{ op: "upsert_person", person: { name: "Sara Ali", group: "staff", title: { en: "Coordinator", ar: "منسقة" }, placeholder: "female" } }] };

  it("shows the plain-language summary first, builds nothing, then builds after 'Yes'", async () => {
    process.env.CONFIRM_FIRST = "1"; c = loadConfig(); fakeClaude(withUnderstood);
    const job = newJob("add sara as staff coordinator");
    await runJob(c, db, notifier, job, [await photo()]);
    let j = db.getJob(job.id)!;
    expect(j.state).toBe("awaiting_confirm");
    expect(j.branch).toBeNull();                       // nothing built yet
    expect(gh.prs.size).toBe(0);
    expect(last(job.id).text).toContain("Add Sara Ali as a staff member");
    expect(texts(last(job.id))).toContain('"action_id":"confirm"');
    expect(texts(last(job.id))).toContain('"action_id":"not_quite"');

    await confirm(c, db, notifier, job.id, "U2", async () => [await photo()]);
    j = db.getJob(job.id)!;
    expect(j.state).toBe("awaiting_approval");          // now the real preview
    expect(JSON.parse(gh.branch(j.branch!)!.get("data/people.json")!).map((p: any) => p.name)).toContain("Sara Ali");
    expect(texts(last(job.id))).toContain('"action_id":"approve"');
  });

  it("double click on 'Yes' builds only once", async () => {
    process.env.CONFIRM_FIRST = "1"; c = loadConfig(); fakeClaude({ ...NOPHOTO, understood: "Add Sara Ali." });
    const job = newJob("add sara"); await runJob(c, db, notifier, job, []);
    await Promise.all([confirm(c, db, notifier, job.id, "U1", noFiles), confirm(c, db, notifier, job.id, "U2", noFiles)]);
    expect(gh.prs.size).toBe(1);
  });

  it("'Not quite' builds nothing and asks them to say it again", async () => {
    process.env.CONFIRM_FIRST = "1"; c = loadConfig(); fakeClaude(withUnderstood);
    const job = newJob("add sara"); await runJob(c, db, notifier, job, []);
    await notQuite(db, notifier, job.id, "U1");
    expect(db.getJob(job.id)!.state).toBe("declined");
    expect(gh.prs.size).toBe(0);
    expect(last(job.id).text).toMatch(/Tell me what to change|Nothing was changed/i);
  });

  it("an unclear request offers choices, and picking one goes straight to the preview", async () => {
    process.env.CONFIRM_FIRST = "1"; c = loadConfig();
    fakeClaude({ ops: [], question: "Two people are called Sara. Which one?", choices: [
      { label: "Sara Ali (staff)", text: "Add Sara Ali as a staff member, Coordinator" },
      { label: "Sara Ali (mentor)", text: "Add Sara Ali as a mentor" },
    ] });
    const job = newJob("add sara"); await runJob(c, db, notifier, job, []);
    expect(db.getJob(job.id)!.state).toBe("awaiting_confirm");
    expect(texts(last(job.id))).toContain('"action_id":"choose_0"');
    expect(texts(last(job.id))).toContain('"action_id":"choose_1"');
    expect(texts(last(job.id))).toContain("None of these");

    fakeClaude(NOPHOTO); // the model now sees the exact wording the user picked
    await choose(c, db, notifier, job.id, 0, "U1", noFiles);
    expect(db.getJob(job.id)!.text).toBe("Add Sara Ali as a staff member, Coordinator");
    expect(db.getJob(job.id)!.state).toBe("awaiting_approval"); // no second "is this right?"
  });

  it("undo skips the confirm card (it has its own confirmation)", async () => {
    process.env.CONFIRM_FIRST = "1"; c = loadConfig(); fakeClaude({ ops: [{ op: "undo" }] });
    // nothing to undo in the fake repo head, but the point is it never asks 'Is this what you meant?'
    const job = newJob("undo"); await runJob(c, db, notifier, job, []);
    expect(db.getJob(job.id)!.state).not.toBe("awaiting_confirm");
  });
});
