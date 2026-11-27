<p align="center">
  <img src="../assets/smail-logo.svg" alt="SMAIL logo" width="280">
</p>

# smail-slack-bot

Slack -> preview -> Approve/Decline -> live, for smail.org.sa. Reuses `../smail-mcp/src` (schema, guards, ContentService, GitHubRepo). The repo holds both folders; `deploy/deploy.sh user@host` pulls it on the server. The bot refuses to start if the sibling is missing.

## Flow
The bot reads every message in its channel (no @mention needed) and stays silent on chat that is not a site request. Replies in a thread keep the earlier messages as context. `@sml-bot add Sara Ali, mentor cohort 3, KFSH` (+ photo) -> the Claude CLI (subscription token, no tools) turns the text into JSON operations -> validated by smail-mcp -> committed to branch `slack/<id>` -> PR opened -> preview at `PREVIEW_BASE_URL/<slug>/` -> Approve squash-merges to `main` (GitHub Pages publishes) / Decline deletes branch, PR and preview. `@sml-bot undo` reverts the last bot commit (with a confirm card). `@sml-bot pause|resume` (approvers).

## Safety rules (enforced in code)
- Only users in `REQUESTER_USER_IDS` may ask (`*` = everyone in the private channel); only `APPROVER_USER_IDS` may Approve/Decline (`*` = everyone in the channel, so keep the channel private). One channel only.
- The model has no tools and cannot touch files. Its JSON is re-validated; the branch diff must only touch `data/*.json` and `images/<folder>/*` or the job is discarded.
- Slack signature checked by Bolt; events deduped by `event_id`; double clicks cannot double-approve.
- Slack token is only ever sent to `*.slack.com`. Images are magic-byte checked, re-encoded and capped at 800px / 5 MB.
- Pending approvals expire after 24 h. Every action is in the `audit` table.
- Site mirrors stay in sync automatically: `staff.html` JSON-LD gets/loses a Person per staff member (hand-written entries are never rewritten), `llms.txt` counts follow `people.json`, and the homepage counters read `data-stat` from the data.
- Previews rewrite root-absolute links (`/`, `/#about`) to stay inside `/<slug>/`. This happens on the preview copy only.

## Setup on the droplet
1. Create an Ubuntu 24.04 Droplet, then as root run `sh deploy/provision.sh bot.example.com preview.example.com` (installs Node, Caddy, the Claude CLI, firewall, user and folders).
2. Push your changes to GitHub, then run `deploy/deploy.sh user@droplet` from your laptop (the server pulls `main` into `/opt/smail/`, runs `npm ci`, installs and restarts the service).
3. DNS: `bot.` and `preview.` A records. Install `deploy/Caddyfile`, `systemctl reload caddy`.
4. Create the Slack app from `deploy/slack-manifest.yaml`; invite the bot to the channel; copy tokens and user IDs.
5. Login once on a laptop: `claude setup-token`; put the value in `/etc/smail-slack-bot.env` (chmod 600) with the rest of `deploy/.env.example`.
6. `deploy.sh` installs and starts the service. Start with `DRY_RUN=1`; set it to `0` after a clean rehearsal.

## Runbook
- "Claude login expired" alert: run `claude setup-token` on a laptop, update `CLAUDE_CODE_OAUTH_TOKEN`, `systemctl restart smail-slack-bot`.
- Bot misbehaving: `@sml-bot pause`, or `systemctl stop smail-slack-bot`. Bad change already live: `@sml-bot undo`, or revert the squash commit on GitHub.
- Tests: `npm test`. Typecheck: `npm run typecheck`.

> Part of [smail-workspace](../README.md). Code is MIT licensed (see [LICENSE](../LICENSE)); the SMAIL name, logo and member photos are not covered ([NOTICE](../NOTICE)).
