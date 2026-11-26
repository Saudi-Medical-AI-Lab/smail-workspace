// Keeps the few hand-written spots that mirror data/people.json in sync:
//  - the schema.org Person entries in staff.html (one per staff / alumni member)
//  - the "N+ mentors, N+ students" line in llms.txt
// Existing JSON-LD entries are left exactly as they are, except that their name follows the data.
import type { Plan, RepoPort } from "../../smail-mcp/src/github";

type P = { id: string; name: string; group: string; published?: boolean; title?: { en?: string }; link?: string };
const LD = /(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/;
const PREFIX = "https://smail.org.sa/staff.html#";

export function syncStaffJsonLd(html: string, people: P[]): string {
  const m = html.match(LD);
  if (!m) return html;
  const doc = JSON.parse(m[2]);
  const graph: any[] = doc["@graph"];
  const want = people.filter((p) => p.published !== false && (p.group === "staff" || p.group === "staff_alumni"));
  const wantIds = new Set(want.map((p) => p.id));
  const before = JSON.stringify(graph);

  const kept = graph.filter((g) => !(typeof g["@id"] === "string" && g["@id"].startsWith(PREFIX) && !wantIds.has(g["@id"].slice(PREFIX.length))));
  for (const p of want) {
    const existing = kept.find((g) => g["@id"] === PREFIX + p.id);
    if (existing) { existing.name = p.name; continue; }
    kept.push({
      "@type": "Person",
      "@id": PREFIX + p.id,
      name: p.name,
      ...(p.title?.en && { jobTitle: p.title.en }),
      worksFor: { "@id": "https://smail.org.sa/#organization" },
      ...(p.link && { sameAs: [p.link] }),
    });
  }
  if (JSON.stringify(kept) === before) return html; // nothing to change: keep the original formatting
  doc["@graph"] = kept;
  const body = JSON.stringify(doc, null, 2).split("\n").map((l) => "    " + l).join("\n");
  return html.replace(LD, `$1\n${body}\n    $3`);
}

export function syncLlmsStats(text: string, people: P[]): string {
  const n = (g: string) => people.filter((p) => p.published !== false && p.group === g).length;
  return text.replace(/Current program stats: \d+\+ mentors, \d+\+ students/, `Current program stats: ${n("mentor")}+ mentors, ${n("student")}+ students`);
}

/** One extra commit on the branch when the mirrors are out of date. */
export async function syncSiteFiles(repo: RepoPort): Promise<boolean> {
  const r = await repo.transact(async (read) => {
    const people: P[] = JSON.parse((await read("data/people.json")) ?? "[]");
    const changes: Plan<null>["changes"] = [];
    const staff = await read("staff.html");
    if (staff !== null) { const next = syncStaffJsonLd(staff, people); if (next !== staff) changes.push({ path: "staff.html", text: next }); }
    const llms = await read("llms.txt");
    if (llms !== null) { const next = syncLlmsStats(llms, people); if (next !== llms) changes.push({ path: "llms.txt", text: next }); }
    return { changes, message: "Sync staff JSON-LD and site stats", result: null } as Plan<null>;
  });
  return r.commit !== null;
}
