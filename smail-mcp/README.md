<p align="center">
  <img src="../assets/smail-logo.svg" alt="SMAIL logo" width="280">
</p>

# smail-mcp

An MCP server that edits the SMAIL website content (JSON files in `data/`) through the GitHub API.
Every change is one commit on `main`, prefixed `[smail-mcp]`, and can be reversed with `undo_last_change`.

## Tools (12)
Read: `list_content`, `get_deploy_status`
Write: `upsert_person`, `bulk_import_people`, `upsert_cohort`, `post_news`, `update_news`, `set_banner`, `set_visibility`, `upload_image`
Destructive (preview first, then `confirm: true`): `remove_item`, `undo_last_change`

## Rules the server enforces (not just describes)
- Titles, affiliations, news text and banner text need English and Arabic.
- Only `data/*.json` and `images/<folder>/` can be written. Tool arguments never choose a path or repo.
- Content that looks like a token or key is refused (the repo is public).
- Bulk calls are capped at 100 people; deletes need `confirm: true`; undo refuses commits it did not make.

## One-time setup
1. GitHub: create a fine-grained personal access token. Resource owner `Saudi-Medical-AI-Lab`, only repository `smail`,
   permissions Contents: read and write, Pages: read. Short expiry. An organization owner must approve it.
2. `npx wrangler login`
3. `openssl rand -hex 32` to make the access token, then:
   `npx wrangler secret put GITHUB_TOKEN` and `npx wrangler secret put MCP_ACCESS_TOKEN` (paste each when asked; never commit them).
4. `npm run deploy`
5. Connect from Claude Code:
   `claude mcp add --transport http smail https://smail-mcp.<your-subdomain>.workers.dev/mcp --header "Authorization: Bearer <MCP_ACCESS_TOKEN>"`

## Develop
`npm test` (27 tests), `npm run typecheck`, `npm run dev` (needs a `.dev.vars` file with `MCP_ACCESS_TOKEN` and `GITHUB_TOKEN`; it is git-ignored).

## Known limits
- Auth is a shared bearer token. Before giving access to other people, move to per-user sign-in (OAuth with a GitHub allowlist).
- The write limiter is per server instance, best effort. The 100-item cap and git history are the real backstops.
- `upload_image` does not resize. Use web-sized images.

> Part of [smail-workspace](../README.md). Code is MIT licensed (see [LICENSE](../LICENSE)); the SMAIL name, logo and member photos are not covered ([NOTICE](../NOTICE)).
