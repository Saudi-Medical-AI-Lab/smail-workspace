# Security

## Reporting a problem
Please **do not** open a public issue for a security problem.

Use GitHub's private reporting: open the **Security** tab of this repo and choose **Report a vulnerability**. If that is not available, email Saudimedicalailab@gmail.com with the subject "Security".

Tell us what you found, how to reproduce it, and what could go wrong. We will reply as soon as we can, and we'll credit you if you want.

## What matters most here
- Anything that lets someone change the website without an approver pressing Approve.
- Anything that lets the bot write outside the allowed data files and photo folders.
- Any way to read or leak the Slack, GitHub or Claude tokens.

## Secrets
Tokens belong only in `/etc/smail-slack-bot.env` on the server, and in Cloudflare secrets for the MCP. If you ever find a secret in this repo or its history, report it right away so it can be replaced.
