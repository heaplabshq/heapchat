#!/usr/bin/env bash
# Heap Chat smoke test — boots the server against a throwaway data dir, creates an
# admin account, and hits one representative endpoint per feature group, asserting
# HTTP status. Used to confirm the server.js refactor keeps the API wired up.
#
# Does NOT require Ollama: only checks endpoints that respond without a model
# (read paths return 200; model-dependent endpoints are intentionally excluded).
#
# Usage: scripts/smoke.sh            # uses server.js
#        SERVER=server.baseline.js scripts/smoke.sh   # check the baseline
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="${SERVER:-server.js}"
PORT="${PORT:-5199}"
BASE="http://127.0.0.1:${PORT}"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/heapchat-smoke-XXXXXX")"
COOKIES="${DATA_DIR}/cookies.txt"

pass=0; fail=0
cleanup() { if [ -n "${SRV_PID:-}" ]; then kill "$SRV_PID" 2>/dev/null; wait "$SRV_PID" 2>/dev/null; fi; rm -rf "$DATA_DIR"; }
trap cleanup EXIT

# ---- boot ----
# exec replaces the subshell with node so $! is node's own PID (kill reaches it on cleanup)
( cd "$ROOT" && exec env HEAPCHAT_DATA_DIR="$DATA_DIR" PORT="$PORT" HOST=127.0.0.1 node "$SERVER" ) >"$DATA_DIR/server.log" 2>&1 &
SRV_PID=$!

up=""
for _ in $(seq 1 40); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/auth/me" 2>/dev/null || true)"
  if [ "$code" = "200" ] || [ "$code" = "401" ]; then up=1; break; fi
  sleep 0.25
done
if [ -z "$up" ]; then echo "✗ server did not boot:"; cat "$DATA_DIR/server.log"; exit 2; fi

# check <name> <expected-code> <method> <path> [json-body]
check() {
  local name="$1" want="$2" method="$3" pathq="$4" body="${5:-}"
  local code
  if [ -n "$body" ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" -c "$COOKIES" \
      -X "$method" -H 'Content-Type: application/json' -d "$body" "$BASE$pathq")"
  else
    code="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" -c "$COOKIES" \
      -X "$method" "$BASE$pathq")"
  fi
  if [ "$code" = "$want" ]; then printf '  ✓ %-28s %s\n' "$name" "$code"; pass=$((pass+1));
  else printf '  ✗ %-28s got %s want %s\n' "$name" "$code" "$want"; fail=$((fail+1)); fi
}

echo "smoke: $SERVER  (data: $DATA_DIR)"

# ---- auth: first-run setup creates an admin and the session cookie ----
check "auth/setup (create admin)" 200 POST /api/auth/setup '{"username":"smoke","name":"Smoke","password":"smoke"}'
check "auth/me"                    200 GET  /api/auth/me
check "config"                    200 GET  /api/config
check "browse (home)"             200 GET  "/api/browse?path=$HOME"
check "list (home)"               200 GET  "/api/list?path=$HOME"
check "chats"                     200 GET  /api/chats
check "memory"                    200 GET  /api/memory
check "projects"                  200 GET  /api/projects
check "agents"                    200 GET  /api/agents
check "roster"                    200 GET  /api/roster
check "people"                    200 GET  /api/people
check "graph"                     200 GET  /api/graph
check "faces/list"                200 GET  /api/faces/list
check "mcp (connectors)"          200 GET  /api/mcp
check "users (admin)"             200 GET  /api/users
check "admin/server"              200 GET  /api/admin/server
check "admin/indexes"             200 GET  /api/admin/indexes
check "models"                    200 GET  /api/models
check "health"                    200 GET  /api/health
check "setup/status"              200 GET  /api/setup/status

# ---- MCP server mode: bearer-token tools/list ----
TOKEN="$(curl -s -b "$COOKIES" "$BASE/api/auth/mcp-token" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
if [ -n "$TOKEN" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
  if [ "$code" = "200" ]; then printf '  ✓ %-28s %s\n' "mcp tools/list" "$code"; pass=$((pass+1));
  else printf '  ✗ %-28s got %s want 200\n' "mcp tools/list" "$code"; fail=$((fail+1)); fi
else
  printf '  ✗ %-28s no token\n' "mcp tools/list"; fail=$((fail+1))
fi

echo "---"
echo "pass: $pass  fail: $fail"
[ "$fail" -eq 0 ]
