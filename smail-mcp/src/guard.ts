// Server-side safety checks. Tool descriptions are suggestions; these are enforced.

export class ToolError extends Error {
  constructor(message: string, public code = "invalid_input") {
    super(message);
  }
}

// The site repo is public, so anything written is world-readable. Refuse anything that looks like a secret.
const SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /sk-[A-Za-z0-9]{32,}/,
];

export function assertNoSecrets(value: unknown): void {
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (SECRET_PATTERNS.some((p) => p.test(v))) {
        throw new ToolError("Content looks like it contains a secret or token and was not saved.", "secret_detected");
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
}

export const MAX_BULK = 100;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Only these data files can be written. Tool arguments never choose a path.
export const DATA_FILES = {
  people: "data/people.json",
  cohorts: "data/cohorts.json",
  news: "data/news.json",
  site: "data/site.json",
} as const;

export const IMAGE_FOLDERS = ["mentors", "staff", "students", "board", "news", "partners"] as const;

export function assertSafeImageUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ToolError("image url is not a valid URL");
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:") throw new ToolError("image url must use https");
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    /^(10|127)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "0.0.0.0" ||
    host.startsWith("[")
  ) {
    throw new ToolError("image url points to a private or local address");
  }
  return u;
}

export function safeFilename(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/\.(png|jpe?g|webp)$/.test(base)) throw new ToolError("filename must end in .png, .jpg, .jpeg or .webp");
  if (base.length > 80) throw new ToolError("filename is too long");
  return base;
}
