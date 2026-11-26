// All settings come from the environment. Missing required values fail fast at startup.
const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var ${k}`);
  return v;
};
const list = (k: string) => (process.env[k] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function loadConfig() {
  if (process.env.ANTHROPIC_API_KEY) {
    // An API key would silently switch billing away from the subscription.
    throw new Error("ANTHROPIC_API_KEY is set. Unset it: this bot is meant to run on the Claude subscription token.");
  }
  return {
    slackBotToken: need("SLACK_BOT_TOKEN"),
    slackSigningSecret: need("SLACK_SIGNING_SECRET"),
    channelId: need("SLACK_CHANNEL_ID"),
    requesters: list("REQUESTER_USER_IDS"), // may start jobs
    approvers: list("APPROVER_USER_IDS"), // may Approve / Decline / undo
    githubOwner: need("GITHUB_OWNER"),
    githubRepo: need("GITHUB_REPO"),
    githubBranch: process.env.GITHUB_BRANCH ?? "main",
    githubToken: need("GITHUB_TOKEN"),
    authorName: process.env.COMMIT_AUTHOR_NAME,
    authorEmail: process.env.COMMIT_AUTHOR_EMAIL,
    previewRoot: process.env.PREVIEW_ROOT ?? "/var/www/previews",
    previewBaseUrl: need("PREVIEW_BASE_URL").replace(/\/$/, ""),
    dbPath: process.env.DB_PATH ?? "./data/bot.db",
    port: Number(process.env.PORT ?? 3000),
    claudeBin: process.env.CLAUDE_BIN ?? "claude",
    claudeTimeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS ?? 120_000),
    siteUrl: process.env.SITE_URL ?? "https://smail.org.sa",
    dryRun: process.env.DRY_RUN === "1", // build previews but never merge
    deployPollMs: Number(process.env.DEPLOY_POLL_MS ?? 20_000), // how often to check that GitHub Pages has the change
  };
}
export type Config = ReturnType<typeof loadConfig>;
