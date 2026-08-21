#!/usr/bin/env python3
"""Promote an already-uploaded Play versionCode to a target track.

A "promote" does NOT re-upload the AAB — it assigns an existing versionCode to
the target track (alpha / beta / production) and commits the edit, exactly what
the Play Console "Promote release" button does. Same edits+commit path and the
same multi-tenant env overrides as upload-playstore.py.

Env:
  PLAY_PACKAGE_NAME      default io.yaver.mobile
  PLAY_STORE_KEY_FILE    service-account JSON (default keys/google-play-service-account.json)
  PLAY_VERSION_CODE      required — the versionCode already on some track to promote
  PLAY_TARGET_TRACK      required — internal | alpha | beta | production
  PLAY_RELEASE_STATUS    default completed (100% rollout; matches internal-testing)
  PLAY_RELEASE_NOTES     optional "lang: text" pairs joined by |, e.g. "en-US: Tablet studio"
"""

import os
import sys

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

PACKAGE = os.environ.get("PLAY_PACKAGE_NAME", "io.yaver.mobile")
KEY_FILE = os.environ.get("PLAY_STORE_KEY_FILE", "keys/google-play-service-account.json")
VERSION_CODE = os.environ.get("PLAY_VERSION_CODE", "")
TARGET_TRACK = os.environ.get("PLAY_TARGET_TRACK", "")
STATUS = os.environ.get("PLAY_RELEASE_STATUS", "completed")
NOTES = os.environ.get("PLAY_RELEASE_NOTES", "")


def main() -> int:
    if not VERSION_CODE:
        print("ERROR: PLAY_VERSION_CODE is required (the versionCode to promote).", file=sys.stderr)
        return 2
    if TARGET_TRACK not in ("internal", "alpha", "beta", "production"):
        print(f"ERROR: PLAY_TARGET_TRACK must be internal|alpha|beta|production (got '{TARGET_TRACK}').", file=sys.stderr)
        return 2
    if not os.path.exists(KEY_FILE):
        print(f"ERROR: service-account key not found at {KEY_FILE}.", file=sys.stderr)
        print("Place it at keys/google-play-service-account.json or set PLAY_STORE_KEY_FILE.", file=sys.stderr)
        return 2

    creds = Credentials.from_service_account_file(KEY_FILE, scopes=["https://www.googleapis.com/auth/androidpublisher"])
    svc = build("androidpublisher", "v3", credentials=creds)
    edit = svc.edits().insert(body={}, packageName=PACKAGE).execute()
    edit_id = edit["id"]

    release = {"versionCodes": [int(VERSION_CODE)], "status": STATUS, "name": f"v{VERSION_CODE}"}
    if NOTES:
        pairs = [p.split(":", 1) for p in NOTES.split("|") if ":" in p]
        release["releaseNotes"] = [{"language": lang.strip(), "text": text.strip()} for lang, text in pairs]

    svc.edits().tracks().update(
        packageName=PACKAGE,
        editId=edit_id,
        track=TARGET_TRACK,
        body={"track": TARGET_TRACK, "releases": [release]},
    ).execute()
    try:
        svc.edits().commit(packageName=PACKAGE, editId=edit_id).execute()
    except Exception as exc:  # noqa: BLE001 - surface the exact API message
        msg = str(exc)
        if "health" in msg.lower():
            print("DECLARATION_BLOCKED: Play refused the commit:", file=sys.stderr)
            print("  " + msg, file=sys.stderr)
            print("Fix: Play Console -> Monitor and improve -> Policy -> App content -> Health apps -> Save", file=sys.stderr)
            print("(re-confirm the declaration), then re-run this promote.", file=sys.stderr)
            return 1
        print(f"COMMIT_FAILED: {msg}", file=sys.stderr)
        return 1

    print(f"OK: versionCode {VERSION_CODE} promoted to {TARGET_TRACK} ({STATUS}) on {PACKAGE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
