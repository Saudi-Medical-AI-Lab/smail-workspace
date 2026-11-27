import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeRepo, seed, mentor } from "../../smail-mcp/test/fakeRepo";
import { applyOps, loadSummary } from "../src/apply";
import { assertAllowedPaths } from "../src/branch";
import { openDb } from "../src/db";
import { normalizeImage, downloadSlackFile } from "../src/images";
import { Op, ParseResult } from "../src/ops";
import { buildPrompt, runClaude, ClaudeAuthError, ClaudeLimitError } from "../src/parser";

describe("ops schema", () => {
  it("accepts a person op and rejects unknown ops", () => {
    expect(ParseResult.safeParse({ ops: [{ op: "upsert_person", person: mentor() }] }).success).toBe(true);
    expect(ParseResult.safeParse({ ops: [{ op: "delete_everything" }] }).success).toBe(false);
    expect(Op.safeParse({ op: "remove_item", kind: "repo", id: "x" }).success).toBe(false);
  });
});

describe("applyOps", () => {
  it("adds a mentor with a photo and writes it under images/mentors", async () => {
    const repo = new FakeRepo(seed());
    const photo = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#888" } }).png().toBuffer();
    const img = await normalizeImage(photo);
    const lines = await applyOps(repo, [{ op: "upsert_person", person: mentor(), attachment: 0 }], [{ ...img, name: "a" }]);
    expect(lines[0].text).toBe("Add mentor: Dr. Jane Doe");
    expect(lines[0].detail).toContain("Assistant Professor · أستاذ مساعد");
    expect(lines[0].image).toBeUndefined(); // only shown when a preview base is given
    const added = repo.json("data/people.json").find((p: any) => p.name === "Dr. Jane Doe");
    expect(added.image).toBe("images/mentors/dr-jane-doe.jpg");
    expect(added.placeholder).toBeUndefined();
    expect(repo.files.get("images/mentors/dr-jane-doe.jpg")).toMatch(/^base64:/);
  });
  it("rejects a person missing Arabic text and writes nothing", async () => {
    const repo = new FakeRepo(seed());
    await expect(applyOps(repo, [{ op: "upsert_person", person: mentor({ title: { en: "Prof" } }) }], [])).rejects.toThrow(/Arabic/);
    expect(repo.commits).toBe(0);
  });
  it("rejects a bad attachment index", async () => {
    await expect(applyOps(new FakeRepo(seed()), [{ op: "upsert_person", person: mentor(), attachment: 2 }], [])).rejects.toThrow(/attachment 3/);
  });
  it("refuses secrets in content", async () => {
    await expect(applyOps(new FakeRepo(seed()), [{ op: "upsert_person", person: mentor({ name: "ghp_" + "a".repeat(30) }) }], [])).rejects.toThrow(/secret/i);
  });
  it("hides and removes", async () => {
    const repo = new FakeRepo(seed());
    await applyOps(repo, [{ op: "set_visibility", kind: "person", id: "ann-lee-c1", published: false }], []);
    expect(repo.json("data/people.json")[0].published).toBe(false);
    await applyOps(repo, [{ op: "remove_item", kind: "person", id: "ann-lee-c1" }], []);
    expect(repo.json("data/people.json")).toHaveLength(0);
  });
  it("summarises ids for the parser", async () => {
    const s = await loadSummary(new FakeRepo(seed()));
    expect(s.people[0]).toMatchObject({ id: "ann-lee-c1", group: "mentor" });
    expect(s.cohorts).toEqual([1, 3]);
  });
});

describe("path allow-list", () => {
  it("allows data and image paths, blocks everything else", () => {
    expect(() => assertAllowedPaths(["data/people.json", "images/staff/a.jpg"])).not.toThrow();
    for (const bad of ["index.html", "JS/content.js", ".github/workflows/x.yml", "CNAME", "images/other/a.jpg", "data/../index.html"]) {
      expect(() => assertAllowedPaths([bad])).toThrow(/not allowed to edit/);
    }
  });
});

describe("images", () => {
  it("shrinks big images and rejects non-images", async () => {
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#123" } }).jpeg().toBuffer();
    const out = await normalizeImage(big);
    const meta = await sharp(out.data).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(800);
    await expect(normalizeImage(Buffer.from("<html>not an image</html>"))).rejects.toThrow(/PNG, JPEG or WebP/);
  });
  it("never sends the Slack token to other hosts", async () => {
    await expect(downloadSlackFile("https://evil.example.com/x.png", "xoxb-secret")).rejects.toThrow(/non-Slack/);
    await expect(downloadSlackFile("http://files.slack.com/x.png", "xoxb-secret")).rejects.toThrow(/non-Slack/);
  });
});

describe("db", () => {
  it("dedupes events and guards double approval", () => {
    const db = openDb(":memory:");
    expect(db.firstSeen("Ev1")).toBe(true);
    expect(db.firstSeen("Ev1")).toBe(false);
    db.createJob({ id: "j1", channel: "C", thread_ts: "1", requester: "U", text: "t", kind: "edit" });
    db.update("j1", { state: "awaiting_approval" });
    expect(db.transition("j1", "awaiting_approval", "merging")).toBe(true);
    expect(db.transition("j1", "awaiting_approval", "merging")).toBe(false);
    db.setPaused(true);
    expect(db.paused).toBe(true);
  });
});

describe("claude runner", () => {
  const fake = (script: string) => {
    const f = join(mkdtempSync(join(tmpdir(), "fakeclaude-")), "claude");
    writeFileSync(f, "#!/bin/sh\ncat >/dev/null\n" + script);
    chmodSync(f, 0o755);
    return f;
  };
  it("reads structured output", async () => {
    const bin = fake(`echo '{"is_error":false,"structured_output":{"ops":[]}}'`);
    expect(await runClaude(bin, "x", 5000)).toEqual({ ops: [] });
  });
  it("maps expired login and limits to typed errors", async () => {
    await expect(runClaude(fake(`echo '401 Invalid bearer token' >&2; exit 1`), "x", 5000)).rejects.toBeInstanceOf(ClaudeAuthError);
    await expect(runClaude(fake(`echo 'usage limit reached' >&2; exit 1`), "x", 5000)).rejects.toBeInstanceOf(ClaudeLimitError);
  });
  it("times out", async () => {
    await expect(runClaude(fake("sleep 5"), "x", 300)).rejects.toThrow(/timed out/);
  });
  it("neutralises triple quotes in untrusted text", () => {
    expect(buildPrompt('a """ b', 0, { people: [], news: [], cohorts: [] })).not.toMatch(/a """ b/);
  });
});

import { syncStaffJsonLd, syncLlmsStats } from "../src/sitefiles";
import { rebase } from "../src/preview";
import { syncSiteFiles } from "../src/sitefiles";

const page = (people: any[]) => `<head>\n    <script type="application/ld+json">\n    ${JSON.stringify({ "@context": "https://schema.org", "@graph": people }, null, 2).split("\n").join("\n    ")}\n    </script>\n</head>`;
const org = { "@type": "Organization", "@id": "https://smail.org.sa/#organization", name: "SMAIL" };
const person = (id: string, name: string, extra: any = {}) => ({ "@type": "Person", "@id": "https://smail.org.sa/staff.html#" + id, name, ...extra });
const ids = (html: string) => JSON.parse(html.match(/ld\+json">([\s\S]*?)<\/script>/)![1])["@graph"].map((g: any) => g["@id"].split("#")[1] ?? "org");

describe("staff JSON-LD sync", () => {
  it("is a no-op (byte-identical) when already in sync", () => {
    const html = page([org, person("ann", "Ann")]);
    expect(syncStaffJsonLd(html, [{ id: "ann", name: "Ann", group: "staff" }])).toBe(html);
  });
  it("adds new staff with title and link, keeps hand-written entries untouched", () => {
    const html = page([org, person("ann", "Ann", { sameAs: ["https://a", "https://b"], jobTitle: "Founder" })]);
    const out = syncStaffJsonLd(html, [
      { id: "ann", name: "Ann", group: "staff" },
      { id: "sara", name: "Sara Ali", group: "staff", title: { en: "Lead" }, link: "https://www.linkedin.com/in/sara" },
    ]);
    const g = JSON.parse(out.match(/ld\+json">([\s\S]*?)<\/script>/)![1])["@graph"];
    expect(g.find((x: any) => x.name === "Ann").sameAs).toHaveLength(2);
    expect(g.find((x: any) => x.name === "Sara Ali")).toMatchObject({ jobTitle: "Lead", sameAs: ["https://www.linkedin.com/in/sara"] });
  });
  it("removes hidden/removed staff but never the Organization; follows renames", () => {
    const html = page([org, person("ann", "Ann"), person("bob", "Bob")]);
    const out = syncStaffJsonLd(html, [{ id: "ann", name: "Ann B", group: "staff_alumni" }, { id: "bob", name: "Bob", group: "staff", published: false }]);
    expect(ids(out)).toEqual(["organization", "ann"]);
    expect(out).toContain("Ann B");
  });
  it("ignores mentors and students", () => {
    const html = page([org]);
    expect(syncStaffJsonLd(html, [{ id: "m", name: "M", group: "mentor" }])).toBe(html);
  });
});

describe("llms stats and site-file commit", () => {
  const people = [...Array(21)].map((_, i) => ({ id: "m" + i, name: "M" + i, group: "mentor" })).concat([...Array(5)].map((_, i) => ({ id: "s" + i, name: "S" + i, group: "student" })));
  it("updates the counts line", () => {
    expect(syncLlmsStats("x\nCurrent program stats: 20+ mentors, 31+ students, cohorts ongoing.\n", people)).toContain("21+ mentors, 5+ students");
  });
  it("commits only when something changed", async () => {
    const repo = new FakeRepo({
      "data/people.json": [{ id: "t", group: "staff", name: "Tess", published: true }],
      "staff.html": page([org]),
      "llms.txt": "Current program stats: 0+ mentors, 0+ students, cohorts ongoing.",
    });
    expect(await syncSiteFiles(repo)).toBe(true);
    expect(ids(repo.files.get("staff.html")!)).toEqual(["organization", "t"]);
    expect(await syncSiteFiles(repo)).toBe(false);
  });
});

describe("preview rebase", () => {
  it("keeps root-absolute links inside the preview and leaves external ones alone", () => {
    const html = rebase("a.html", `<a href="/">h</a><a href="/#about">a</a><img src="/images/x.png"><a href="https://x.org/">e</a><a href="//cdn/x">c</a><a href="staff.html">r</a>`, "abc");
    expect(html).toBe(`<a href="/abc/">h</a><a href="/abc/#about">a</a><img src="/abc/images/x.png"><a href="https://x.org/">e</a><a href="//cdn/x">c</a><a href="staff.html">r</a>`);
    expect(rebase("news.json", `[{"link": "/news.html"},{"link":"https://x"}]`, "abc")).toBe(`[{"link": "/abc/news.html"},{"link":"https://x"}]`);
    expect(rebase("navbarScript.js", `window.location.href = '/';`, "abc")).toContain("'/abc/'");
  });
});

import * as M from "../src/messages";

describe("slack messages", () => {
  const job = { id: "j1", requester: "U1" };
  const items = [{ text: "Add mentor: Sara <Ali> & co", detail: "Cohort 3\nAssociate Professor · أستاذ مشارك", image: "https://p.example.com/abc/images/mentors/sara.jpg" }, { text: "Hide student x" }];
  const walk = (m: M.Msg) => { expect(m.text.length).toBeGreaterThan(0); expect(m.text.length).toBeLessThanOrEqual(300 + 50); expect(m.blocks.length).toBeLessThanOrEqual(50); return JSON.stringify(m.blocks); };

  it("review card: header, photo, preview link button, approve+decline with ids, expiry, dry-run note", () => {
    const m = M.review(job, items, "https://p.example.com/abc/", { dryRun: true });
    const actions = m.blocks.find((b) => b.type === "actions");
    expect(actions.block_id).toBe("job:j1");
    expect(actions.elements.map((e: any) => e.action_id)).toEqual(["open_preview", "approve", "decline"]);
    expect(actions.elements[0].url).toBe("https://p.example.com/abc/");
    expect(actions.elements[1].value).toBe("j1");
    expect(actions.elements[1].confirm).toBeTruthy();
    const j = walk(m);
    expect(j).toContain("image_url");
    expect(j).toContain("Test mode");
    expect(j).toContain("Sara &lt;Ali&gt; &amp; co"); // Slack control characters are escaped
    expect(m.blocks[0].text.text).toBe("Please check these 2 changes");
  });
  it("every result state removes the buttons and names who acted", () => {
    for (const m of [M.publishing("U2", items), M.live("U2", items, "https://smail.org.sa"), M.publishedWaiting("U2", items, "https://smail.org.sa"), M.declined("U2", items), M.dryRunDone("U2", items), M.undone("U2", "x"), M.expired()]) {
      expect(walk(m)).not.toContain('"actions"');
    }
    expect(JSON.stringify(M.live("U2", items, "https://smail.org.sa"))).toContain("<@U2>");
  });
  it("caps long lists and long text", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ text: "Add person " + i }));
    const m = M.review(job, many, "https://p/x/");
    expect(m.blocks.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(m.blocks)).toContain("and 20 more");
    const long = M.review(job, [{ text: "t", detail: "d".repeat(5000) }], "https://p/x/");
    for (const b of long.blocks) if (b.text?.text) expect(b.text.text.length).toBeLessThanOrEqual(3000);
  });
  it("help and error messages render", () => {
    for (const m of [M.help(), M.failedGeneric(), M.authDown(), M.limitHit(), M.needInfo("Which cohort?"), M.noChange(), M.undoCard(job, "Add x"), M.working()]) walk(m);
    expect(JSON.stringify(M.help())).toContain("undo");
  });
});

describe("untrusted input (prompt injection, SQL injection, mentions)", () => {
  it("model replies lose links and mass mentions", () => {
    const out = M.chat("Hi <!channel> <@U123> see https://evil.example.com/x and www.evil.io or https://smail.org.sa/news.html");
    const t = JSON.stringify(out);
    expect(t).not.toContain("evil");
    expect(t).not.toContain("<!channel>");
    expect(t).not.toContain("<@U123>");
    expect(t).toContain("https://smail.org.sa/news.html");
    expect(M.cleanReply("x".repeat(5000)).length).toBeLessThanOrEqual(600);
  });
  it("SQL in a message is stored as plain text, and unknown columns cannot be updated", () => {
    const db = openDb(":memory:");
    const evil = "x'); DROP TABLE jobs;--";
    db.createJob({ id: "a", channel: "C", thread_ts: "1", requester: evil, text: evil, kind: "edit" });
    expect(db.getJob("a")!.text).toBe(evil);
    db.update("a", { error: evil });
    expect(db.getJob("a")!.error).toBe(evil);
    expect(() => db.update("a", { ["state = 'live', text"]: "x" } as any)).toThrow(/updatable/);
    expect(db.getJob("a")).toBeTruthy(); // table still there
  });
});

describe("saving usage", () => {
  it("skips trivial messages and limits bursts", async () => {
    const { isTrivial, makeLimiter } = await import("../src/parser");
    for (const t of ["lmao", "👍", ":thumbsup:", "ok!", "  ", "<@U1>"]) expect(isTrivial(t)).toBe(true);
    for (const t of ["hi", "add Sara Ali", "what can you do?", "مرحبا"]) expect(isTrivial(t)).toBe(false);
    const ok = makeLimiter(2, 60_000);
    expect([ok(), ok(), ok()]).toEqual([true, true, false]);
  });
});

describe("claude runner does not misread a good answer", () => {
  const fake = (script: string) => { const f = join(mkdtempSync(join(tmpdir(), "fakeclaude-")), "claude"); writeFileSync(f, "#!/bin/sh\ncat >/dev/null\n" + script); chmodSync(f, 0o755); return f; };
  it("a successful answer containing 429 / 401 / oauth is NOT an error", async () => {
    const bin = fake(`echo '{"is_error":false,"duration_ms":4290,"uuid":"x401y","structured_output":{"ops":[],"reply":"the oauth rate limit 429 is explained here"}}'`);
    expect(await runClaude(bin, "x", 5000)).toEqual({ ops: [], reply: "the oauth rate limit 429 is explained here" });
  });
  it("a real 429 reported in the JSON still maps to the limit error", async () => {
    const bin = fake(`echo '{"is_error":true,"api_error_status":429,"result":"Too many requests"}'`);
    await expect(runClaude(bin, "x", 5000)).rejects.toBeInstanceOf(ClaudeLimitError);
  });
});
