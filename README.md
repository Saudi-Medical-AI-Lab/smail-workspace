<p align="center">
  <img src="assets/smail-logo.svg" alt="SMAIL logo" width="360">
</p>

<h1 align="center">SMAIL Workspace</h1>

<p align="center">
  Tools that let the SMAIL team update <a href="https://smail.org.sa">smail.org.sa</a> from Slack or from Claude.<br>
  Ask in plain words, check a preview, press Approve, and the change goes live.
</p>

<p align="center">
  <a href="https://github.com/Saudi-Medical-AI-Lab/smail-workspace/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Saudi-Medical-AI-Lab/smail-workspace/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178c6.svg">
  <img alt="Node" src="https://img.shields.io/badge/node-22-339933.svg">
</p>

## What is this?

SMAIL (Saudi Medical AI Lab) is a volunteer-run research program that pairs students at Saudi universities with mentors from around the world. Its website lists the people, news and banner from simple data files. This repo holds the two tools that edit those files safely.

| Folder | What it does |
| --- | --- |
| [`smail-slack-bot`](smail-slack-bot) | A Slack bot. You write "add Sara Ali, mentor, cohort 3" (with a photo). It makes the change on a separate branch, posts a private preview link, and waits for **Approve** or **Decline**. |
| [`smail-mcp`](smail-mcp) | An [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers. It lets Claude edit the same content directly, and holds the shared rules both tools use. |

The website itself lives in its own repo: [`Saudi-Medical-AI-Lab/smail`](https://github.com/Saudi-Medical-AI-Lab/smail).

## How a change goes live

```
You in Slack ──▶ bot reads your message (Claude, no file access)
                    │
                    ▼
        checks the rules, edits a copy on a branch
                    │
                    ▼
       private preview link + Approve / Decline
                    │
         Approve ───┴─── Decline
            │              │
   merge to main      branch and preview deleted
            │
   GitHub Pages publishes smail.org.sa
```

Nothing reaches the live site until a person presses Approve. `undo` reverts the last change.

## Safety, in short

- Claude only turns your words into a short list of edits. It cannot open files or run commands.
- The code, not Claude, makes the edit, and it can only touch the people, news, cohort and banner data files, `staff.html`, `llms.txt`, and the member photo folders.
- Only named Slack users can ask, and only named approvers can Approve. The bot listens in one channel.
- Photos are checked, resized and re-saved before they are used.
- Secrets live only on the server. They are never in this repo.

Details are in each folder's README. To report a security problem, see [SECURITY.md](SECURITY.md).

## Getting started

1. Read [`smail-slack-bot/README.md`](smail-slack-bot/README.md). It walks through the server, Slack app and tokens.
2. Run the tests:
   ```sh
   (cd smail-mcp && npm ci && npm test)
   (cd smail-slack-bot && npm ci && npm test)
   ```
3. Start in test mode (`DRY_RUN=1`) and only switch it off after a clean rehearsal.

The bot imports a few files from `smail-mcp/src`, so always keep the two folders side by side.

## Contributing

Ideas and fixes are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

The code is released under the [MIT License](LICENSE). The SMAIL name, logo and member photos are not covered. See [NOTICE](NOTICE).
