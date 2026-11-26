import sharp from "sharp";
import { MAX_IMAGE_BYTES, ToolError } from "../../smail-mcp/src/guard";

const MAX_DIM = 800;

/** Accepts PNG/JPEG/WebP by magic bytes only, strips metadata, caps size, re-encodes. */
export async function normalizeImage(buf: Buffer, format: "jpeg" | "png" = "jpeg"): Promise<{ data: Buffer; ext: "jpg" | "png" }> {
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES * 2) throw new ToolError("The image is empty or too large (max about 10 MB).");
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isWebp = buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP";
  if (!(isPng || isJpg || isWebp)) throw new ToolError("Only PNG, JPEG or WebP images are accepted.");
  const img = sharp(buf, { limitInputPixels: 50_000_000 }).rotate().resize(MAX_DIM, MAX_DIM, { fit: "inside", withoutEnlargement: true });
  const data = format === "png" ? await img.png({ compressionLevel: 9 }).toBuffer() : await img.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  if (data.length > MAX_IMAGE_BYTES) throw new ToolError("The image is still over 5 MB after resizing.");
  return { data, ext: format === "png" ? "png" : "jpg" };
}

/** Slack private file URLs need the bot token, and the token may only go to Slack hosts. */
export async function downloadSlackFile(url: string, botToken: string): Promise<Buffer> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !(u.hostname === "files.slack.com" || u.hostname.endsWith(".slack.com"))) {
    throw new ToolError("Refusing to send the Slack token to a non-Slack host.");
  }
  const res = await fetch(u, { headers: { Authorization: `Bearer ${botToken}` }, redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new ToolError(`Could not download the attachment from Slack (HTTP ${res.status}).`);
  if (res.headers.get("content-type")?.includes("text/html")) throw new ToolError("Slack returned a login page; check the files:read scope and that the bot is in the channel.");
  return Buffer.from(await res.arrayBuffer());
}
