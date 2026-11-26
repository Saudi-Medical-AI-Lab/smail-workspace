import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** The bot imports ../smail-mcp/src. Fail loudly at startup if the sibling folder was not deployed with it. */
export function checkSiblings(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const f of ["schema.ts", "guard.ts", "content.ts", "github.ts"]) {
    if (!existsSync(join(here, "../../smail-mcp/src", f))) {
      throw new Error(`smail-mcp/src/${f} not found next to smail-slack-bot. Deploy both folders together (deploy/deploy.sh).`);
    }
  }
  if (!existsSync(join(here, "../../smail-mcp/node_modules/zod"))) throw new Error("Run `npm ci` in smail-mcp too (deploy/deploy.sh does both).");
}
