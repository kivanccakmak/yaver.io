"""Advanced client — auth, device discovery, task management, verbosity."""
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../python"))
from yaver import YaverClient, YaverAuthClient

token = os.environ.get("YAVER_TOKEN", "")
if not token:
    print("Set YAVER_TOKEN env var")
    sys.exit(1)

# ── Auth & device discovery ──────────────────────────────────────────
auth = YaverAuthClient(token)
user = auth.validate_token()
print(f"Authenticated as {user['user']['email']}")

devices = auth.list_devices()
print(f"Devices ({len(devices)}):")
for d in devices:
    status = "online" if d.get("isOnline") else "offline"
    print(f"  {d['deviceId'][:8]} — {d['name']} ({d['platform']}) [{status}]")

# ── User settings ────────────────────────────────────────────────────
settings = auth.get_settings()
print(f"Runner: {settings.get('runnerId', 'claude')}, Verbosity: {settings.get('verbosity', 10)}")

# ── Connect to first online device ──────────────────────────────────
online = [d for d in devices if d.get("isOnline")]
if not online:
    print("No online devices")
    sys.exit(1)

target = online[0]
agent_url = os.environ.get("YAVER_URL", f"http://{target['quicHost']}:18080")
print(f"\nConnecting to {target['name']} at {agent_url}...")

client = YaverClient(agent_url, token)
print(f"Ping: {client.ping():.1f}ms")

# ── Task with verbosity ─────────────────────────────────────────────
task = client.create_task("What is the current git branch?", verbosity=3)
print(f"Task {task['id']} created")

# Poll with callback
import time
for _ in range(120):
    detail = client.get_task(task["id"])
    status = detail.get("status", "")
    output_len = len(detail.get("output", ""))
    print(f"  [{status}] output: {output_len} chars")
    if status in ("completed", "failed", "stopped"):
        break
    time.sleep(0.5)

# List tasks
tasks = client.list_tasks()
print(f"\nAll tasks ({len(tasks)}):")
for t in tasks:
    print(f"  {t['id']} — {t['title'][:40]} ({t['status']})")

# Clean up
client.delete_task(task["id"])
print("Done.")
