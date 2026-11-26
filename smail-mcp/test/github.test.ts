import { describe, expect, it } from "vitest";
import { GitHubRepo } from "../src/github";

type Call = { method: string; path: string; body?: any };
function mockGitHub(opts: { failRefUpdates?: number; headMessage?: string } = {}) {
  const calls: Call[] = [];
  let refFails = opts.failRefUpdates ?? 0;
  let counter = 0;
  const doFetch = async (url: string, init: RequestInit = {}) => {
    const path = url.replace("https://api.github.com/repos/o/r", "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (path.startsWith("/git/ref/heads/")) return ok({ object: { sha: "head" + counter } });
    if (path.startsWith("/git/commits/") && method === "GET")
      return ok({ message: opts.headMessage ?? "[smail-mcp] Add x", tree: { sha: "tree-of-" + path.split("/").pop() }, parents: [{ sha: "parent1" }] });
    if (path.startsWith("/contents/")) return new Response('[{"id":1}]', { status: 200 });
    if (path === "/git/blobs") return ok({ sha: "blob1" });
    if (path === "/git/trees") return ok({ sha: "newtree" });
    if (path === "/git/commits") return ok({ sha: "newcommit" });
    if (path.startsWith("/git/refs/heads/") && method === "PATCH") {
      if (refFails > 0) { refFails--; counter++; return new Response("{}", { status: 422 }); }
      return ok({});
    }
    return new Response("{}", { status: 404 });
  };
  const repo = new GitHubRepo({ owner: "o", repo: "r", branch: "main", token: "SECRET-TOKEN-123" }, doFetch);
  return { repo, calls };
}

describe("GitHubRepo.transact", () => {
  it("commits with base_tree, the head as parent, a bot prefix, and a non-forced ref update", async () => {
    const { repo, calls } = mockGitHub();
    const r = await repo.transact(async (read) => {
      expect(await read("data/people.json")).toBe('[{"id":1}]');
      return { changes: [{ path: "data/people.json", text: "[]" }], message: "Add x", result: 1 };
    });
    expect(r.commit).toBe("newcommit");
    const tree = calls.find((c) => c.path === "/git/trees")!.body;
    expect(tree.base_tree).toBe("tree-of-head0"); expect(tree.tree[0]).toMatchObject({ path: "data/people.json", mode: "100644", content: "[]" });
    const commit = calls.find((c) => c.path === "/git/commits" && c.method === "POST")!.body;
    expect(commit.message).toBe("[smail-mcp] Add x"); expect(commit.parents).toEqual(["head0"]);
    expect(JSON.stringify(commit)).not.toMatch(/co-authored/i);
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ sha: "newcommit", force: false });
  });
  it("uploads binary files as blobs", async () => {
    const { repo, calls } = mockGitHub();
    await repo.transact(async () => ({ changes: [{ path: "images/a.png", base64: "AAAA" }], message: "img", result: 0 }));
    expect(calls.find((c) => c.path === "/git/blobs")!.body).toEqual({ content: "AAAA", encoding: "base64" });
    expect(calls.find((c) => c.path === "/git/trees")!.body.tree[0].sha).toBe("blob1");
  });
  it("retries from a fresh head when the branch moved, then succeeds", async () => {
    const { repo, calls } = mockGitHub({ failRefUpdates: 1 });
    const r = await repo.transact(async () => ({ changes: [{ path: "a.json", text: "1" }], message: "m", result: 0 }));
    expect(r.commit).toBe("newcommit");
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
    expect(calls.filter((c) => c.path.startsWith("/git/ref/heads/")).length).toBeGreaterThanOrEqual(2);
  });
  it("gives up with a clear message after repeated conflicts", async () => {
    const { repo } = mockGitHub({ failRefUpdates: 5 });
    await expect(repo.transact(async () => ({ changes: [{ path: "a", text: "1" }], message: "m", result: 0 }))).rejects.toThrow(/Nothing was written/);
  });
  it("writes nothing when the plan is empty", async () => {
    const { repo, calls } = mockGitHub();
    const r = await repo.transact(async () => ({ changes: [], message: "", result: "same" }));
    expect(r).toEqual({ commit: null, result: "same" }); expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
  it("never leaks the token in errors", async () => {
    const repo = new GitHubRepo({ owner: "o", repo: "r", branch: "main", token: "SECRET-TOKEN-123" }, async () => new Response("bad SECRET-TOKEN-123", { status: 500 }));
    await expect(repo.head()).rejects.toThrow(/HTTP 500/);
    await repo.head().catch((e) => expect(String(e.message)).not.toContain("SECRET-TOKEN-123"));
  });
});

describe("GitHubRepo.undoHead", () => {
  it("restores the parent's tree in a new commit on top of head", async () => {
    const { repo, calls } = mockGitHub();
    const r = await repo.undoHead();
    expect(r.commit).toBe("newcommit");
    const body = calls.find((c) => c.path === "/git/commits" && c.method === "POST")!.body;
    expect(body.tree).toBe("tree-of-parent1"); expect(body.parents).toEqual(["head0"]); expect(body.message).toBe("[smail-mcp] Undo: Add x");
  });
  it("refuses to undo a commit this tool did not make", async () => {
    const { repo } = mockGitHub({ headMessage: "Fix typo (by a human)" });
    await expect(repo.undoHead()).rejects.toThrow(/not made by this tool/);
  });
});
