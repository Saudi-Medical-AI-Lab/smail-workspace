import type { Plan, Reader, RepoPort } from "../src/github";
import { BOT_PREFIX } from "../src/github";
import { ToolError } from "../src/guard";

export class FakeRepo implements RepoPort {
  files = new Map<string, string>();
  history: { message: string; snapshot: Map<string, string> }[] = [];
  constructor(initial: Record<string, unknown>) {
    for (const [p, v] of Object.entries(initial)) this.files.set(p, typeof v === "string" ? v : JSON.stringify(v, null, 2));
    this.history.push({ message: "initial (human commit)", snapshot: new Map(this.files) });
  }
  json(path: string) { return JSON.parse(this.files.get(path)!); }
  get commits() { return this.history.length - 1; }
  async transact<T>(build: (read: Reader) => Promise<Plan<T> | null>) {
    const plan = await build(async (p) => this.files.get(p) ?? null);
    if (!plan || plan.changes.length === 0) return { commit: null, result: plan ? plan.result : null };
    for (const c of plan.changes) {
      if ("delete" in c) this.files.delete(c.path);
      else if ("text" in c) this.files.set(c.path, c.text);
      else this.files.set(c.path, "base64:" + c.base64);
    }
    this.history.push({ message: BOT_PREFIX + plan.message, snapshot: new Map(this.files) });
    return { commit: "c" + this.history.length, result: plan.result };
  }
  async head() { const h = this.history[this.history.length - 1]; return { sha: "c" + this.history.length, message: h.message, parent: this.history.length > 1 ? "c" + (this.history.length - 1) : null }; }
  async undoHead() {
    const h = this.history[this.history.length - 1];
    if (!h.message.startsWith(BOT_PREFIX)) throw new ToolError("not made by this tool", "not_bot_commit");
    this.files = new Map(this.history[this.history.length - 2].snapshot);
    this.history.push({ message: BOT_PREFIX + "Undo: " + h.message, snapshot: new Map(this.files) });
    return { commit: "x", undone: "y", message: h.message };
  }
  async pagesStatus() { return { status: "built", commit: "c", headCommit: "c", error: null, updatedAt: null }; }
}

export const seed = () => ({
  "data/people.json": [
    { id: "ann-lee-c1", group: "mentor", cohort: 1, order: 0, published: true, name: "Ann Lee", image: "images/Female-icon.png", title: { en: "Professor" }, affiliation: { en: "KAU" } },
  ],
  "data/cohorts.json": [
    { id: 1, label: { en: "Cohort 1", ar: "الدفعة الأولى" }, status: "completed", published: true },
    { id: 3, label: { en: "Cohort 3", ar: "الدفعة الثالثة" }, status: "coming_soon", published: true },
  ],
  "data/news.json": [
    { id: "old", published: true, featured: true, order: 0, date: "2026-09", tag: "program", link: "/", external: false, title: { en: "Old", ar: "قديم" }, summary: { en: "s", ar: "ملخص" } },
  ],
  "data/site.json": { banner: { published: true, text: { en: "Hi", ar: "مرحبا" } } },
});

export const mentor = (over: Record<string, unknown> = {}) => ({
  name: "Dr. Jane Doe", group: "mentor", cohort: 3, placeholder: "female",
  title: { en: "Assistant Professor", ar: "أستاذ مساعد" }, affiliation: { en: "KSU", ar: "جامعة الملك سعود" }, ...over,
});
