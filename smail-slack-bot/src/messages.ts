// All Slack wording and layout lives here, so the look can be tuned in one place.
// Every message has a plain `text` (used for notifications and screen readers) plus Block Kit blocks.
// Style rule: short sentences, everyday words, say what happened and what to do next.
export type Item = { text: string; detail?: string; image?: string };
export type Msg = { text: string; blocks: any[] };

const md = (text: string) => ({ type: "mrkdwn", text: text.slice(0, 2900) });
const section = (text: string, accessory?: any) => ({ type: "section", text: md(text), ...(accessory ? { accessory } : {}) });
const context = (...parts: string[]) => ({ type: "context", elements: parts.map(md) });
const msg = (text: string, ...blocks: any[]): Msg => ({ text, blocks });
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const bullets = (items: Item[]) => items.map((i) => `• ${esc(i.text)}`).join("\n");

export const working = (stage = "Got it. Working on it…"): Msg => msg(stage, context(`:hourglass_flowing_sand: ${stage}`));

export const help = (): Msg =>
  msg("Hi, I'm SML Bot",
    { type: "header", text: { type: "plain_text", text: "Hi, I'm SML Bot" } },
    section("I keep the SMAIL website up to date. Tell me what to change. If you're adding a person, attach their photo. English or Arabic is fine.\n\n" +
      "• `add Sara Ali, mentor, cohort 3, Associate Professor at KFSH`\n" +
      "• `hide Ann Lee` or `remove Ann Lee`\n" +
      "• `change Tala Jad's name to Tala Alharbi`\n" +
      "• `post news: Cohort 3 applications are open` (add the link)\n" +
      "• `set banner: Applications close May 1`\n" +
      "• `undo` takes back the last change"),
    context("I always show you a preview first. Nothing goes live until someone clicks *Approve*."));

export function review(job: { id: string; requester: string }, items: Item[], previewUrl: string, opts: { dryRun?: boolean; hours?: number } = {}): Msg {
  const title = items.length > 1 ? `Please check these ${items.length} changes` : "Please check this change";
  const blocks: any[] = [{ type: "header", text: { type: "plain_text", text: title } }];
  for (const it of items.slice(0, 10)) {
    blocks.push(section(`*${esc(it.text)}*${it.detail ? `\n${it.detail}` : ""}`, it.image ? { type: "image", image_url: it.image, alt_text: it.text } : undefined));
  }
  if (items.length > 10) blocks.push(context(`…and ${items.length - 10} more`));
  blocks.push(
    { type: "divider" },
    { type: "actions", block_id: `job:${job.id}`, elements: [
      { type: "button", action_id: "open_preview", text: { type: "plain_text", text: "See preview" }, url: previewUrl },
      { type: "button", action_id: "approve", style: "primary", value: job.id, text: { type: "plain_text", text: "Approve and publish" },
        confirm: { title: { type: "plain_text", text: "Publish this now?" }, text: md("It will go live on the website for everyone."), confirm: { type: "plain_text", text: "Publish" }, deny: { type: "plain_text", text: "Not yet" } } },
      { type: "button", action_id: "decline", style: "danger", value: job.id, text: { type: "plain_text", text: "Decline" } },
    ] },
    context(`Asked by <@${job.requester}>`, "The preview link is private", `Expires in ${opts.hours ?? 24} hours`, ...(opts.dryRun ? [":test_tube: *Test mode:* approving will not publish anything"] : [])),
  );
  return msg(`${title}: ${items.map((i) => i.text).join("; ")}`.slice(0, 300), ...blocks);
}

export function undoCard(job: { id: string; requester: string }, what: string): Msg {
  return msg(`Undo the last change? ${what}`,
    { type: "header", text: { type: "plain_text", text: "Undo the last change?" } },
    section(`:leftwards_arrow_with_hook: ${esc(what)}`),
    { type: "actions", block_id: `job:${job.id}`, elements: [
      { type: "button", action_id: "approve", style: "danger", value: job.id, text: { type: "plain_text", text: "Undo it" },
        confirm: { title: { type: "plain_text", text: "Undo this change?" }, text: md("The website will go back to how it was."), confirm: { type: "plain_text", text: "Undo" }, deny: { type: "plain_text", text: "Cancel" } } },
      { type: "button", action_id: "decline", value: job.id, text: { type: "plain_text", text: "Cancel" } },
    ] },
    context(`Asked by <@${job.requester}>`));
}

export const publishing = (actor: string, items: Item[]): Msg =>
  msg("Publishing…", section(`:rocket: *Publishing…*\n${bullets(items)}`), context(`Approved by <@${actor}>`));

export const live = (actor: string, items: Item[], siteUrl: string): Msg =>
  msg("It's live!", section(`:white_check_mark: *It's live!*\n${bullets(items)}`),
    context(`Approved by <@${actor}>`, `<${siteUrl}|Open the website>`, "Changed your mind? Say `undo`."));

export const publishedWaiting = (actor: string, items: Item[], siteUrl: string): Msg =>
  msg("Published. The website can take a few minutes to show it.", section(`:white_check_mark: *Published*\n${bullets(items)}`),
    context(`Approved by <@${actor}>`, `The website can take a few minutes to show it. <${siteUrl}|Open the website>`));

export const undone = (actor: string, what: string): Msg =>
  msg("Done. The last change was taken back.", section(`:leftwards_arrow_with_hook: *Done. I took back:*\n${esc(what)}`), context(`By <@${actor}>`, "The website will update in a minute or two."));

export const declined = (actor: string, items: Item[]): Msg =>
  msg("Declined", section(`:x: *Declined*\n${items.map((i) => `• ~${esc(i.text)}~`).join("\n")}`), context(`By <@${actor}>`, "Nothing was changed on the website."));

export const dryRunDone = (actor: string, items: Item[]): Msg =>
  msg("Test run only. Nothing was published.", section(`:test_tube: *Test run only. Nothing was published.*\n${bullets(items)}`), context(`Approved by <@${actor}>`, "Turn off test mode to publish for real."));

export const expired = (): Msg =>
  msg("This request expired", section(":hourglass: *This request expired.* Nobody approved it within 24 hours, so I deleted it."), context("Send it again if you still need it."));

export const needInfo = (q: string): Msg => msg(q, section(`:thinking_face: I need one more detail: ${esc(q)}`), context("Reply here and mention me with the answer."));
export const noChange = (): Msg => msg("I couldn't find a website change in that message.", section(":thinking_face: I couldn't find a website change in that message."), context("Say `help` to see what I can do."));
export const failed = (reason: string): Msg => msg(`Nothing was changed. ${reason}`, section(`:warning: *Nothing was changed.*\n${esc(reason)}`));
export const failedGeneric = (): Msg => failed("Sorry, something went wrong on my side. Please try again in a minute.");
export const authDown = (): Msg => failed("I can't read requests right now because my Claude login ran out. I've told the admin.");
export const limitHit = (): Msg => failed("I've hit my usage limit for now. Please try again later, or ask an admin to make the change.");
export const adminAlert = (t: string): Msg => msg(t, section(`:rotating_light: ${t}`));
export const denied = (what: string): string => `:no_entry: ${what}`;

/** "Here is what I understood": shown before anything is built, so the user can confirm or correct. */
export function confirmCard(job: { id: string; requester: string }, understood: string, lines: string[]): Msg {
  return msg(`Is this what you meant? ${understood}`,
    { type: "header", text: { type: "plain_text", text: "Is this what you meant?" } },
    section(`:speech_balloon: ${esc(understood)}`),
    ...(lines.length ? [section(lines.slice(0, 12).map((l) => `• ${esc(l)}`).join("\n"))] : []),
    { type: "actions", block_id: `job:${job.id}`, elements: [
      { type: "button", action_id: "confirm", style: "primary", value: job.id, text: { type: "plain_text", text: "Yes, go ahead" } },
      { type: "button", action_id: "not_quite", value: job.id, text: { type: "plain_text", text: "Not quite" } },
    ] },
    context(`Asked by <@${job.requester}>`, "Nothing is built until you say yes"));
}

/** The request could mean different things: let the user pick one. */
export function choiceCard(job: { id: string; requester: string }, question: string, choices: { label: string; text: string }[]): Msg {
  return msg(question,
    { type: "header", text: { type: "plain_text", text: "Which one do you mean?" } },
    section(`:thinking_face: ${esc(question)}\n\n` + choices.map((c, i) => `*${i + 1}.* ${esc(c.label)}`).join("\n")),
    { type: "actions", block_id: `job:${job.id}`, elements: [
      ...choices.map((c, i) => ({ type: "button", action_id: `choose_${i}`, value: job.id, text: { type: "plain_text", text: c.label.slice(0, 70) } })),
      { type: "button", action_id: "not_quite", value: job.id, text: { type: "plain_text", text: "None of these" } },
    ] },
    context(`Asked by <@${job.requester}>`));
}

export const tellMore = (): Msg => msg("Okay. Tell me what to change.", section(":pencil2: Okay, nothing was changed. Reply in this thread with what you'd like instead, and I'll take another look."));

/** Model text is untrusted: strip links (except the SMAIL site), neutralize mentions via esc(), and cap the length. */
export function cleanReply(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, (u) => (/^https:\/\/smail\.org\.sa(\/|$)/i.test(u) ? u : ""))
    .replace(/\bwww\.\S+/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, 600);
}
export const chat = (text: string): Msg => { const t = esc(cleanReply(text)) || "Hi! I'm here to help with the SMAIL website."; return msg(t, section(t)); };

/** A live checklist: shows the person what the bot is doing right now. */
export const STEPS = [
  "Got your message",
  "Claude is reading your request",
  "Building the change on a private copy",
  "Making your preview link",
];
export function progress(current: number, detail?: string): Msg {
  const lines = STEPS.map((label, i) =>
    i < current ? `:white_check_mark: ${label}` : i === current ? `:hourglass_flowing_sand: *${label}…*${detail ? `\n      _${esc(detail)}_` : ""}` : `:white_large_square: ${label}`);
  return msg(`${STEPS[Math.min(current, STEPS.length - 1)]}…`, section(lines.join("\n")), context("Nothing goes live until someone approves"));
}

export const alreadyDone = (): Msg => msg("The website is already like that.", section(":ok_hand: The website is already like that, so there's nothing to change."));
