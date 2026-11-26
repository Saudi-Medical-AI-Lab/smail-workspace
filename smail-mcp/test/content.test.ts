import { describe, expect, it } from "vitest";
import { ContentService } from "../src/content";
import { FakeRepo, mentor, seed } from "./fakeRepo";

const setup = () => { const repo = new FakeRepo(seed()); return { repo, svc: new ContentService(repo) }; };

describe("people", () => {
  it("creates a mentor with a stable id and next order", async () => {
    const { repo, svc } = setup();
    const r = await svc.upsertPerson(mentor({ cohort: 1 }));
    expect(r.status).toBe("created"); expect(r.id).toBe("dr-jane-doe-c1");
    const p = repo.json("data/people.json").find((x: any) => x.id === r.id);
    expect(p.order).toBe(1); expect(p.image).toBe("images/Female-icon.png"); expect(p).not.toHaveProperty("placeholder");
  });
  it("is idempotent: repeating the same call makes no commit", async () => {
    const { repo, svc } = setup();
    await svc.upsertPerson(mentor());
    const before = repo.commits;
    const r = await svc.upsertPerson(mentor());
    expect(r.status).toBe("unchanged"); expect(repo.commits).toBe(before);
  });
  it("rejects missing Arabic text", async () => {
    const { svc } = setup();
    await expect(svc.upsertPerson(mentor({ title: { en: "Prof" } }))).rejects.toThrow(/Arabic text is required/);
  });
  it("requires the cohort to exist", async () => {
    const { svc } = setup();
    await expect(svc.upsertPerson(mentor({ cohort: 9 }))).rejects.toThrow(/Cohort 9 does not exist/);
  });
  it("requires an image or placeholder for new people", async () => {
    const { svc } = setup();
    await expect(svc.upsertPerson(mentor({ placeholder: undefined }))).rejects.toThrow(/placeholder/);
  });
  it("refuses secrets in content", async () => {
    const { svc } = setup();
    await expect(svc.upsertPerson(mentor({ name: "Jane ghp_abcdefghijklmnopqrstuvwxyz123456" }))).rejects.toThrow(/secret/);
  });
  it("bulk import saves valid items, reports failures, and is repeatable", async () => {
    const { repo, svc } = setup();
    const batch = [mentor({ name: "A One" }), mentor({ name: "B Two", title: { en: "x" } }), mentor({ name: "C Three" })];
    const r = await svc.bulkImportPeople(batch);
    expect(r).toMatchObject({ requested: 3, created: 2, failed: 1 });
    expect(r.results[1]).toMatchObject({ status: "failed" }); expect(repo.commits).toBe(1);
    const again = await svc.bulkImportPeople([batch[0], batch[2]]);
    expect(again).toMatchObject({ created: 0, unchanged: 2 }); expect(repo.commits).toBe(1);
  });
  it("caps bulk size", async () => {
    const { svc } = setup();
    await expect(svc.bulkImportPeople(Array.from({ length: 101 }, (_, i) => mentor({ name: "P" + i + "x" })))).rejects.toThrow(/At most 100/);
  });
});

describe("cohorts, news, banner", () => {
  it("adds a cohort and then people can join it", async () => {
    const { svc } = setup();
    await svc.upsertCohort({ id: 4, label: { en: "Cohort 4", ar: "الدفعة الرابعة" }, status: "coming_soon" });
    expect((await svc.upsertPerson(mentor({ cohort: 4 }))).status).toBe("created");
  });
  it("posts news first and keeps a single featured story", async () => {
    const { repo, svc } = setup();
    await svc.postNews({ title: { en: "New thing", ar: "جديد" }, summary: { en: "s", ar: "م" }, date: "2026-11", tag: "event", link: "/", featured: true });
    const news = repo.json("data/news.json");
    expect(news[0].id).toBe("new-thing"); expect(news.filter((n: any) => n.featured)).toHaveLength(1); expect(news[0].order).toBeLessThan(news[1].order);
  });
  it("updates only the given fields", async () => {
    const { repo, svc } = setup();
    await svc.updateNews("old", { date: "2026-10" });
    expect(repo.json("data/news.json")[0]).toMatchObject({ date: "2026-10", title: { en: "Old" } });
  });
  it("sets and hides the banner", async () => {
    const { repo, svc } = setup();
    await svc.setBanner({ published: false, text: { en: "x", ar: "س" } });
    expect(repo.json("data/site.json").banner.published).toBe(false);
  });
});

describe("visibility and removal", () => {
  it("hides then republishes", async () => {
    const { repo, svc } = setup();
    await svc.setVisibility("person", "ann-lee-c1", false);
    expect(repo.json("data/people.json")[0].published).toBe(false);
    expect((await svc.setVisibility("person", "ann-lee-c1", false)).status).toBe("unchanged");
  });
  it("previews a delete and only deletes when confirmed", async () => {
    const { repo, svc } = setup();
    const prev: any = await svc.removeItem("person", "ann-lee-c1", false);
    expect(prev.preview).toBe(true); expect(repo.json("data/people.json")).toHaveLength(1);
    await svc.removeItem("person", "ann-lee-c1", true);
    expect(repo.json("data/people.json")).toHaveLength(0);
  });
  it("will not remove a cohort that still has people", async () => {
    const { svc } = setup();
    await expect(svc.removeItem("cohort", 1, true)).rejects.toThrow(/still has 1 people/);
  });
  it("undo previews first, reverses a bot change, and refuses human commits", async () => {
    const { repo, svc } = setup();
    await expect(svc.undo(true)).rejects.toThrow(); // head is the human seed commit
    await svc.upsertPerson(mentor());
    const prev: any = await svc.undo(false);
    expect(prev.preview).toBe(true); expect(repo.json("data/people.json")).toHaveLength(2);
    await svc.undo(true);
    expect(repo.json("data/people.json")).toHaveLength(1);
  });
});

describe("upload_image", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
  const mk = (bytes: Uint8Array) => { const repo = new FakeRepo(seed()); return { repo, svc: new ContentService(repo, async () => new Response(bytes, { status: 200 })) }; };
  it("saves a valid PNG under images/<folder>", async () => {
    const { repo, svc } = mk(png);
    const r: any = await svc.uploadImage("https://example.org/a.png", "mentors", "Jane Doe.PNG");
    expect(r.path).toBe("images/mentors/jane-doe.png"); expect(repo.files.get(r.path)).toMatch(/^base64:/);
  });
  it("rejects http, private hosts, and non-images", async () => {
    const { svc } = mk(png);
    await expect(svc.uploadImage("http://example.org/a.png", "mentors", "a.png")).rejects.toThrow(/https/);
    await expect(svc.uploadImage("https://192.168.1.5/a.png", "mentors", "a.png")).rejects.toThrow(/private/);
    const bad = mk(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    await expect(bad.svc.uploadImage("https://example.org/a.png", "mentors", "a.png")).rejects.toThrow(/not a PNG/);
  });
  it("does not overwrite unless asked", async () => {
    const { svc } = mk(png);
    await svc.uploadImage("https://example.org/a.png", "mentors", "a.png");
    await expect(svc.uploadImage("https://example.org/a.png", "mentors", "a.png")).rejects.toThrow(/already exists/);
    await expect(svc.uploadImage("https://example.org/a.png", "mentors", "a.png", true)).resolves.toBeTruthy();
  });
});
