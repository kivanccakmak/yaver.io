#!/usr/bin/env python3
"""Upload screenshots to Google Play Store listing.

Uploads phone screenshots from scripts/screenshots/output/ and
tablet screenshots from scripts/screenshots/output-ipad/.

Requirements: pip install google-auth google-api-python-client
"""

import os
import sys
from pathlib import Path
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

PACKAGE = "io.yaver.mobile"
KEY_FILE = os.environ.get("PLAY_STORE_KEY_FILE", "")
SCOPES = ["https://www.googleapis.com/auth/androidpublisher"]
LANGUAGE = "en-US"

SCRIPT_DIR = Path(__file__).resolve().parent
PHONE_DIR = SCRIPT_DIR / "screenshots" / "output"
TABLET_DIR = SCRIPT_DIR / "screenshots" / "output-ipad"

# Google Play screenshot types
SCREENSHOT_TYPES = [
    ("phoneScreenshots", PHONE_DIR),
    ("tenInchScreenshots", TABLET_DIR),
]


def main():
    print(f"Uploading screenshots for {PACKAGE}...")

    credentials = Credentials.from_service_account_file(KEY_FILE, scopes=SCOPES)
    service = build("androidpublisher", "v3", credentials=credentials)
    edits = service.edits()

    edit = edits.insert(body={}, packageName=PACKAGE).execute()
    edit_id = edit["id"]
    print(f"Created edit: {edit_id}")

    try:
        for image_type, directory in SCREENSHOT_TYPES:
            if not directory.exists():
                print(f"  Skipping {image_type}: {directory} not found")
                continue

            pngs = sorted(directory.glob("*.png"))
            if not pngs:
                print(f"  Skipping {image_type}: no PNGs in {directory}")
                continue

            # Delete existing screenshots first
            try:
                edits.images().deleteall(
                    packageName=PACKAGE,
                    editId=edit_id,
                    language=LANGUAGE,
                    imageType=image_type,
                ).execute()
                print(f"  Cleared existing {image_type}")
            except Exception:
                pass

            # Upload new ones
            for png in pngs:
                media = MediaFileUpload(str(png), mimetype="image/png")
                edits.images().upload(
                    packageName=PACKAGE,
                    editId=edit_id,
                    language=LANGUAGE,
                    imageType=image_type,
                    media_body=media,
                ).execute()
                print(f"  Uploaded {image_type}: {png.name}")

        # For draft apps, we must ensure all releases are set to draft status
        # Remove completed releases and keep only draft ones
        try:
            track = edits.tracks().get(
                packageName=PACKAGE, editId=edit_id, track="internal"
            ).execute()
            # Keep only draft releases
            draft_releases = [r for r in track.get("releases", []) if r.get("status") == "draft"]
            track["releases"] = draft_releases
            edits.tracks().update(
                packageName=PACKAGE, editId=edit_id, track="internal", body=track
            ).execute()
        except Exception as e:
            print(f"  Track update note: {e}")

        edits.commit(packageName=PACKAGE, editId=edit_id).execute()
        print("Edit committed. Screenshots uploaded!")

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        try:
            edits.delete(packageName=PACKAGE, editId=edit_id).execute()
            print("Edit rolled back.")
        except Exception:
            pass
        sys.exit(1)


if __name__ == "__main__":
    main()
