import { createMcpHandler } from "agents/mcp";
import { ContentService } from "./content";
import { GitHubRepo } from "./github";
import { buildServer } from "./tools";

export interface Env {
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  ALLOWED_ORIGIN: string; // comma-separated; empty means no Origin restriction
  GITHUB_TOKEN: string; // secret: fine-grained token, one repo, Contents read/write (+ Pages read)
  MCP_ACCESS_TOKEN: string; // secret: shared bearer token for callers
  COMMIT_AUTHOR_NAME?: string;
  COMMIT_AUTHOR_EMAIL?: string;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json(200, { ok: true });
    if (url.pathname !== "/mcp") return json(404, { error: "not_found" });

    // Guard against DNS rebinding: reject unexpected browser origins.
    const origin = request.headers.get("Origin");
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (origin && allowed.length && !allowed.includes(origin)) return json(403, { error: "origin_not_allowed" });

    // Fail closed if the server was deployed without its secrets.
    if (!env.MCP_ACCESS_TOKEN || !env.GITHUB_TOKEN) return json(500, { error: "server_not_configured" });
    const auth = request.headers.get("Authorization") || "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!presented || !safeEqual(presented, env.MCP_ACCESS_TOKEN)) {
      return json(401, { error: "unauthorized" }, { "WWW-Authenticate": 'Bearer realm="smail-mcp"' });
    }

    const repo = new GitHubRepo({
      owner: env.GITHUB_OWNER,
      repo: env.GITHUB_REPO,
      branch: env.GITHUB_BRANCH,
      token: env.GITHUB_TOKEN,
      authorName: env.COMMIT_AUTHOR_NAME,
      authorEmail: env.COMMIT_AUTHOR_EMAIL,
    });
    const handler = createMcpHandler(() => buildServer(new ContentService(repo)));
    return handler(request, env, ctx);
  },
};
