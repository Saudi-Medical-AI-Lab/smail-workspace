import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const newSlug = () => randomBytes(12).toString("hex"); // 96 bits: unguessable

function tarExtract(buf: Buffer, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // GitHub tarballs have one top-level folder; strip it. Absolute paths and .. are refused by tar.
    const t = spawn("tar", ["-xzf", "-", "--strip-components=1", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    t.stderr.on("data", (d) => (err += d));
    t.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`tar failed: ${err.slice(0, 200)}`))));
    t.stdin.end(buf);
  });
}

/** The site uses root-absolute links ("/", "/#about"). Under /<slug>/ they would leave the preview, so rebase them. */
export function rebase(file: string, content: string, slug: string): string {
  const base = `/${slug}/`;
  if (file.endsWith(".html")) return content.replace(/\b(href|src|action)="\/(?!\/)/g, `$1="${base}`);
  if (file.endsWith(".json")) return content.replace(/("link"\s*:\s*")\/(?!\/)/g, `$1${base}`);
  if (file.endsWith("navbarScript.js")) return content.replaceAll("location.href = '/'", `location.href = '${base}'`).replaceAll("'/index.html'", `'${base}index.html'`).replace("pathname === '/'", `pathname === '${base}'`);
  return content;
}
async function rebaseTree(dir: string, slug: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { await rebaseTree(p, slug); continue; }
    if (!/\.(html|json|js)$/.test(e.name)) continue;
    const text = await readFile(p, "utf8");
    const next = rebase(e.name, text, slug);
    if (next !== text) await writeFile(p, next);
  }
}

export async function publishPreview(root: string, slug: string, tarball: Buffer): Promise<void> {
  const dir = join(root, slug);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await tarExtract(tarball, dir);
  await rebaseTree(dir, slug); // preview copy only: never committed
  await writeFile(join(dir, "robots.txt"), "User-agent: *\nDisallow: /\n");
}
export async function removePreview(root: string, slug: string): Promise<void> {
  if (!/^[0-9a-f]{24}$/.test(slug)) return; // never delete anything but our own slugs
  await rm(join(root, slug), { recursive: true, force: true });
}
