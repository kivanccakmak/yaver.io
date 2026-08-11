#!/usr/bin/env python3
"""Upload one or more AABs to a Google Play track.

Multi-tenant: PLAY_PACKAGE_NAME + PLAY_TRACK are env-overridable so the
SAME helper ships a CUSTOMER's app to THEIR package/track (driven by the
generated deploy script), not just Yaver's own. Defaults preserve the
original Yaver self-deploy behaviour (io.yaver.mobile, internal track).
"""

import os
import re
import shutil
import socket
import subprocess
import sys
import zipfile

# Large AABs on slow links run past httplib2's default (~60s) socket timeout.
# Setting this BEFORE importing google clients so their httplib2.Http picks it up.
socket.setdefaulttimeout(int(os.environ.get("PLAY_UPLOAD_SOCKET_TIMEOUT", "1800")))

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

# Package + track are env-overridable for multi-tenant customer deploys;
# defaults keep Yaver's own self-deploy working unchanged.
PACKAGE = os.environ.get("PLAY_PACKAGE_NAME", "io.yaver.mobile")
KEY_FILE = os.environ.get("PLAY_STORE_KEY_FILE", "")
AAB_PATH = os.path.join(os.path.dirname(__file__), "..", "mobile", "android", "app", "build", "outputs", "bundle", "release", "app-release.aab")
AAB_PATH = os.environ.get("AAB_PATH", AAB_PATH)
AAB_PATHS = [p.strip() for p in os.environ.get("AAB_PATHS", AAB_PATH).split(",") if p.strip()]
# internal | alpha | beta | production (Google Play track names).
TRACK = os.environ.get("PLAY_TRACK", "internal")
RELEASE_STATUS = os.environ.get("PLAY_RELEASE_STATUS", "draft")

SCOPES = ["https://www.googleapis.com/auth/androidpublisher"]

def extract_aab_version_code(aab_path: str):
    """Best-effort versionCode for a build, read from the AAB's own manifest.

    An AAB is a zip; the merged manifest at base/manifest/AndroidManifest.xml
    is BINARY Android XML, so the plain-text `android:versionCode="N"` regex
    only matches when the manifest happens to be text (rare). Returns the int
    when readable, else None — callers then fall back to the build.gradle
    versionCode (read_gradle_version_code) and finally to Play's own 403.
    """
    try:
        with zipfile.ZipFile(aab_path) as z:
            mn = "base/manifest/AndroidManifest.xml"
            if mn not in z.namelist():
                return None
            data = z.read(mn).decode("utf-8", errors="replace")
            m = re.search(r'android:versionCode="(\d+)"', data)
            if m:
                return int(m.group(1))
            # Binary XML: versionCode is a 4-byte little-endian int that sits
            # near the 'versionCode' attr name in the string pool. Fragile —
            # prefer gradle, but try once.
            raw = z.read(mn)
            idx = raw.find(b"versionCode")
            if idx >= 0 and idx + 16 <= len(raw):
                candidate = int.from_bytes(raw[idx + 8:idx + 12], "little")
                if 0 < candidate < 10000000:
                    return candidate
            return None
    except Exception:
        return None


def read_gradle_version_code(gradle_path: str):
    """versionCode from an app/build.gradle (the value the AAB was built with).

    Every Yaver Android surface (phone, wear, tv, xr, auto) derives its
    versionCode from mobile/android/app/build.gradle, so this is the same
    number Play sees. Returns int or None.
    """
    try:
        with open(gradle_path, "r", encoding="utf-8") as f:
            m = re.search(r"versionCode\s+(\d+)", f.read())
            return int(m.group(1)) if m else None
    except Exception:
        return None


def main():
    print(f"Uploading {len(AAB_PATHS)} AAB(s) to Google Play ({PACKAGE}) - {TRACK} track...", flush=True)

    credentials = Credentials.from_service_account_file(KEY_FILE, scopes=SCOPES)
    service = build("androidpublisher", "v3", credentials=credentials)

    # Create an edit
    edit = service.edits().insert(body={}, packageName=PACKAGE).execute()
    edit_id = edit["id"]
    print(f"Created edit: {edit_id}", flush=True)

    # Pre-flight versionCode collision check (2026-08-11, Wear 298 / TV 300 /
    # XR 301 on the SAME io.yaver.mobile package). Play rejects a versionCode
    # already used on ANY track with a bare 403 "Version code N has already
    # been used" — after a 300MB upload. Asking the API upfront turns that
    # into a named, actionable message before a single byte goes up.
    try:
        app_edit = service.edits().get(
            packageName=PACKAGE, editId=edit_id
        ).execute()
    except Exception:
        app_edit = None
    if app_edit:
        highest = 0
        try:
            tracks = service.edits().tracks().list(
                packageName=PACKAGE, editId=edit_id
            ).execute().get("tracks", [])
            for tr in tracks:
                for rel in tr.get("releases", []):
                    for code in rel.get("versionCodes", []):
                        if isinstance(code, int) and code > highest:
                            highest = code
        except Exception:
            highest = 0
        for aab_path in AAB_PATHS:
            code = extract_aab_version_code(aab_path)
            if code is None:
                # Binary manifests defeat the zip reader; the AAB was built
                # from mobile/android/app/build.gradle, so read that.
                gradle_path = os.path.join(
                    os.path.dirname(aab_path), "..", "..", "..", "..",
                    "mobile", "android", "app", "build.gradle")
                code = read_gradle_version_code(gradle_path)
            if code is None:
                print(
                    f"note: could not read versionCode from {aab_path} "
                    f"(binary manifest, no gradle) — skipping pre-flight check; "
                    f"Play's 403 will catch a collision.",
                    flush=True,
                )
                continue
            if 0 < highest and code <= highest:
                print(
                    f"VERSION CODE COLLISION: {aab_path} carries versionCode {code}, "
                    f"but {highest} is already used on the {TRACK} track of {PACKAGE}. "
                    f"Play refuses re-uploaded codes. Bump the app's versionCode "
                    f"above {highest} (e.g. to {highest + 1}) and rebuild before "
                    f"uploading — this script never rewrites your build.",
                    flush=True,
                )
                raise SystemExit(2)
            if highest == 0:
                print(
                    f"note: no prior versionCodes found on {TRACK} — first upload "
                    f"(or read-only access); proceeding with {code}.",
                    flush=True,
                )

    version_codes = []
    for aab_path in AAB_PATHS:
        # Upload AAB in 5 MB chunks so we can report progress and tolerate transient stalls.
        size = os.path.getsize(aab_path)
        print(f"AAB: {aab_path}", flush=True)
        print(f"AAB size: {size / 1024 / 1024:.1f} MB", flush=True)
        media = MediaFileUpload(
            aab_path,
            mimetype="application/octet-stream",
            resumable=True,
            chunksize=5 * 1024 * 1024,
        )
        request = service.edits().bundles().upload(
            packageName=PACKAGE,
            editId=edit_id,
            media_body=media,
        )
        response = None
        while response is None:
            status, response = request.next_chunk()
            if status:
                pct = status.resumable_progress * 100 // max(1, size)
                print(f"  upload progress: {pct:3d}% ({status.resumable_progress} / {size} bytes)", flush=True)
        bundle = response
        version_code = str(bundle["versionCode"])
        version_codes.append(version_code)
        print(f"Uploaded bundle: versionCode={version_code}", flush=True)

    # Assign to internal track
    service.edits().tracks().update(
        packageName=PACKAGE,
        editId=edit_id,
        track=TRACK,
        body={
            "track": TRACK,
            "releases": [{
                "versionCodes": version_codes,
                "status": RELEASE_STATUS,
            }],
        }
    ).execute()
    print(f"Assigned versionCodes={','.join(version_codes)} to {TRACK} track with status={RELEASE_STATUS}", flush=True)

    # Commit the edit
    service.edits().commit(packageName=PACKAGE, editId=edit_id).execute()
    print(f"Edit committed! Builds {','.join(version_codes)} are on {TRACK} track.", flush=True)

    # Best-effort local-Mac cache bookkeeping. This script lives only in
    # ~/.local/bin on the dev machine; on CI runners it isn't on PATH, and a
    # bare subprocess.run() raises FileNotFoundError (check=False suppresses
    # exit codes, not spawn failures) — which would fail the job *after* the
    # upload already committed. Resolve it first and never let it be fatal.
    cleanup = shutil.which("mobile-cache-cleanup.sh")
    if cleanup:
        try:
            subprocess.run([cleanup, "mark-deployed", "yaver"], check=False)
        except OSError as exc:
            print(f"(skipped cache cleanup: {exc})")

if __name__ == "__main__":
    main()
