"""Tests for the Yaver Python SDK (HTTP mode)."""
import json
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from unittest import TestCase, main

import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from yaver import YaverClient


class MockAgentHandler(BaseHTTPRequestHandler):
    """Mock Yaver agent for testing."""

    def do_GET(self):
        if self.path == "/health":
            self._json({"status": "ok"})
        elif self.path == "/tasks":
            self._json({"ok": True, "tasks": [
                {"id": "t1", "title": "Test", "status": "completed", "createdAt": "2026-01-01T00:00:00Z"},
            ]})
        elif self.path.startswith("/tasks/"):
            task_id = self.path.split("/")[-1]
            self._json({"ok": True, "task": {
                "id": task_id, "title": "Test", "status": "completed",
                "resultText": "Done", "output": "line1\nline2", "createdAt": "2026-01-01T00:00:00Z",
            }})
        elif self.path == "/info":
            self._json({"ok": True, "info": {
                "hostname": "test-machine", "platform": "darwin",
                "agentVersion": "1.39.0", "runningTasks": 0, "totalTasks": 1,
            }})
        else:
            self.send_error(404)

    def do_POST(self):
        content_len = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}

        if self.path == "/tasks":
            self._json({"ok": True, "taskId": "new-task", "status": "queued", "runnerId": "claude"})
        elif self.path.endswith("/stop"):
            self._json({"ok": True})
        elif self.path.endswith("/continue"):
            self._json({"ok": True})
        else:
            self.send_error(404)

    def do_DELETE(self):
        self._json({"ok": True})

    def _json(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, format, *args):
        pass  # Suppress logging


class TestYaverClient(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), MockAgentHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.client = YaverClient(f"http://127.0.0.1:{cls.port}", "test-token")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_health(self):
        result = self.client.health()
        self.assertEqual(result["status"], "ok")

    def test_ping(self):
        rtt = self.client.ping()
        self.assertGreater(rtt, 0)

    def test_info(self):
        result = self.client.info()
        info = result.get("info", result)
        self.assertEqual(info["hostname"], "test-machine")
        self.assertEqual(info["agentVersion"], "1.39.0")

    def test_create_task(self):
        task = self.client.create_task("Fix bug")
        self.assertEqual(task["id"], "new-task")
        self.assertEqual(task["status"], "queued")

    def test_create_task_with_verbosity(self):
        task = self.client.create_task("Fix bug", verbosity=3)
        self.assertEqual(task["id"], "new-task")

    def test_get_task(self):
        task = self.client.get_task("t1")
        self.assertEqual(task["id"], "t1")
        self.assertEqual(task["status"], "completed")

    def test_list_tasks(self):
        tasks = self.client.list_tasks()
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["id"], "t1")

    def test_stop_task(self):
        self.client.stop_task("t1")  # Should not raise

    def test_delete_task(self):
        self.client.delete_task("t1")  # Should not raise

    def test_continue_task(self):
        self.client.continue_task("t1", "Follow up")  # Should not raise

    def test_stream_output(self):
        lines = list(self.client.stream_output("t1", poll_interval=0.01))
        self.assertTrue(len(lines) > 0)


if __name__ == "__main__":
    main()
