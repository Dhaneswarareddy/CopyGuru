#!/bin/bash
# Start, stop or check the website on this Mac.
#
#   ./site.sh start           start the site and a public link
#   ./site.sh start --local   start the site for this Mac only (no public link)
#   ./site.sh stop            stop the site and the public link
#   ./site.sh status          show whether it is running and its addresses
#   ./site.sh restart         stop, then start (use after changing the code)
#
# The public link is a temporary Cloudflare tunnel: it gets a NEW address every
# time it is started, and it stops working while the Mac is asleep.

cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node@24/bin:$PATH"

PORT="${PORT:-3000}"
mkdir -p .data
SERVER_LOG=".data/server.log"
TUNNEL_LOG=".data/tunnel.log"
[ "$PORT" != "3000" ] && SERVER_LOG=".data/server-$PORT.log" && TUNNEL_LOG=".data/tunnel-$PORT.log"

server_pid() { lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | head -1; }
tunnel_pid() { pgrep -f "cloudflared tunnel.*127.0.0.1:$PORT" | head -1; }
healthy() { curl -sf -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null; }
public_url() { grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | tail -1; }

start_server() {
  if [ -n "$(server_pid)" ]; then
    echo "Site is already running."
    return 0
  fi
  if [ ! -d node_modules ]; then
    echo "Installing dependencies (first run only)…"
    npm install || { echo "Install failed."; return 1; }
  fi
  if [ ! -f .next/BUILD_ID ] || [ "$REBUILD" = "1" ]; then
    echo "Building…"
    npm run build >/dev/null 2>&1 || { echo "Build failed. Run 'npm run build' to see why."; return 1; }
  fi
  [ -f .env.local ] || { printf 'APP_SECRET=%s\n' "$(openssl rand -hex 32)" > .env.local; chmod 600 .env.local; }
  echo "Starting the site…"
  PORT="$PORT" HOSTNAME_BIND=127.0.0.1 nohup npm run start >>"$SERVER_LOG" 2>&1 &
  for _ in $(seq 1 60); do
    healthy && return 0
    sleep 1
  done
  echo "The site did not start. Last lines of $SERVER_LOG:"
  tail -5 "$SERVER_LOG"
  return 1
}

start_tunnel() {
  if [ -n "$(tunnel_pid)" ]; then
    return 0
  fi
  command -v cloudflared >/dev/null || { echo "cloudflared is not installed (brew install cloudflared). Running without a public link."; return 0; }
  echo "Opening a public link…"
  : >"$TUNNEL_LOG"
  nohup cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >>"$TUNNEL_LOG" 2>&1 &
  for _ in $(seq 1 40); do
    [ -n "$(public_url)" ] && return 0
    sleep 1
  done
  echo "Could not open a public link (see $TUNNEL_LOG). The site still works on this Mac."
}

stop_all() {
  local t s
  t="$(tunnel_pid)"
  s="$(server_pid)"
  [ -n "$t" ] && kill "$t" 2>/dev/null
  if [ -n "$s" ]; then
    kill "$s" 2>/dev/null
    for _ in $(seq 1 10); do
      [ -z "$(server_pid)" ] && break
      sleep 1
    done
    [ -n "$(server_pid)" ] && kill -9 "$(server_pid)" 2>/dev/null
  fi
  : >"$TUNNEL_LOG" 2>/dev/null
  if [ -z "$s" ] && [ -z "$t" ]; then echo "Nothing was running."; else echo "Stopped."; fi
}

status() {
  if [ -n "$(server_pid)" ] && healthy; then
    echo "Site:        running   http://localhost:$PORT"
  elif [ -n "$(server_pid)" ]; then
    echo "Site:        starting or not responding (port $PORT is in use)"
  else
    echo "Site:        stopped"
  fi
  if [ -n "$(tunnel_pid)" ] && [ -n "$(public_url)" ]; then
    echo "Public link: running   $(public_url)"
  elif [ -n "$(tunnel_pid)" ]; then
    echo "Public link: starting"
  else
    echo "Public link: off"
  fi
}

case "$1" in
  start)
    start_server || exit 1
    [ "$2" = "--local" ] || start_tunnel
    echo
    status
    ;;
  stop)
    stop_all
    ;;
  restart)
    stop_all
    REBUILD=1 start_server || exit 1
    [ "$2" = "--local" ] || start_tunnel
    echo
    status
    ;;
  status)
    status
    ;;
  *)
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
