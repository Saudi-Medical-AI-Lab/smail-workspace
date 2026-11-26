import { ToolError } from "./guard";

export const BOT_PREFIX = "[smail-mcp] ";

export type Change =
  | { path: string; text: string }
  | { path: string; base64: string }
  | { path: string; delete: true };

export interface Plan<T> {
  changes: Change[];
  message: string;
  result: T;
}

export type Reader = (path: string) => Promise<string | null>;

export interface RepoPort {
  /** Read files at the current head, build a plan, and commit it atomically. Retries if the branch moved. */
  transact<T>(build: (read: Reader) => Promise<Plan<T> | null>): Promise<{ commit: string | null; result: T | null }>;
  head(): Promise<{ sha: string; message: string; parent: string | null }>;
  undoHead(): Promise<{ commit: string; undone: string; message: string }>;
  pagesStatus(): Promise<{ status: string; commit: string | null; headCommit: string; error: string | null; updatedAt: string | null }>;
}

export interface RepoConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  authorName?: string;
  authorEmail?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class GitHubRepo implements RepoPort {
  constructor(private cfg: RepoConfig, private doFetch: FetchLike = (u, i) => fetch(u, i)) {}

  private base() {
    return `https://api.github.com/repos/${this.cfg.owner}/${this.cfg.repo}`;
  }

  private async api(path: string, init: RequestInit = {}, accept = "application/vnd.github+json"): Promise<Response> {
    return this.doFetch(this.base() + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "smail-mcp",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  }

  private async json<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) {
      // Never echo the token or raw upstream bodies back to the model.
      throw new ToolError(`GitHub ${what} failed (HTTP ${res.status}).`, `github_${res.status}`);
    }
    return (await res.json()) as T;
  }

  async head() {
    const ref = await this.json<{ object: { sha: string } }>(await this.api(`/git/ref/heads/${this.cfg.branch}`), "get ref");
    const c = await this.json<{ message: string; parents: { sha: string }[] }>(
      await this.api(`/git/commits/${ref.object.sha}`),
      "get commit",
    );
    return { sha: ref.object.sha, message: c.message, parent: c.parents[0]?.sha ?? null };
  }

  private identity() {
    return this.cfg.authorName && this.cfg.authorEmail
      ? { author: { name: this.cfg.authorName, email: this.cfg.authorEmail }, committer: { name: this.cfg.authorName, email: this.cfg.authorEmail } }
      : {};
  }

  async transact<T>(build: (read: Reader) => Promise<Plan<T> | null>) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const headSha = (await this.head()).sha;
      const read: Reader = async (path) => {
        const res = await this.api(`/contents/${path}?ref=${headSha}`, {}, "application/vnd.github.raw+json");
        if (res.status === 404) return null;
        if (!res.ok) throw new ToolError(`GitHub read of ${path} failed (HTTP ${res.status}).`, `github_${res.status}`);
        return res.text();
      };
      const plan = await build(read);
      if (!plan || plan.changes.length === 0) return { commit: null, result: plan ? plan.result : null };

      const baseCommit = await this.json<{ tree: { sha: string } }>(await this.api(`/git/commits/${headSha}`), "get commit");
      const entries: unknown[] = [];
      for (const ch of plan.changes) {
        if ("delete" in ch) entries.push({ path: ch.path, mode: "100644", type: "blob", sha: null });
        else if ("base64" in ch) {
          const blob = await this.json<{ sha: string }>(
            await this.api("/git/blobs", { method: "POST", body: JSON.stringify({ content: ch.base64, encoding: "base64" }) }),
            "create blob",
          );
          entries.push({ path: ch.path, mode: "100644", type: "blob", sha: blob.sha });
        } else entries.push({ path: ch.path, mode: "100644", type: "blob", content: ch.text });
      }
      const tree = await this.json<{ sha: string }>(
        await this.api("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: entries }) }),
        "create tree",
      );
      const commit = await this.json<{ sha: string }>(
        await this.api("/git/commits", {
          method: "POST",
          body: JSON.stringify({ message: BOT_PREFIX + plan.message, tree: tree.sha, parents: [headSha], ...this.identity() }),
        }),
        "create commit",
      );
      const upd = await this.api(`/git/refs/heads/${this.cfg.branch}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
      if (upd.ok) return { commit: commit.sha, result: plan.result };
      if (upd.status === 409 || upd.status === 422) continue; // branch moved: re-read and rebuild
      throw new ToolError(`GitHub update ref failed (HTTP ${upd.status}).`, `github_${upd.status}`);
    }
    throw new ToolError("The site changed while saving. Nothing was written; please try again.", "conflict");
  }

  async undoHead() {
    const head = await this.head();
    if (!head.message.startsWith(BOT_PREFIX)) {
      throw new ToolError("The latest commit was not made by this tool, so it will not be undone automatically.", "not_bot_commit");
    }
    if (!head.parent) throw new ToolError("There is nothing to undo.", "nothing_to_undo");
    const parent = await this.json<{ tree: { sha: string } }>(await this.api(`/git/commits/${head.parent}`), "get parent");
    const original = head.message.slice(BOT_PREFIX.length).split("\n")[0];
    const message = `${BOT_PREFIX}Undo: ${original}`;
    const commit = await this.json<{ sha: string }>(
      await this.api("/git/commits", {
        method: "POST",
        body: JSON.stringify({ message, tree: parent.tree.sha, parents: [head.sha], ...this.identity() }),
      }),
      "create commit",
    );
    const upd = await this.api(`/git/refs/heads/${this.cfg.branch}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
    if (!upd.ok) throw new ToolError(`GitHub update ref failed (HTTP ${upd.status}).`, "conflict");
    return { commit: commit.sha, undone: head.sha, message: original };
  }

  async pagesStatus() {
    const head = await this.head();
    const res = await this.api("/pages/builds/latest");
    if (res.status === 404) throw new ToolError("GitHub Pages is not enabled for this repository, or the token cannot read it.", "pages_unavailable");
    const b = await this.json<{ status: string; commit: string; error?: { message?: string | null }; updated_at?: string }>(res, "get pages build");
    return {
      status: b.status,
      commit: b.commit ?? null,
      headCommit: head.sha,
      error: b.error?.message ?? null,
      updatedAt: b.updated_at ?? null,
    };
  }
}
