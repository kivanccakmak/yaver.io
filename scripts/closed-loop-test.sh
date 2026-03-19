#!/bin/bash
# Closed-loop test: signup → serve → device visible → task creation → task output
# Imitates the mobile app flow against the live Convex dev backend + local agent.

set -euo pipefail

# Default hosted Convex instance (public endpoint). Override via CONVEX_SITE_URL env var.
CONVEX_SITE_URL="${CONVEX_SITE_URL:-https://shocking-echidna-394.eu-west-1.convex.site}"
AGENT_HTTP_PORT=18080
AGENT_WORK_DIR="/tmp/yaver-test-workdir"
AGENT_BIN_DIR="/Users/kivanccakmak/Workspace/yaver.io/desktop/agent"
CONFIG_FILE="$HOME/.yaver/config.json"
CONFIG_BACKUP="$HOME/.yaver/config.json.bak"

TEST_EMAIL="testuser-$(date +%s)@test.yaver.io"
TEST_PASSWORD="testpassword123"
TEST_FULLNAME="Test User"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }
info() { echo -e "${YELLOW}→ $1${NC}"; }

cleanup() {
    info "Cleaning up..."
    # Stop agent if running
    if [ -n "${AGENT_PID:-}" ] && kill -0 "$AGENT_PID" 2>/dev/null; then
        kill "$AGENT_PID" 2>/dev/null || true
        wait "$AGENT_PID" 2>/dev/null || true
        info "Agent process stopped"
    fi
    # Restore original config
    if [ -f "$CONFIG_BACKUP" ]; then
        cp "$CONFIG_BACKUP" "$CONFIG_FILE"
        rm "$CONFIG_BACKUP"
        info "Original config restored"
    fi
    # Delete test account from Convex if we have a token
    if [ -n "${AUTH_TOKEN:-}" ]; then
        info "Deleting test account..."
        curl -sf -X POST "${CONVEX_SITE_URL}/auth/delete-account" \
            -H "Authorization: Bearer ${AUTH_TOKEN}" \
            -H "Content-Type: application/json" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# ── Step 0: Setup ─────────────────────────────────────────────────────
info "Starting closed-loop test"
info "Test email: $TEST_EMAIL"

mkdir -p "$AGENT_WORK_DIR"

# Backup existing config
if [ -f "$CONFIG_FILE" ]; then
    cp "$CONFIG_FILE" "$CONFIG_BACKUP"
    info "Backed up existing config"
fi

# ── Step 1: Signup ────────────────────────────────────────────────────
info "Step 1: Creating test account via /auth/signup..."

SIGNUP_RESPONSE=$(curl -sf -X POST "${CONVEX_SITE_URL}/auth/signup" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${TEST_EMAIL}\",\"fullName\":\"${TEST_FULLNAME}\",\"password\":\"${TEST_PASSWORD}\"}")

AUTH_TOKEN=$(echo "$SIGNUP_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
USER_ID=$(echo "$SIGNUP_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['userId'])")

if [ -z "$AUTH_TOKEN" ]; then
    fail "Signup failed — no token returned"
fi
pass "Account created (userId=$USER_ID, token=${AUTH_TOKEN:0:8}...)"

# ── Step 2: Validate token ───────────────────────────────────────────
info "Step 2: Validating token via /auth/validate..."

VALIDATE_RESPONSE=$(curl -sf -X GET "${CONVEX_SITE_URL}/auth/validate" \
    -H "Authorization: Bearer ${AUTH_TOKEN}")

VALIDATED_EMAIL=$(echo "$VALIDATE_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('user',{}).get('email','') or d.get('email',''))")

if [ "$VALIDATED_EMAIL" = "$TEST_EMAIL" ]; then
    pass "Token validated (email=$VALIDATED_EMAIL)"
else
    fail "Token validation failed: expected $TEST_EMAIL, got $VALIDATED_EMAIL"
fi

# ── Step 3: Write config and build agent ──────────────────────────────
info "Step 3: Configuring agent and building..."

DEVICE_ID="test-$(uuidgen | tr '[:upper:]' '[:lower:]')"

cat > "$CONFIG_FILE" << EOF
{
  "auth_token": "${AUTH_TOKEN}",
  "device_id": "${DEVICE_ID}",
  "convex_site_url": "${CONVEX_SITE_URL}"
}
EOF
pass "Config written (deviceId=${DEVICE_ID:0:12}...)"

# Build the agent
cd "$AGENT_BIN_DIR"
go build -o /tmp/yaver-test-agent . 2>&1 || fail "Agent build failed"
pass "Agent binary built"

# ── Step 4: Start agent in debug mode ─────────────────────────────────
info "Step 4: Starting agent (HTTP on port $AGENT_HTTP_PORT)..."

CLAUDECODE= /tmp/yaver-test-agent serve --debug --port "$AGENT_HTTP_PORT" --work-dir "$AGENT_WORK_DIR" --no-quic > /tmp/yaver-test-agent.log 2>&1 &
AGENT_PID=$!

# Wait for agent to be ready
for i in $(seq 1 15); do
    if curl -sf "http://127.0.0.1:${AGENT_HTTP_PORT}/health" > /dev/null 2>&1; then
        break
    fi
    if ! kill -0 "$AGENT_PID" 2>/dev/null; then
        echo "--- Agent log ---"
        cat /tmp/yaver-test-agent.log
        fail "Agent process exited prematurely"
    fi
    sleep 1
done

HEALTH=$(curl -sf "http://127.0.0.1:${AGENT_HTTP_PORT}/health" 2>/dev/null) || {
    echo "--- Agent log ---"
    cat /tmp/yaver-test-agent.log
    fail "Agent health check failed after 15s"
}
HEALTH_OK=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',False))")
if [ "$HEALTH_OK" = "True" ]; then
    pass "Agent health OK"
else
    fail "Agent health returned ok=false"
fi

# ── Step 5: Check agent info (authenticated) ─────────────────────────
info "Step 5: Getting agent info (authenticated)..."

INFO_RESPONSE=$(curl -sf "http://127.0.0.1:${AGENT_HTTP_PORT}/info" \
    -H "Authorization: Bearer ${AUTH_TOKEN}")

INFO_HOSTNAME=$(echo "$INFO_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('hostname',''))")
INFO_WORKDIR=$(echo "$INFO_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('workDir',''))")

if [ -n "$INFO_HOSTNAME" ]; then
    pass "Agent info: hostname=$INFO_HOSTNAME, workDir=$INFO_WORKDIR"
else
    fail "Agent info request failed"
fi

# ── Step 6: Verify device registered in Convex ───────────────────────
info "Step 6: Checking device visibility via Convex /devices/list..."

# Give the agent a moment to register + heartbeat
sleep 3

DEVICES_RESPONSE=$(curl -sf -X GET "${CONVEX_SITE_URL}/devices/list" \
    -H "Authorization: Bearer ${AUTH_TOKEN}")

DEVICE_COUNT=$(echo "$DEVICES_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('devices',[])))")
DEVICE_NAMES=$(echo "$DEVICES_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(', '.join([x.get('name','?') for x in d.get('devices',[])]))")

if [ "$DEVICE_COUNT" -gt 0 ]; then
    pass "Device visible in Convex ($DEVICE_COUNT device(s): $DEVICE_NAMES)"
else
    echo "$DEVICES_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$DEVICES_RESPONSE"
    fail "No devices visible in Convex"
fi

# ── Step 7: Auth check — reject unauthenticated request ──────────────
info "Step 7: Verifying auth rejection for bad token..."

UNAUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${AGENT_HTTP_PORT}/info" \
    -H "Authorization: Bearer badtoken123")

if [ "$UNAUTH_STATUS" = "403" ]; then
    pass "Bad token correctly rejected (403)"
else
    fail "Expected 403 for bad token, got $UNAUTH_STATUS"
fi

# ── Step 8: Create a task ─────────────────────────────────────────────
info "Step 8: Creating task via POST /tasks..."

TASK_RESPONSE=$(curl -sf -X POST "http://127.0.0.1:${AGENT_HTTP_PORT}/tasks" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"title":"echo hello from yaver test","description":"Just print: hello from yaver closed-loop test. Do not use any tools, just respond with that text."}')

TASK_ID=$(echo "$TASK_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('taskId',''))")
TASK_STATUS=$(echo "$TASK_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")

if [ -n "$TASK_ID" ]; then
    pass "Task created (id=$TASK_ID, status=$TASK_STATUS)"
else
    echo "$TASK_RESPONSE"
    fail "Task creation failed"
fi

# ── Step 9: Wait for task to finish and get output ────────────────────
info "Step 9: Polling task status..."

MAX_WAIT=120
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
    TASK_DETAIL=$(curl -sf "http://127.0.0.1:${AGENT_HTTP_PORT}/tasks/${TASK_ID}" \
        -H "Authorization: Bearer ${AUTH_TOKEN}" 2>/dev/null) || true

    CURRENT_STATUS=$(echo "$TASK_DETAIL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('status',''))" 2>/dev/null) || true

    if [ "$CURRENT_STATUS" = "finished" ] || [ "$CURRENT_STATUS" = "failed" ] || [ "$CURRENT_STATUS" = "stopped" ]; then
        break
    fi

    sleep 3
    ELAPSED=$((ELAPSED + 3))
    echo -n "."
done
echo ""

if [ "$CURRENT_STATUS" = "finished" ]; then
    TASK_OUTPUT=$(echo "$TASK_DETAIL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('output','')[:500])" 2>/dev/null)
    pass "Task finished! Output (first 500 chars):"
    echo "  $TASK_OUTPUT"
elif [ "$CURRENT_STATUS" = "failed" ]; then
    TASK_OUTPUT=$(echo "$TASK_DETAIL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('output','')[:500])" 2>/dev/null)
    echo "  Output: $TASK_OUTPUT"
    fail "Task failed"
else
    fail "Task did not finish within ${MAX_WAIT}s (status=$CURRENT_STATUS)"
fi

# ── Step 10: List tasks ───────────────────────────────────────────────
info "Step 10: Listing all tasks..."

TASKS_LIST=$(curl -sf "http://127.0.0.1:${AGENT_HTTP_PORT}/tasks" \
    -H "Authorization: Bearer ${AUTH_TOKEN}")

TASKS_COUNT=$(echo "$TASKS_LIST" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('tasks',[])))")

if [ "$TASKS_COUNT" -gt 0 ]; then
    pass "Task listing works ($TASKS_COUNT task(s))"
else
    fail "Task listing returned 0 tasks"
fi

# ── Step 11: Stop task (if still running) ─────────────────────────────
info "Step 11: Testing task stop endpoint..."

# Create a long-running task to test stop
LONG_TASK_RESPONSE=$(curl -sf -X POST "http://127.0.0.1:${AGENT_HTTP_PORT}/tasks" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"title":"count to one million slowly","description":"Count from 1 to 1000000, printing each number. This is a test task that should be stopped."}')

LONG_TASK_ID=$(echo "$LONG_TASK_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('taskId',''))")

if [ -n "$LONG_TASK_ID" ]; then
    sleep 5  # Let it start
    STOP_RESPONSE=$(curl -sf -X POST "http://127.0.0.1:${AGENT_HTTP_PORT}/tasks/${LONG_TASK_ID}/stop" \
        -H "Authorization: Bearer ${AUTH_TOKEN}")
    STOP_OK=$(echo "$STOP_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',False))")
    if [ "$STOP_OK" = "True" ]; then
        pass "Task stop works (stopped $LONG_TASK_ID)"
    else
        echo "$STOP_RESPONSE"
        fail "Task stop failed"
    fi
else
    fail "Could not create long-running task for stop test"
fi

# ── Done ──────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  All closed-loop tests passed!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo ""
info "Test account: $TEST_EMAIL"
info "Cleanup will delete the test account and restore config."
