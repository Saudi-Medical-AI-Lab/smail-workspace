# Contributing

Thanks for helping. This repo is small, so the process is too.

## Before you start
- Open an issue first for anything bigger than a small fix, so we can agree on the idea.
- For security problems, do **not** open an issue. See [SECURITY.md](SECURITY.md).

## Set up
```sh
git clone https://github.com/Saudi-Medical-AI-Lab/smail-workspace.git
cd smail-workspace
(cd smail-mcp && npm ci)
(cd smail-slack-bot && npm ci)
```
Node 22 is recommended. Keep `smail-mcp` and `smail-slack-bot` side by side, because the bot imports files from the MCP.

## Check your work
```sh
(cd smail-mcp && npm run typecheck && npm test)
(cd smail-slack-bot && npm run typecheck && npm test)
```
Both must pass. The same checks run on every pull request.

## Pull requests
- Keep each one focused on one change.
- Add or update a test when behavior changes.
- Write the Slack messages in plain, short words. No jargon.
- Never commit secrets, `.env` or `.dev.vars` files, or real member photos.

## Rules that must not weaken
These protect the live website. A change that loosens one needs a clear reason in the pull request:
- Claude gets no tools and returns only a list of edits.
- Only the allowed data files and photo folders can be written.
- A person must press Approve before anything goes live.
- Slack tokens are only ever sent to `slack.com` addresses.
