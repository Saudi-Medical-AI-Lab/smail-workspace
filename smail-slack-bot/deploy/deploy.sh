#!/bin/sh
# Ships BOTH folders (the bot imports ../smail-mcp/src) and restarts the service.
# Usage: deploy/deploy.sh user@droplet
set -eu
HOST="${1:?usage: deploy.sh user@host}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
for d in smail-mcp smail-slack-bot; do
  rsync -az --delete --exclude node_modules --exclude .env --exclude .dev.vars --exclude .wrangler --exclude data \
    "$ROOT/$d/" "$HOST:/opt/smail/$d/"
done
ssh "$HOST" 'set -e; cd /opt/smail/smail-mcp && npm ci --silent; cd ../smail-slack-bot && npm ci --silent && mkdir -p data && sudo chown -R smailbot:smailbot /opt/smail && sudo cp deploy/smail-slack-bot.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable smail-slack-bot && sudo systemctl restart smail-slack-bot && sleep 3 && systemctl is-active smail-slack-bot'
