import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ContentService } from "./content";
import { ApplicationPatch, Bilingual, BannerInput, CohortInput, NewsInput, PersonInput, COHORT_STATUSES, PERSON_GROUPS } from "./schema";
import { MAX_BULK, ToolError } from "./guard";

// Best-effort per-isolate write limiter. The real backstops are the bulk cap and git history.
const WRITE_LIMIT = 40;
const WINDOW_MS = 10 * 60 * 1000;
const writes: number[] = [];
function checkRate() {
  const now = Date.now();
  while (writes.length && now - writes[0] > WINDOW_MS) writes.shift();
  if (writes.length >= WRITE_LIMIT) throw new ToolError("Too many changes in a short time. Wait a few minutes and try again.", "rate_limited");
  writes.push(now);
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = (message: string) => ({ isError: true as const, content: [{ type: "text" as const, text: message }] });

async function run(name: string, write: boolean, fn: () => Promise<unknown>) {
  const started = Date.now();
  try {
    if (write) checkRate();
    const result = await fn();
    console.log(JSON.stringify({ tool: name, ok: true, ms: Date.now() - started }));
    return text(result);
  } catch (e) {
    const code = e instanceof ToolError ? e.code : "internal_error";
    console.log(JSON.stringify({ tool: name, ok: false, code, ms: Date.now() - started }));
    // Unexpected errors are not echoed (they could contain upstream details).
    return fail(e instanceof ToolError ? e.message : "Something went wrong on the server. Nothing was changed.");
  }
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const UPSERT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const cohortId = z.number().int().positive();
const kindEnum = z.enum(["person", "news", "cohort"]);

export function buildServer(svc: ContentService): McpServer {
  const server = new McpServer({ name: "smail-content", version: "0.1.0" });

  server.registerTool("list_content", {
    title: "List website content",
    description:
      'Read what is on the SMAIL website. kind: "people" (optionally filter by group, cohort, or name text), "cohorts", "news", "banner" or "applications" (the student and mentor forms). ' +
      "Use this first to find ids before changing or removing anything. Returns at most 200 people.",
    inputSchema: z.object({
      kind: z.enum(["people", "cohorts", "news", "banner", "applications"]),
      group: z.enum(PERSON_GROUPS).optional(),
      cohort: cohortId.optional(),
      query: z.string().max(100).optional(),
    }),
    annotations: READ,
  }, (a) => run("list_content", false, () => svc.list(a.kind, { group: a.group, cohort: a.cohort, query: a.query })));

  server.registerTool("upsert_person", {
    title: "Add or update a person",
    description:
      "Add or update one person (board, staff, staff_alumni, mentor or student). Safe to repeat: the same name and cohort updates the existing entry. " +
      "Titles and affiliations need BOTH English and Arabic. mentor and student need a cohort that already exists. mentors need title and affiliation; students need affiliation (university) and may name their mentor; " +
      'board members need title (their role). Give image (a path from upload_image) or placeholder "male" or "female". ' +
      'Example: {"name":"Dr. Jane Doe","group":"mentor","cohort":3,"title":{"en":"Assistant Professor","ar":"أستاذ مساعد"},"affiliation":{"en":"KAU","ar":"جامعة الملك عبدالعزيز"},"placeholder":"female"}. ' +
      "Use bulk_import_people for more than a few people.",
    inputSchema: PersonInput,
    annotations: UPSERT,
  }, (a) => run("upsert_person", true, () => svc.upsertPerson(a)));

  server.registerTool("bulk_import_people", {
    title: "Add or update many people",
    description:
      `Add or update up to ${MAX_BULK} people in one change (for example a whole new cohort). Each item follows the same rules as upsert_person. ` +
      "Returns a result for every item (created, updated, unchanged or failed with the reason). Valid items are saved even if others fail; fix the failed ones and send only those again. Safe to repeat.",
    inputSchema: z.object({ people: z.array(PersonInput).min(1).max(MAX_BULK) }),
    annotations: UPSERT,
  }, (a) => run("bulk_import_people", true, () => svc.bulkImportPeople(a.people)));

  server.registerTool("update_person", {
    title: "Change an existing person",
    description: "Change fields of someone already on the site (rename, move to another cohort, new title or affiliation, new link). id comes from list_content. Only the fields in patch change; the rest stays as it is. Titles and affiliations need English and Arabic.",
    inputSchema: z.object({ id: z.string(), patch: z.record(z.string(), z.unknown()) }),
    annotations: UPSERT,
  }, (a) => run("update_person", true, () => svc.updatePerson(a.id, a.patch)));

  server.registerTool("upsert_cohort", {
    title: "Add or update a cohort",
    description:
      'Create a cohort or change its label or status. status: "coming_soon" (shows "Coming soon"), "open", or "completed". ' +
      "A new cohort must exist before people can be added to it. Both English and Arabic labels are required.",
    inputSchema: CohortInput,
    annotations: UPSERT,
  }, (a) => run("upsert_cohort", true, () => svc.upsertCohort(a)));

  server.registerTool("post_news", {
    title: "Post a news item",
    description:
      "Publish a news item. It appears first on the News page and on the home page. Needs English and Arabic title and summary; body is the longer text for the News page. " +
      'date is YYYY or YYYY-MM. tag: program, publication, community or event. link is an https URL or a site path such as "/#application". ' +
      "featured: true makes it the large story at the top of the News page (only one at a time). Each call creates a new item; use update_news to edit.",
    inputSchema: NewsInput,
    annotations: CREATE,
  }, (a) => run("post_news", true, () => svc.postNews(a)));

  server.registerTool("update_news", {
    title: "Edit a news item",
    description: "Change fields of an existing news item. Get the id from list_content (kind news). Send only the fields to change.",
    inputSchema: z.object({ id: z.string().min(1), changes: NewsInput.partial() }),
    annotations: UPSERT,
  }, (a) => run("update_news", true, () => svc.updateNews(a.id, a.changes as Record<string, unknown>)));

  server.registerTool("set_banner", {
    title: "Set the announcement banner",
    description:
      "Show, change or hide the pink announcement bar at the top of the home page. published: false hides it. Needs English and Arabic text; link and linkText are optional.",
    inputSchema: BannerInput,
    annotations: UPSERT,
  }, (a) => run("set_banner", true, () => svc.setBanner(a)));

  server.registerTool("set_application", {
    title: "Open, close or change a registration form",
    description:
      "Control the Students or Mentors registration form on the home page. target: student or mentor. Any of: open (true opens the form, false closes it), link (the https form link), period (the dates, English and Arabic). Only what you give is changed. A form cannot be opened without a link.",
    inputSchema: ApplicationPatch,
    annotations: UPSERT,
  }, (a) => run("set_application", true, () => svc.setApplication(a)));

  server.registerTool("set_visibility", {
    title: "Publish or hide an item",
    description:
      "Hide an item from the website without deleting it, or show it again. kind: person, news or cohort. Use this to prepare something as a draft: add it, hide it, review it, then publish. Get ids from list_content.",
    inputSchema: z.object({ kind: kindEnum, id: z.union([z.string(), cohortId]), published: z.boolean() }),
    annotations: UPSERT,
  }, (a) => run("set_visibility", true, () => svc.setVisibility(a.kind, a.id, a.published)));

  server.registerTool("remove_item", {
    title: "Delete an item",
    description:
      "Permanently remove a person, news item or empty cohort. Without confirm: true it only shows what would be removed and changes nothing. " +
      "Prefer set_visibility to hide. Removal can be reversed with undo_last_change right after.",
    inputSchema: z.object({ kind: kindEnum, id: z.union([z.string(), cohortId]), confirm: z.boolean().default(false) }),
    annotations: DESTRUCTIVE,
  }, (a) => run("remove_item", a.confirm, () => svc.removeItem(a.kind, a.id, a.confirm)));

  server.registerTool("upload_image", {
    title: "Upload an image from a URL",
    description:
      "Download a PNG, JPEG or WebP (max 5 MB, https only) and save it under images/<folder>/<filename>. Then pass the returned path as image in upsert_person or post_news. " +
      "It does not resize; use images already sized for the web (about 600 px for profile photos). Existing files are not overwritten unless overwrite is true.",
    inputSchema: z.object({
      url: z.string().url(),
      folder: z.enum(["mentors", "staff", "students", "board", "news", "partners"]),
      filename: z.string().min(5).max(80),
      overwrite: z.boolean().default(false),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (a) => run("upload_image", true, () => svc.uploadImage(a.url, a.folder, a.filename, a.overwrite)));

  server.registerTool("get_deploy_status", {
    title: "Check whether the site is live",
    description: "After a change, check whether GitHub Pages has published the latest commit, is still building, or failed.",
    inputSchema: z.object({}),
    annotations: { ...READ, openWorldHint: true },
  }, () => run("get_deploy_status", false, () => svc.deployStatus()));

  server.registerTool("undo_last_change", {
    title: "Undo the last change",
    description:
      "Reverse the most recent change made by this tool. Without confirm: true it only shows what would be undone. Refuses if the latest commit on the site was not made by this tool.",
    inputSchema: z.object({ confirm: z.boolean().default(false) }),
    annotations: DESTRUCTIVE,
  }, (a) => run("undo_last_change", a.confirm, () => svc.undo(a.confirm)));

  return server;
}

export { Bilingual, COHORT_STATUSES };
