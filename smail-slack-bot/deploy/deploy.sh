#!/bin/sh
# Updates the server to whatever is on GitHub (main) and restarts the bot.
# Push your changes first, then: deploy/deploy.sh user@droplet
# The repo holds both smail-mcp and smail-slack-bot (the bot imports ../smail-mcp/src).
set -eu
HOST="${1:?usage: deploy.sh user@host}"
REPO="https://github.com/Saudi-Medical-AI-Lab/smail-workspace.git"
ssh "$HOST" "set -e
  if [ ! -d /opt/smail/.git ]; then sudo -u smailbot git clone --quiet $REPO /opt/smail; fi
  cd /opt/smail
  sudo -u smailbot git fetch --quiet origin main
  sudo -u smailbot git reset --hard --quiet origin/main
  (cd smail-mcp && sudo -u smailbot npm ci --silent)
  cd smail-slack-bot
  sudo -u smailbot npm ci --silent
  sudo -u smailbot mkdir -p data
  sudo cp deploy/smail-slack-bot.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable smail-slack-bot
  sudo systemctl restart smail-slack-bot
  sleep 3
  systemctl is-active smail-slack-bot"
