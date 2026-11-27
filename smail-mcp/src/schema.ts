import { z } from "zod";

// New and edited entries must carry both languages. Existing legacy entries may lack `ar`.
export const Bilingual = z.object({
  en: z.string({ error: "English text is required" }).trim().min(1, "English text is required"),
  ar: z.string({ error: "Arabic text is required" }).trim().min(1, "Arabic text is required"),
});
export type Bilingual = z.infer<typeof Bilingual>;

export const PERSON_GROUPS = ["board", "staff", "staff_alumni", "mentor", "student"] as const;
export const NEWS_TAGS = ["program", "publication", "community", "event"] as const;
export const COHORT_STATUSES = ["completed", "open", "coming_soon"] as const;

const imagePath = z
  .string()
  .regex(/^images\/[A-Za-z0-9._\-\/ ]+\.(png|jpe?g|webp|svg)$/i, "image must be a path under images/");
const httpsUrl = z.string().url().refine((u) => u.startsWith("https://"), "link must start with https://");
const linkOrRoute = z
  .string()
  .refine((u) => u === "" || u.startsWith("https://") || /^(\/|#|[a-z0-9\-]+\.html)/i.test(u), "invalid link");

export const PersonInput = z.object({
  name: z.string().trim().min(2).max(120),
  group: z.enum(PERSON_GROUPS),
  cohort: z.number().int().positive().nullable().optional(),
  title: Bilingual.optional(),
  affiliation: Bilingual.optional(),
  image: imagePath.optional(),
  placeholder: z.enum(["male", "female"]).optional(),
  link: httpsUrl.optional(),
  mentor: z.string().trim().max(120).optional(),
  region: z.string().regex(/^SA\d{2}$/, "region must be an ISO code like SA01").nullable().optional(),
  published: z.boolean().optional(),
});
export type PersonInput = z.infer<typeof PersonInput>;

export const CohortInput = z.object({
  id: z.number().int().positive(),
  label: Bilingual,
  status: z.enum(COHORT_STATUSES),
});

export const NewsInput = z.object({
  title: Bilingual,
  summary: Bilingual,
  body: Bilingual.optional(),
  date: z.string().regex(/^\d{4}(-\d{2})?$/, "date must be YYYY or YYYY-MM"),
  tag: z.enum(NEWS_TAGS),
  link: linkOrRoute,
  external: z.boolean().optional(),
  featured: z.boolean().optional(),
  logo: imagePath.optional(),
  published: z.boolean().optional(),
});
export type NewsInput = z.infer<typeof NewsInput>;

export const BannerInput = z.object({
  published: z.boolean(),
  text: Bilingual,
  link: linkOrRoute.optional(),
  linkText: Bilingual.optional(),
});

// The two application forms on the home page. Only what is given is changed; the rest stays as it was.
export const APPLICATION_TARGETS = ["student", "mentor"] as const;
export const ApplicationPatch = z.object({
  target: z.enum(APPLICATION_TARGETS),
  open: z.boolean().optional(),
  link: httpsUrl.optional(),
  period: Bilingual.optional(), // the dates, for example "From August 16 to September 15, 2026" and its Arabic
});
export type ApplicationPatch = z.infer<typeof ApplicationPatch>;

export const slug = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export type Person = PersonInput & {
  id: string;
  cohort: number | null;
  order: number;
  published: boolean;
};
