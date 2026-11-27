import { z } from "zod";
import {
  ApplicationPatch,
  BannerInput,
  CohortInput,
  NewsInput,
  PersonInput,
  slug,
  type Person,
} from "./schema";
import {
  DATA_FILES,
  IMAGE_FOLDERS,
  MAX_BULK,
  MAX_IMAGE_BYTES,
  ToolError,
  assertNoSecrets,
  assertSafeImageUrl,
  safeFilename,
} from "./guard";
import type { Plan, Reader, RepoPort } from "./github";

type Json = Record<string, any>;
type PersonResult = { status: "created" | "updated" | "unchanged"; id: string; person: Json };

const fmt = (e: z.ZodError) =>
  e.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ");

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ToolError(`Invalid input. ${fmt(r.error)}`);
  assertNoSecrets(value);
  return r.data;
}

async function readArray(read: Reader, path: string): Promise<Json[]> {
  const t = await read(path);
  if (t === null) throw new ToolError(`${path} does not exist in the repository.`, "data_missing");
  const v = JSON.parse(t);
  if (!Array.isArray(v)) throw new ToolError(`${path} is not a list.`, "data_invalid");
  return v;
}
async function readObject(read: Reader, path: string): Promise<Json> {
  const t = await read(path);
  return t === null ? {} : JSON.parse(t);
}
const out = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class ContentService {
  constructor(private repo: RepoPort, private doFetch: (u: string, i?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i)) {}

  // ── Reads ────────────────────────────────────────────────
  async list(kind: "people" | "cohorts" | "news" | "banner" | "applications", f: { group?: string; cohort?: number; query?: string } = {}) {
    let data: unknown = null;
    await this.repo.transact(async (read) => {
      if (kind === "people") {
        let rows = await readArray(read, DATA_FILES.people);
        if (f.group) rows = rows.filter((p) => p.group === f.group);
        if (f.cohort !== undefined) rows = rows.filter((p) => p.cohort === f.cohort);
        if (f.query) rows = rows.filter((p) => String(p.name).toLowerCase().includes(f.query!.toLowerCase()));
        data = {
          total: rows.length,
          items: rows.slice(0, 200).map((p) => ({
            id: p.id, group: p.group, cohort: p.cohort, name: p.name, title: p.title?.en, affiliation: p.affiliation?.en,
            region: p.region ?? null, published: p.published !== false,
          })),
        };
      } else if (kind === "cohorts") data = await readArray(read, DATA_FILES.cohorts);
      else if (kind === "news") {
        const rows = await readArray(read, DATA_FILES.news);
        data = rows.map((n) => ({ id: n.id, title: n.title?.en, date: n.date, tag: n.tag, featured: !!n.featured, published: n.published !== false, order: n.order }));
      } else if (kind === "applications") data = (await readObject(read, DATA_FILES.site)).applications ?? {};
      else data = (await readObject(read, DATA_FILES.site)).banner ?? null;
      return null;
    });
    return data;
  }

  // ── People ───────────────────────────────────────────────
  private applyPerson(people: Json[], cohorts: Json[], raw: unknown): PersonResult {
    const input = parse(PersonInput, raw);
    const needsCohort = input.group === "mentor" || input.group === "student";
    if (needsCohort && !input.cohort) throw new ToolError(`${input.group} entries need a cohort number.`);
    if (!needsCohort && input.cohort) throw new ToolError(`${input.group} entries do not belong to a cohort.`);
    if (needsCohort && !cohorts.some((c) => c.id === input.cohort)) {
      throw new ToolError(`Cohort ${input.cohort} does not exist. Create it first with upsert_cohort.`, "cohort_missing");
    }
    if (input.group === "board" && !input.title) throw new ToolError("board members need a title (their role).");
    if (input.group === "mentor" && (!input.title || !input.affiliation)) throw new ToolError("mentors need a title and an affiliation.");
    if (input.group === "student" && !input.affiliation) throw new ToolError("students need an affiliation (university).");

    const cohort = needsCohort ? input.cohort! : null;
    const id = slug(input.name) + (cohort ? `-c${cohort}` : "");
    const existing = people.find((p) => p.id === id);
    const { cohort: _c, placeholder, ...rest } = input;
    if (existing) {
      const merged = { ...existing, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)), cohort };
      if (same(merged, existing)) return { status: "unchanged" as const, id, person: existing };
      people[people.indexOf(existing)] = merged;
      return { status: "updated" as const, id, person: merged };
    }
    const peers = people.filter((p) => p.group === input.group && p.cohort === cohort);
    const image = input.image ?? (placeholder === "female" ? "images/Female-icon.png" : placeholder === "male" ? "images/male-icon.png" : null);
    if (!image) throw new ToolError('Give an image path (see upload_image) or placeholder: "male" or "female".');
    const person: Person = {
      id, group: input.group, cohort, order: peers.length ? Math.max(...peers.map((p) => p.order ?? 0)) + 1 : 0,
      published: input.published ?? true, name: input.name,
      image,
      ...(input.title && { title: input.title }),
      ...(input.affiliation && { affiliation: input.affiliation }),
      ...(input.link && { link: input.link }),
      ...(input.mentor && { mentor: input.mentor }),
      ...(input.region !== undefined && { region: input.region }),
    } as Person;
    people.push(person);
    return { status: "created" as const, id, person };
  }

  async upsertPerson(raw: unknown) {
    const r = await this.repo.transact<PersonResult>(async (read) => {
      const people = await readArray(read, DATA_FILES.people);
      const cohorts = await readArray(read, DATA_FILES.cohorts);
      const res = this.applyPerson(people, cohorts, raw);
      if (res.status === "unchanged") return { changes: [], message: "", result: res };
      const verb = res.status === "created" ? "Add" : "Update";
      return {
        changes: [{ path: DATA_FILES.people, text: out(people) }],
        message: `${verb} ${res.person.group} ${res.person.name}${res.person.cohort ? ` (cohort ${res.person.cohort})` : ""}`,
        result: res,
      };
    });
    return { ...r.result!, commit: r.commit };
  }

  async bulkImportPeople(items: unknown[]) {
    if (!Array.isArray(items) || items.length === 0) throw new ToolError("people must be a non-empty list.");
    if (items.length > MAX_BULK) throw new ToolError(`At most ${MAX_BULK} people per call; send the rest in another call.`, "too_many");
    const r = await this.repo.transact(async (read) => {
      const people = await readArray(read, DATA_FILES.people);
      const cohorts = await readArray(read, DATA_FILES.cohorts);
      const results = items.map((raw, index) => {
        try {
          const res = this.applyPerson(people, cohorts, raw);
          return { index, name: res.person.name, id: res.id, status: res.status };
        } catch (e) {
          return { index, name: (raw as any)?.name ?? null, status: "failed" as const, error: e instanceof Error ? e.message : String(e) };
        }
      });
      const created = results.filter((x) => x.status === "created").length;
      const updated = results.filter((x) => x.status === "updated").length;
      const failed = results.filter((x) => x.status === "failed").length;
      const summary = { requested: items.length, created, updated, unchanged: results.filter((x) => x.status === "unchanged").length, failed, results };
      return {
        changes: created + updated ? [{ path: DATA_FILES.people, text: out(people) }] : [],
        message: `Bulk import: ${created} added, ${updated} updated`,
        result: summary,
      } as Plan<typeof summary>;
    });
    return { ...r.result!, commit: r.commit };
  }

  // ── Cohorts ──────────────────────────────────────────────
  async upsertCohort(raw: unknown) {
    const input = parse(CohortInput, raw);
    const r = await this.repo.transact(async (read) => {
      const cohorts = await readArray(read, DATA_FILES.cohorts);
      const i = cohorts.findIndex((c) => c.id === input.id);
      const next = { ...(i >= 0 ? cohorts[i] : { published: true }), id: input.id, label: input.label, status: input.status };
      if (i >= 0 && same(cohorts[i], next)) return { changes: [], message: "", result: { status: "unchanged", cohort: next } } as Plan<any>;
      if (i >= 0) cohorts[i] = next; else cohorts.push(next);
      cohorts.sort((a, b) => a.id - b.id);
      return {
        changes: [{ path: DATA_FILES.cohorts, text: out(cohorts) }],
        message: `${i >= 0 ? "Update" : "Add"} cohort ${input.id} (${input.status})`,
        result: { status: i >= 0 ? "updated" : "created", cohort: next },
      } as Plan<any>;
    });
    return { ...r.result, commit: r.commit };
  }

  // ── News ─────────────────────────────────────────────────
  async postNews(raw: unknown) {
    const input = parse(NewsInput, raw);
    const r = await this.repo.transact(async (read) => {
      const news = await readArray(read, DATA_FILES.news);
      let id = slug(input.title.en) || "news";
      for (let n = 2; news.some((x) => x.id === id); n++) id = `${slug(input.title.en)}-${n}`;
      if (input.featured) news.forEach((x) => { x.featured = false; });
      const order = news.length ? Math.min(...news.map((x) => x.order ?? 0)) - 1 : 0;
      const item = { id, published: input.published ?? true, featured: !!input.featured, order, date: input.date, tag: input.tag, link: input.link, external: !!input.external, ...(input.logo && { logo: input.logo }), title: input.title, summary: input.summary, ...(input.body && { body: input.body }) };
      news.unshift(item);
      return { changes: [{ path: DATA_FILES.news, text: out(news) }], message: `Post news: ${input.title.en}`, result: { status: "created", id, item } } as Plan<any>;
    });
    return { ...r.result, commit: r.commit };
  }

  async updateNews(id: string, patch: Record<string, unknown>) {
    const r = await this.repo.transact(async (read) => {
      const news = await readArray(read, DATA_FILES.news);
      const i = news.findIndex((n) => n.id === id);
      if (i < 0) throw new ToolError(`No news item with id "${id}". Use list_content with kind "news" to see ids.`, "not_found");
      const { id: _i, order: _o, ...cur } = news[i];
      const merged = parse(NewsInput, { ...cur, ...patch });
      if (merged.featured) news.forEach((x) => { x.featured = false; });
      const next = { ...news[i], ...merged, featured: !!merged.featured, external: !!merged.external };
      if (same(next, news[i])) return { changes: [], message: "", result: { status: "unchanged", id } } as Plan<any>;
      news[i] = next;
      return { changes: [{ path: DATA_FILES.news, text: out(news) }], message: `Update news: ${next.title.en}`, result: { status: "updated", id, item: next } } as Plan<any>;
    });
    return { ...r.result, commit: r.commit };
  }

  // ── Banner ───────────────────────────────────────────────
  async setBanner(raw: unknown) {
    const input = parse(BannerInput, raw);
    const r = await this.repo.transact(async (read) => {
      const site = await readObject(read, DATA_FILES.site);
      if (same(site.banner, input)) return { changes: [], message: "", result: { status: "unchanged" } } as Plan<any>;
      site.banner = input;
      return { changes: [{ path: DATA_FILES.site, text: out(site) }], message: input.published ? `Set banner: ${input.text.en}` : "Hide banner", result: { status: "updated", banner: input } } as Plan<any>;
    });
    return { ...r.result, commit: r.commit };
  }

  // ── Application forms (student / mentor) ─────────────────
  async setApplication(raw: unknown) {
    const input = parse(ApplicationPatch, raw);
    const r = await this.repo.transact(async (read) => {
      const site = await readObject(read, DATA_FILES.site);
      const apps = (site.applications ??= {});
      const cur = { open: false, ...(apps[input.target] ?? {}) };
      const next = { ...cur, ...(input.open !== undefined ? { open: input.open } : {}), ...(input.link ? { link: input.link } : {}), ...(input.period ? { period: input.period } : {}) };
      if (next.open && !next.link) throw new ToolError(`The ${input.target} form has no link yet. Give me the form link before opening it.`, "validation");
      if (same(cur, next)) return { changes: [], message: "", result: { status: "unchanged" } } as Plan<any>;
      apps[input.target] = next;
      const what = [input.open !== undefined ? (input.open ? "open" : "close") : "", input.link ? "link" : "", input.period ? "dates" : ""].filter(Boolean).join(", ");
      return { changes: [{ path: DATA_FILES.site, text: out(site) }], message: `Update ${input.target} application (${what})`, result: { status: "updated", application: apps[input.target] } } as Plan<any>;
    });
    return { ...r.result, commit: r.commit };
  }

  // ── Visibility and removal ───────────────────────────────
  private file(kind: "person" | "news" | "cohort") {
    return kind === "person" ? DATA_FILES.people : kind === "news" ? DATA_FILES.news : DATA_FILES.cohorts;
  }

  async setVisibility(kind: "person" | "news" | "cohort", id: string | number, published: boolean) {
    const r = await this.repo.transact(async (read) => {
      const rows = await readArray(read, this.file(kind));
      const row = rows.find((x) => x.id === id);
      if (!row) throw new ToolError(`No ${kind} with id "${id}".`, "not_found");
      if ((row.published !== false) === published) return { changes: [], message: "", result: { status: "unchanged", id, published } } as Plan<any>;
      row.published = published;
      return { changes: [{ path: this.file(kind), text: out(rows) }], message: `${published ? "Publish" : "Hide"} ${kind} ${id}`, result: { status: "updated", id, published } } as Plan<any>;
    });
    return { ...r.result, commit: r.commit };
  }

  async removeItem(kind: "person" | "news" | "cohort", id: string | number, confirm: boolean) {
    const r = await this.repo.transact(async (read) => {
      const rows = await readArray(read, this.file(kind));
      const row = rows.find((x) => x.id === id);
      if (!row) throw new ToolError(`No ${kind} with id "${id}".`, "not_found");
      if (kind === "cohort") {
        const people = await readArray(read, DATA_FILES.people);
        const n = people.filter((p) => p.cohort === id).length;
        if (n) throw new ToolError(`Cohort ${id} still has ${n} people. Remove or move them first, or hide the cohort with set_visibility.`, "cohort_in_use");
      }
      const summary = { kind, id, name: row.name ?? row.title?.en ?? row.label?.en };
      if (!confirm) return { changes: [], message: "", result: { preview: true, wouldRemove: summary, next: "Call remove_item again with confirm: true to delete this." } } as Plan<any>;
      return { changes: [{ path: this.file(kind), text: out(rows.filter((x) => x.id !== id)) }], message: `Remove ${kind} ${summary.name ?? id}`, result: { preview: false, removed: summary } } as Plan<any>;
    });
    return { ...r.result, commit: r.commit };
  }

  // ── Images ───────────────────────────────────────────────
  async uploadImage(url: string, folder: string, filename: string, overwrite = false) {
    if (!(IMAGE_FOLDERS as readonly string[]).includes(folder)) throw new ToolError(`folder must be one of: ${IMAGE_FOLDERS.join(", ")}`);
    const u = assertSafeImageUrl(url);
    const name = safeFilename(filename);
    const res = await this.doFetch(u.toString(), { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new ToolError(`Could not download the image (HTTP ${res.status}).`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) throw new ToolError(`Image must be between 1 byte and ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const isWebp = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45;
    if (!(isPng || isJpg || isWebp)) throw new ToolError("The downloaded file is not a PNG, JPEG or WebP image.");
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const path = `images/${folder}/${name}`;
    const r = await this.repo.transact(async (read) => {
      if (!overwrite && (await read(path)) !== null) throw new ToolError(`${path} already exists. Pick another filename or pass overwrite: true.`, "exists");
      return { changes: [{ path, base64: btoa(bin) }], message: `Add image ${path}`, result: { path, bytes: buf.length } } as Plan<any>;
    });
    return { ...r.result, commit: r.commit, use: `Pass image: "${path}" to upsert_person.` };
  }

  // ── Deploy and undo ──────────────────────────────────────
  async deployStatus() {
    const s = await this.repo.pagesStatus();
    const current = s.commit === s.headCommit;
    const summary =
      s.status === "errored" ? "The last publish failed." :
      s.status === "building" ? "A publish is in progress." :
      current ? "The latest change is live." : "The live site is behind the latest change; it may still be publishing.";
    return { ...s, upToDate: current && s.status === "built", summary };
  }

  async undo(confirm: boolean) {
    const head = await this.repo.head();
    if (!confirm) {
      return { preview: true, wouldUndo: head.message.split("\n")[0], commit: head.sha, next: "Call undo_last_change again with confirm: true." };
    }
    return { preview: false, ...(await this.repo.undoHead()) };
  }
}
