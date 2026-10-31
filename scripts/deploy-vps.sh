#!/usr/bin/env bash
# Deploy the current meu-unii commit to the VPS.
#
# Local: clean meu-unii, focused tests, push to origin.
# VPS: back up the catalog/app.js (which carry the VPS's provider statuses),
# fetch the commit, reset, reapply those statuses to the fresh catalog,
# rebuild web/app.js, restart unii-chat, check HTTP and WebSocket health.
# On failure it restores the previous commit and assets.
set -euo pipefail

cd "$(dirname "$0")/.."

VPS_HOST="${VPS_HOST:-root@69.62.93.146}"
VPS_REPO="${VPS_REPO:-/opt/uniichat}"
VPS_KEY="${VPS_KEY:-$HOME/.ssh/id_ed25519}"
SSH=(ssh -F /dev/null -i "$VPS_KEY" -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new "$VPS_HOST")

if [ "$(git rev-parse --abbrev-ref HEAD)" != "meu-unii" ]; then
  echo "deploy: switch to meu-unii first (current: $(git rev-parse --abbrev-ref HEAD))" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "deploy: working tree has uncommitted changes; commit them first" >&2
  exit 1
fi
command -v bun >/dev/null || { echo "deploy: bun not in PATH" >&2; exit 1; }

echo "==> focused tests"
bun test --isolate Pick.test.ts Memory.test.ts MemoryLost.test.ts

echo "==> push origin/meu-unii"
git push origin meu-unii
HASH=$(git rev-parse HEAD)

echo "==> deploy $HASH to $VPS_HOST:$VPS_REPO"
"${SSH[@]}" bash -s -- "$HASH" "$VPS_REPO" <<'REMOTE'
set -uo pipefail
HASH="$1"
REPO="$2"
cd "$REPO" || { echo "deploy: no repo $REPO" >&2; exit 1; }
OLD=$(git rev-parse HEAD)
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="/root/.unii/deploy/$STAMP"
mkdir -p "$BACKUP"
cp t3-catalog.json "$BACKUP/catalog-before.json"
cp web/app.js "$BACKUP/app-before.js"
cp /root/.unii/config.json "$BACKUP/config-before.json" 2>/dev/null || true
cp t3-catalog.json /root/.unii/t3-catalog-vps.json
cp web/app.js /root/.unii/web-app-vps.js

fail() {
  echo "deploy: $*" >&2
  echo "deploy: rolling back to $OLD" >&2
  cd "$REPO" || exit 1
  git reset --hard "$OLD" >/dev/null 2>&1 || true
  cp "$BACKUP/catalog-before.json" t3-catalog.json 2>/dev/null || true
  cp "$BACKUP/app-before.js" web/app.js 2>/dev/null || true
  systemctl restart unii-chat >/dev/null 2>&1 || true
  sleep 2
  if curl -fsS -o /dev/null http://127.0.0.1:8788/api/hello; then
    echo "deploy: rolled back; app healthy" >&2
  else
    echo "deploy: rolled back, but health still fails" >&2
  fi
  exit 1
}

git fetch --quiet --prune origin || fail "git fetch"

# If the new commit carries the health probe, run it against the running
# app before changing anything; a busy chat is not cut by a deploy.
if git cat-file -e "$HASH:scripts/health-ws.ts" 2>/dev/null; then
  git show "$HASH:scripts/health-ws.ts" > /tmp/unii-health.ts
  if ! PATH=/root/.bun/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin bun /tmp/unii-health.ts --idle; then
    echo "deploy: chat busy or app unhealthy; aborting before changing anything" >&2
    exit 1
  fi
fi

git reset --hard "$HASH" >/dev/null || fail "git reset"

# Keep the VPS-specific provider statuses, but take the fresh model lists.
python3 - "$BACKUP" <<'PY' || fail "catalog status"
import json, os, sys
fresh = json.load(open("t3-catalog.json"))
old = json.load(open(os.path.join(sys.argv[1], "catalog-before.json")))
by = {p.get("id"): p for p in old.get("providers", [])}
for p in fresh.get("providers", []):
    q = by.get(p.get("id"))
    if q is None:
        continue
    for key in ("status", "detail", "checkedAt", "testedModel"):
        if key in q:
            p[key] = q[key]
with open("t3-catalog.json", "w") as f:
    json.dump(fresh, f, indent=2)
    f.write("\n")
PY

PATH=/root/.bun/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin bun run web >/tmp/unii-deploy-web.log 2>&1 || fail "web build"
systemctl restart unii-chat || fail "restart"
for i in $(seq 1 20); do
  if systemctl is-active --quiet unii-chat && curl -fsS -o /dev/null http://127.0.0.1:8788/api/hello 2>/dev/null; then
    break
  fi
  sleep 0.5
done
systemctl is-active --quiet unii-chat || fail "service inactive"
curl -fsS -o /dev/null http://127.0.0.1:8788/api/hello || fail "hello"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/)" = "302" ] || fail "root is not 302"
PATH=/root/.bun/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin UNII_HEALTH_URL=http://127.0.0.1:8788 bun scripts/health-ws.ts || fail "websocket health"
echo "deploy: active at $HASH"
REMOTE

echo "==> deployed $HASH"
echo "open: https://srv769897.tailc97b69.ts.net:10443/"
