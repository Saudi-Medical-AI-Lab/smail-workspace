#!/bin/sh
# Run ONCE on a fresh Ubuntu 24.04 Droplet, as root:  sh provision.sh bot.example.com preview.example.com
set -eu
BOT_HOST="${1:?usage: provision.sh bot.example.com preview.example.com}"
PREVIEW_HOST="${2:?usage: provision.sh bot.example.com preview.example.com}"

apt-get update -y && apt-get upgrade -y
apt-get install -y curl git tar ufw caddy ca-certificates
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
# Claude CLI (needed on the server; login is by token, see README)
npm install -g @anthropic-ai/claude-code

# Dedicated unprivileged user and folders
id smailbot >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin smailbot
mkdir -p /opt/smail /var/www/previews
chown -R smailbot:smailbot /opt/smail /var/www/previews
# The deploy user (whoever you ssh in as) must be able to write /opt/smail
[ -n "${SUDO_USER:-}" ] && chown -R "$SUDO_USER" /opt/smail || true
chmod 755 /var/www /var/www/previews

# Firewall: SSH + web only. The bot itself listens on 127.0.0.1 behind Caddy.
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

# Caddy: HTTPS for the bot and the previews
cat > /etc/caddy/Caddyfile <<CADDY
$BOT_HOST {
	reverse_proxy 127.0.0.1:3000
}
$PREVIEW_HOST {
	root * /var/www/previews
	file_server
	header {
		X-Robots-Tag "noindex, nofollow"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		-Server
	}
}
CADDY
systemctl reload caddy || systemctl restart caddy

# Bot service (code arrives later via deploy.sh)
cp /dev/null /etc/smail-slack-bot.env && chmod 600 /etc/smail-slack-bot.env && chown smailbot /etc/smail-slack-bot.env
echo "Done. Next: fill /etc/smail-slack-bot.env (see deploy/.env.example), install the systemd unit, then run deploy.sh from your laptop."
