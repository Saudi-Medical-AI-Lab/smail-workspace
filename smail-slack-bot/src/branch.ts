import { ToolError } from "../../smail-mcp/src/guard";
import { BOT_PREFIX } from "../../smail-mcp/src/github";

export interface AdminConfig { owner: string; repo: string; token: string; base: string }

/** Branch, pull request and tarball operations. Content commits go through smail-mcp's GitHubRepo. */
export class GitHubAdmin {
  constructor(private cfg: AdminConfig, private doFetch: typeof fetch = (u, i) => fetch(u, i)) {}
  private url(p: string) { return `https://api.github.com/repos/${this.cfg.owner}/${this.cfg.repo}${p}`; }
  private api(p: string, init: RequestInit = {}) {
    return this.doFetch(this.url(p), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "smail-slack-bot",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  }
  private async ok<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) throw new ToolError(`GitHub ${what} failed (HTTP ${res.status}).`, `github_${res.status}`);
    return (await res.json()) as T;
  }

  async createBranch(name: string): Promise<void> {
    const base = await this.ok<{ object: { sha: string } }>(await this.api(`/git/ref/heads/${this.cfg.base}`), "read base branch");
    await this.ok(await this.api("/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${name}`, sha: base.object.sha }) }), "create branch");
  }
  async deleteBranch(name: string): Promise<void> {
    const res = await this.api(`/git/refs/heads/${name}`, { method: "DELETE" });
    if (!res.ok && res.status !== 422 && res.status !== 404) throw new ToolError(`GitHub delete branch failed (HTTP ${res.status}).`);
  }
  /** Paths changed on the branch relative to base. Used to enforce the write allow-list. */
  async changedFiles(branch: string): Promise<string[]> {
    const c = await this.ok<{ files?: { filename: string; previous_filename?: string }[] }>(
      await this.api(`/compare/${this.cfg.base}...${branch}?per_page=100`), "compare");
    return (c.files ?? []).flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]);
  }
  async openPr(branch: string, title: string, body: string): Promise<number> {
    const pr = await this.ok<{ number: number }>(await this.api("/pulls", { method: "POST", body: JSON.stringify({ title: BOT_PREFIX + title, head: branch, base: this.cfg.base, body }) }), "open pull request");
    return pr.number;
  }
  /** Close a declined or expired pull request, then archive it so it is hidden from the public list and from
   *  the contribution count of whoever owns the token. Archiving is best effort and can be undone on GitHub. */
  async closePr(n: number): Promise<void> {
    const res = await this.api(`/pulls/${n}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
    try {
      const nodeId = ((await res.json()) as { node_id?: string }).node_id;
      if (nodeId) {
        await this.doFetch("https://api.github.com/graphql", {
          method: "POST",
          headers: { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json", "user-agent": "smail-slack-bot" },
          body: JSON.stringify({ query: "mutation($id:ID!){ archivePullRequest(input:{pullRequestId:$id}){ pullRequest{ number } } }", variables: { id: nodeId } }),
        });
      }
    } catch { /* not allowed or not available: the pull request simply stays closed */ }
  }
  /** Squash-merge. The commit title keeps the bot prefix so `undo` still works on it. */
  async mergePr(n: number, title: string): Promise<string> {
    const res = await this.api(`/pulls/${n}/merge`, { method: "PUT", body: JSON.stringify({ merge_method: "squash", commit_title: BOT_PREFIX + title }) });
    if (res.status === 405 || res.status === 409) throw new ToolError("The website changed while this was waiting, so it no longer fits. Please send the request again.", "conflict");
    return (await this.ok<{ sha: string }>(res, "merge pull request")).sha;
  }
  /** Tarball of a ref (follows GitHub's redirect). */
  async tarball(ref: string): Promise<Buffer> {
    const res = await this.api(`/tarball/${ref}`, { redirect: "follow" });
    if (!res.ok) throw new ToolError(`GitHub tarball failed (HTTP ${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }
}

export const WRITABLE = /^(staff\.html|llms\.txt|data\/(people|cohorts|news|site)\.json|images\/(mentors|staff|students|board|news|partners)\/[A-Za-z0-9._\- ]+)$/;
export function assertAllowedPaths(files: string[]): void {
  const bad = files.filter((f) => !WRITABLE.test(f));
  if (bad.length) throw new ToolError(`That change would touch parts of the website I'm not allowed to edit, so I stopped (${bad.slice(0, 3).join(", ")}).`, "path_not_allowed");
}
