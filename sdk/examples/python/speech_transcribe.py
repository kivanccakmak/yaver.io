"""Speech example — transcribe audio file using cloud STT provider."""
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../python"))
from yaver import YaverClient

url = os.environ.get("YAVER_URL", "http://localhost:18080")
token = os.environ.get("YAVER_TOKEN", "")
openai_key = os.environ.get("OPENAI_API_KEY", "")

if not token:
    print("Set YAVER_TOKEN env var")
    sys.exit(1)

client = YaverClient(url, token)

# Create task with speech context
task = client.create_task(
    "Refactor the auth module to use refresh tokens",
    verbosity=5,  # moderate detail
)
print(f"Task {task['id']} created")

# Stream
for chunk in client.stream_output(task["id"]):
    print(chunk, end="")

print("\nDone.")
