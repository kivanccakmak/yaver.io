"""Basic client — connect to agent, create task, stream output."""
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../python"))
from yaver import YaverClient

url = os.environ.get("YAVER_URL", "http://localhost:18080")
token = os.environ.get("YAVER_TOKEN", "")
if not token:
    print("Set YAVER_TOKEN env var")
    sys.exit(1)

client = YaverClient(url, token)

# Health check
print("Health:", client.health())
print(f"Ping: {client.ping():.1f}ms")

# Create task
task = client.create_task("List all Python files in the current directory")
print(f"Task {task['id']} created (status: {task['status']})\n")

# Stream output
for chunk in client.stream_output(task["id"]):
    print(chunk, end="")

# Final result
final = client.get_task(task["id"])
print(f"\n\nTask finished (status: {final['status']})")
