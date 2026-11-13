#!/usr/bin/env bash
# 轮换 memoryd 的 bearer token 并重启服务（不回显 token）
set -euo pipefail

CONF="$HOME/.config/dsh-memory/config.json"
TOKENFILE="$HOME/.config/dsh-memory/token"
PY=/usr/bin/python3

"$PY" - "$CONF" "$TOKENFILE" <<'PY'
import json, os, secrets, sys
conf_path, token_path = sys.argv[1], sys.argv[2]
cfg = json.load(open(conf_path))
token = "mem_" + secrets.token_hex(20)
cfg["token"] = token
json.dump(cfg, open(conf_path, "w"), indent=2, ensure_ascii=False)
open(token_path, "w").write(token)
os.chmod(conf_path, 0o600)
os.chmod(token_path, 0o600)
print("token rotated, length =", len(token))
PY

launchctl kickstart -k "gui/$(id -u)/com.local.memoryd" 2>/dev/null || launchctl stop com.local.memoryd
sleep 2

code=000
for i in $(seq 1 20); do
  code=$(curl -s -m 2 -o /dev/null -w "%{http_code}" http://192.168.5.5:8788/health 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "health = $code"

NEW="$(cat "$TOKENFILE")"
curl -s -m 3 -o /dev/null -w "with-new-token = %{http_code}\n" -H "Authorization: Bearer $NEW" http://192.168.5.5:8788/api/projects
curl -s -m 3 -o /dev/null -w "no-token       = %{http_code}\n" http://192.168.5.5:8788/api/projects
