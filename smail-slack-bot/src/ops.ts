import { z } from "zod";

// What the model may ask for. Payloads are validated again, field by field, by the
// smail-mcp ContentService (PersonInput, NewsInput, ...), so this layer stays loose on purpose.
const payload = z.record(z.string(), z.unknown());
const kind = z.enum(["person", "news", "cohort"]);

export const Op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("upsert_person"), person: payload, attachment: z.number().int().min(0).optional() }),
  z.object({ op: z.literal("post_news"), news: payload, attachment: z.number().int().min(0).optional() }),
  z.object({ op: z.literal("update_news"), id: z.string(), patch: payload }),
  z.object({ op: z.literal("set_banner"), banner: payload }),
  z.object({ op: z.literal("upsert_cohort"), cohort: payload }),
  z.object({ op: z.literal("set_visibility"), kind, id: z.union([z.string(), z.number()]), published: z.boolean() }),
  z.object({ op: z.literal("remove_item"), kind, id: z.union([z.string(), z.number()]) }),
  z.object({ op: z.literal("undo") }),
]);
export type Op = z.infer<typeof Op>;

export const ParseResult = z.object({
  ops: z.array(Op).max(20),
  // Set instead of ops when the request is ambiguous or not a site edit.
  question: z.string().max(400).optional(),
  // True when the message is not a site request at all (chat, thanks, discussion). The bot stays silent.
  ignore: z.boolean().optional(),
});
export type ParseResult = z.infer<typeof ParseResult>;

// JSON Schema handed to `claude --json-schema` (kept simple; Zod above is the real gate).
export const PARSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          op: { enum: ["upsert_person", "post_news", "update_news", "set_banner", "upsert_cohort", "set_visibility", "remove_item", "undo"] },
          person: { type: "object" },
          news: { type: "object" },
          patch: { type: "object" },
          banner: { type: "object" },
          cohort: { type: "object" },
          kind: { enum: ["person", "news", "cohort"] },
          id: { type: ["string", "number"] },
          published: { type: "boolean" },
          attachment: { type: "integer", minimum: 0 },
        },
        required: ["op"],
      },
    },
    question: { type: "string" },
    ignore: { type: "boolean" },
  },
  required: ["ops"],
} as const;
