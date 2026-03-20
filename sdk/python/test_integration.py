"""Integration tests for the Yaver Python SDK.

Requires a running Yaver agent in dummy mode.
Set YAVER_TEST_URL and YAVER_TEST_TOKEN env vars.

Usage:
    YAVER_TEST_URL=http://localhost:18080 YAVER_TEST_TOKEN=xxx python3 test_integration.py
"""
import os
import sys
import time
from unittest import TestCase, main, skipUnless

sys.path.insert(0, os.path.dirname(__file__))
from yaver import YaverClient

URL = os.environ.get("YAVER_TEST_URL", "")
TOKEN = os.environ.get("YAVER_TEST_TOKEN", "")
HAS_AGENT = bool(URL and TOKEN)


@skipUnless(HAS_AGENT, "YAVER_TEST_URL and YAVER_TEST_TOKEN not set")
class TestIntegration(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = YaverClient(URL, TOKEN)

    def test_01_health(self):
        result = self.client.health()
        self.assertTrue(result.get("ok") or result.get("status") == "ok")

    def test_02_ping(self):
        rtt = self.client.ping()
        self.assertGreater(rtt, 0)
        print(f"  RTT: {rtt:.1f}ms")

    def test_03_info(self):
        result = self.client.info()
        info = result.get("info", result)
        self.assertTrue(info.get("hostname"))
        print(f"  Agent: {info.get('hostname')} v{info.get('agentVersion')}")

    def test_04_task_lifecycle(self):
        # Create
        task = self.client.create_task("Integration test — say hello")
        self.assertTrue(task["id"])
        print(f"  Created task: {task['id']}")

        # Poll until done (max 60s)
        task_id = task["id"]
        status = "queued"
        for _ in range(60):
            detail = self.client.get_task(task_id)
            status = detail.get("status", "")
            if status in ("completed", "failed", "stopped"):
                break
            time.sleep(1)

        self.assertEqual(status, "completed", f"Task status: {status}")
        print(f"  Task completed")

        # List
        tasks = self.client.list_tasks()
        ids = [t["id"] for t in tasks]
        self.assertIn(task_id, ids)

        # Delete
        self.client.delete_task(task_id)
        print(f"  Task deleted")

    def test_05_stream_output(self):
        task = self.client.create_task("Stream test — say hello")
        chunks = []
        for chunk in self.client.stream_output(task["id"], poll_interval=0.5):
            chunks.append(chunk)
            if len(chunks) > 100:
                break  # safety
        self.assertTrue(len(chunks) > 0, "Expected at least one output chunk")
        print(f"  Streamed {len(chunks)} chunks")
        self.client.delete_task(task["id"])

    def test_06_create_with_verbosity(self):
        task = self.client.create_task("Verbosity test", verbosity=2)
        self.assertTrue(task["id"])
        time.sleep(2)
        self.client.stop_task(task["id"])
        self.client.delete_task(task["id"])
        print(f"  Verbosity task OK")


if __name__ == "__main__":
    main(verbosity=2)
