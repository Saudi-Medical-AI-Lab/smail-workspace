import { ContentService } from "../../smail-mcp/src/content";
import { ToolError } from "../../smail-mcp/src/guard";
import { slug } from "../../smail-mcp/src/schema";
import type { Plan, RepoPort } from "../../smail-mcp/src/github";
import type { Op } from "./ops";
import type { Summary } from "./parser";
import type { Item } from "./messages";

export type Attachment = { data: Buffer; ext: "jpg" | "png"; name: string };

const FOLDER: Record<string, string> = { board: "board", staff: "staff", staff_alumni: "staff", mentor: "mentors", student: "students" };

export async function loadSummary(repo: RepoPort): Promise<Summary> {
  let s: Summary = { people: [], news: [], cohorts: [], applications: {} };
  await repo.transact(async (read) => {
    const arr = async (p: string) => JSON.parse((await read(p)) ?? "[]") as any[];
    const people = await arr("data/people.json");
    const news = await arr("data/news.json");
    const cohorts = await arr("data/cohorts.json");
    s = {
      people: people.map((p) => ({ id: p.id, name: p.name, group: p.group, cohort: p.cohort ?? null })),
      news: news.map((n) => ({ id: n.id, title: n.title?.en ?? "" })),
      cohorts: cohorts.map((c) => c.id),
      applications: Object.fromEntries(Object.entries(((JSON.parse((await read("data/site.json")) ?? "{}") as any).applications ?? {}) as Record<string, any>).map(([k, v]) => [k, { open: !!v.open, hasLink: !!v.link, period: v.period?.en ?? "" }])),
    };
    return null;
  });
  return s;
}

async function putImage(repo: RepoPort, folder: string, base: string, a: Attachment): Promise<string> {
  const path = `images/${folder}/${base}.${a.ext}`;
  await repo.transact(async () => ({ changes: [{ path, base64: a.data.toString("base64") }], message: `Add image ${path}`, result: null }) as Plan<null>);
  return path;
}

const attach = (list: Attachment[], i: number | undefined): Attachment | undefined => {
  if (i === undefined) return undefined;
  const a = list[i];
  if (!a) throw new ToolError(`The request refers to attachment ${i + 1}, but only ${list.length} image(s) were attached.`);
  return a;
};

/** Applies parsed operations to the (branch-bound) repo. One commit per operation; squashed on approve. */
export async function applyOps(repo: RepoPort, ops: Op[], attachments: Attachment[], previewBase?: (path: string) => string): Promise<Item[]> {
  const svc = new ContentService(repo);
  const lines: Item[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "upsert_person": {
        const person: Record<string, unknown> = { ...op.person };
        const a = attach(attachments, op.attachment);
        if (a) {
          const group = String(person.group ?? "");
          const folder = FOLDER[group];
          if (!folder) throw new ToolError(`Cannot place a photo for group "${group}".`);
          person.image = await putImage(repo, folder, slug(String(person.name ?? "person")), a);
          delete person.placeholder;
        }
        const r = await svc.upsertPerson(person);
        const pp = r.person;
        const detail = [pp.cohort ? `Cohort ${pp.cohort}` : "", pp.title?.en ? `${pp.title.en}${pp.title.ar ? ` · ${pp.title.ar}` : ""}` : "", pp.affiliation?.en ? `${pp.affiliation.en}${pp.affiliation.ar ? ` · ${pp.affiliation.ar}` : ""}` : "", pp.link ? `<${pp.link}|link>` : ""].filter(Boolean).join("\n");
        lines.push({ text: `${r.status === "created" ? "Add" : r.status === "updated" ? "Update" : "No change to"} ${pp.group.replace("_", " ")}: ${pp.name}`, detail: detail || undefined, image: a && previewBase ? previewBase(String(pp.image)) : undefined });
        break;
      }
      case "post_news": {
        const news: Record<string, unknown> = { ...op.news };
        const a = attach(attachments, op.attachment);
        if (a) news.logo = await putImage(repo, "news", slug(String((news.title as any)?.en ?? "news")), a);
        const r: any = await svc.postNews(news);
        lines.push({ text: `Post news: ${r.item?.title?.en ?? r.id ?? ""}`.trim() });
        break;
      }
      case "update_news": { await svc.updateNews(op.id, op.patch); lines.push({ text: `Update news ${op.id}` }); break; }
      case "set_banner": { await svc.setBanner(op.banner); lines.push({ text: "Update banner" }); break; }
      case "set_application": { const a: any = op.application; await svc.setApplication(a); lines.push({ text: `${a.target === "mentor" ? "Mentor" : "Student"} form: ${[a.open === true ? "open it" : a.open === false ? "close it" : "", a.link ? "new link" : "", a.period ? "new dates" : ""].filter(Boolean).join(", ") || "no change"}` }); break; }
      case "upsert_cohort": { await svc.upsertCohort(op.cohort); lines.push({ text: `Update cohort ${(op.cohort as any).id ?? ""}`.trim() }); break; }
      case "set_visibility": { await svc.setVisibility(op.kind, op.id, op.published); lines.push({ text: `${op.published ? "Show" : "Hide"} ${op.kind} ${op.id}` }); break; }
      case "remove_item": { await svc.removeItem(op.kind, op.id, true); lines.push({ text: `Remove ${op.kind} ${op.id}` }); break; }
      case "undo": throw new ToolError("Undo cannot be combined with other changes.");
    }
  }
  return lines;
}
