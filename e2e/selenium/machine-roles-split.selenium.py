#!/usr/bin/env python3
"""Closed-loop Selenium smoke for runner/render machine-role slicing.

This is intentionally live and API-first:

1. Resolve the Ubuntu runner + Mac mini renderer from /devices/list.
2. Save the split via POST /settings machineRolesForProject.
3. Read /settings back and verify the persisted row.
4. Probe each role device through the relay with X-Relay-Password.
5. Open the real dashboard in Chrome and verify both devices are visible.

Env:
  YAVER_TEST_TOKEN          optional; falls back to ~/.yaver/config.json
  YAVER_CONVEX_SITE         optional; falls back to ~/.yaver/config.json
  E2E_BASE_URL              default https://yaver.io
  E2E_RUNNER_DEVICE         deviceId/name substring; default runner-box
  E2E_RENDER_DEVICE         deviceId/name substring; default render-mini
  E2E_EXPECT_RENDER_READY   default 1. Set 0 when reproducing a named outage.
  E2E_HEADLESS              default 1
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


def load_local_config() -> dict:
    path = Path.home() / ".yaver" / "config.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text())


CFG = load_local_config()
TOKEN = os.environ.get("YAVER_TEST_TOKEN") or os.environ.get("E2E_USER_TOKEN") or CFG.get("auth_token", "")
CONVEX = (os.environ.get("YAVER_CONVEX_SITE") or CFG.get("convex_site_url", "")).rstrip("/")
BASE_URL = (os.environ.get("E2E_BASE_URL") or "https://yaver.io").rstrip("/")
RUNNER_HINT = os.environ.get("E2E_RUNNER_DEVICE") or "runner-box"
RENDER_HINT = os.environ.get("E2E_RENDER_DEVICE") or "render-mini"
EXPECT_RENDER_READY = os.environ.get("E2E_EXPECT_RENDER_READY", "1") != "0"


def fail(msg: str) -> None:
    print(f"[selenium] FAIL {msg}", file=sys.stderr)
    raise SystemExit(1)


def request(method: str, path_or_url: str, body: dict | None = None, headers: dict | None = None, timeout: int = 20):
    if not TOKEN:
        fail("missing YAVER_TEST_TOKEN and ~/.yaver/config.json auth_token")
    if not CONVEX and not path_or_url.startswith("http"):
        fail("missing YAVER_CONVEX_SITE and ~/.yaver/config.json convex_site_url")
    url = path_or_url if path_or_url.startswith("http") else f"{CONVEX}{path_or_url}"
    data = json.dumps(body).encode() if body is not None else None
    req_headers = {"Authorization": f"Bearer {TOKEN}", **(headers or {})}
    if body is not None:
        req_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read()
        return res.status, json.loads(raw or b"{}")


def resolve_device(devices: list[dict], hint: str) -> dict:
    h = hint.lower()
    matches = [
        d
        for d in devices
        if d.get("deviceId") == hint
        or d.get("deviceId", "").startswith(hint)
        or h in d.get("name", "").lower()
        or h in d.get("alias", "").lower()
    ]
    if len(matches) != 1:
        labels = ", ".join(f"{d.get('name')}:{d.get('deviceId', '')[:8]}" for d in matches)
        fail(f"{hint!r} resolved to {len(matches)} devices: {labels}")
    return matches[0]


def relay_probe(device_id: str, relay_password: str) -> tuple[bool, str]:
    url = f"https://public.yaver.io/d/{device_id}/info"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {TOKEN}", "X-Relay-Password": relay_password},
    )
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=12) as res:
            return True, f"HTTP {res.status} in {int((time.time() - started) * 1000)}ms"
    except urllib.error.HTTPError as exc:
        detail = exc.read(240).decode("utf-8", "replace").strip()
        return False, f"HTTP {exc.code}: {detail}"
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"


def main() -> None:
    _, listed = request("GET", "/devices/list")
    devices = listed.get("devices") or []
    runner = resolve_device(devices, RUNNER_HINT)
    render = resolve_device(devices, RENDER_HINT)
    print(f"[selenium] runner={runner['name']} {runner['deviceId'][:8]}")
    print(f"[selenium] render={render['name']} {render['deviceId'][:8]}")

    row = {
        "runnerDeviceId": runner["deviceId"],
        "renderDeviceId": render["deviceId"],
        "workspace": "runner-clone",
        "autoPush": "always",
        "updatedAt": int(time.time() * 1000),
    }
    request("POST", "/settings", {"machineRolesForProject": row})
    _, settings_res = request("GET", "/settings")
    settings = settings_res.get("settings") or {}
    rows = settings.get("machineRolesByProject") or []
    saved = next((r for r in rows if not r.get("projectName") and r.get("runnerDeviceId")), None)
    if not saved:
        fail("machineRolesByProject favorite row missing after save")
    if saved.get("runnerDeviceId") != runner["deviceId"] or saved.get("renderDeviceId") != render["deviceId"]:
        fail(f"saved row mismatch: {saved}")
    relay_password = settings.get("relayPassword") or CFG.get("relay_password") or CFG.get("cached_relay_password")
    if not relay_password:
        fail("settings did not provide relayPassword")

    runner_ok, runner_detail = relay_probe(runner["deviceId"], relay_password)
    render_ok, render_detail = relay_probe(render["deviceId"], relay_password)
    print(f"[selenium] runner relay probe: {runner_detail}")
    print(f"[selenium] render relay probe: {render_detail}")
    if not runner_ok:
        fail(f"runner device is not reachable through relay: {runner_detail}")
    if EXPECT_RENDER_READY and not render_ok:
        fail(f"render device is not reachable through relay: {render_detail}")

    opts = Options()
    if os.environ.get("E2E_HEADLESS", "1") != "0":
        opts.add_argument("--headless=new")
    opts.add_argument("--window-size=1440,1000")
    driver = webdriver.Chrome(options=opts)
    try:
        driver.get(f"{BASE_URL}/dashboard")
        driver.execute_script(
            "localStorage.setItem('yaver_auth_token', arguments[0]);"
            "document.cookie = 'yaver_auth_token=' + arguments[0] + '; path=/; max-age=2592000; samesite=lax';",
            TOKEN,
        )
        driver.get(f"{BASE_URL}/dashboard")
        wait = WebDriverWait(driver, 45)
        wait.until(lambda d: runner["name"].lower() in d.find_element(By.TAG_NAME, "body").text.lower())
        wait.until(lambda d: render["name"].lower() in d.find_element(By.TAG_NAME, "body").text.lower())
        print("[selenium] dashboard rendered both role devices")
    except Exception:
        shot = "/tmp/yaver-machine-roles-selenium-failure.png"
        driver.save_screenshot(shot)
        print(f"[selenium] screenshot: {shot}", file=sys.stderr)
        raise
    finally:
        driver.quit()

    print("[selenium] PASS machine-role split closed loop")


if __name__ == "__main__":
    main()
