#!/usr/bin/env python3
"""Upload screenshots to App Store Connect and set age rating."""

import json
import os
import sys
import time
from pathlib import Path

import jwt
import requests

API_KEY_ID = os.environ.get("APP_STORE_KEY_ID", "")
ISSUER_ID = os.environ.get("APP_STORE_KEY_ISSUER", "")
API_KEY_PATH = Path(os.environ.get("APP_STORE_KEY_PATH", str(Path.home() / ".appstore/AuthKey.p8")))
BUNDLE_ID = "io.yaver.mobile"
BASE_URL = "https://api.appstoreconnect.apple.com/v1"
LOCALE = "en-US"

SCREENSHOTS_DIR = Path(__file__).parent / "output"

# iPhone 6.7" display type for App Store Connect
DISPLAY_TYPE_67 = "APP_IPHONE_67"
DISPLAY_TYPE_65 = "APP_IPHONE_65"

# Screenshot order
SCREENSHOTS = [
    "01_hero.png",
    "02_tasks.png",
    "03_agents.png",
    "04_devices.png",
    "05_privacy.png",
    "06_live_output.png",
]


def generate_token():
    private_key = API_KEY_PATH.read_text()
    now = int(time.time())
    payload = {"iss": ISSUER_ID, "iat": now, "exp": now + 20 * 60, "aud": "appstoreconnect-v1"}
    return jwt.encode(payload, private_key, algorithm="ES256", headers={"kid": API_KEY_ID})


def headers(content_type="application/json"):
    return {"Authorization": f"Bearer {generate_token()}", "Content-Type": content_type}


def api_get(path, params=None):
    resp = requests.get(f"{BASE_URL}{path}", headers=headers(), params=params)
    if resp.status_code != 200:
        print(f"GET {path} failed ({resp.status_code}): {resp.text}")
        sys.exit(1)
    return resp.json()


def api_post(path, payload):
    resp = requests.post(f"{BASE_URL}{path}", headers=headers(), json=payload)
    if resp.status_code not in (200, 201):
        print(f"POST {path} failed ({resp.status_code}): {resp.text}")
        return None
    return resp.json()


def api_patch(path, payload):
    resp = requests.patch(f"{BASE_URL}{path}", headers=headers(), json=payload)
    if resp.status_code not in (200, 204):
        print(f"PATCH {path} failed ({resp.status_code}): {resp.text}")
        return None
    return resp.json() if resp.status_code == 200 else {}


def find_app():
    data = api_get("/apps", params={"filter[bundleId]": BUNDLE_ID})
    app = data["data"][0]
    print(f"App: {app['attributes']['name']} ({app['id']})")
    return app["id"]


def get_version_localization(app_id):
    versions = api_get(
        f"/apps/{app_id}/appStoreVersions",
        params={"filter[appStoreState]": "PREPARE_FOR_SUBMISSION"}
    )
    ver = versions["data"][0]
    ver_id = ver["id"]
    print(f"Version: {ver['attributes']['versionString']} ({ver['attributes']['appStoreState']})")

    locs = api_get(f"/appStoreVersions/{ver_id}/appStoreVersionLocalizations")
    for loc in locs["data"]:
        if loc["attributes"]["locale"] == LOCALE:
            return loc["id"], ver_id
    print(f"ERROR: No {LOCALE} localization found")
    sys.exit(1)


def create_screenshot_set(loc_id, display_type):
    """Create a screenshot set for the given display type, or return existing."""
    # Check existing
    sets = api_get(f"/appStoreVersionLocalizations/{loc_id}/appScreenshotSets")
    for s in sets["data"]:
        if s["attributes"]["screenshotDisplayType"] == display_type:
            print(f"  Found existing screenshot set for {display_type}: {s['id']}")
            return s["id"]

    # Create new
    payload = {
        "data": {
            "type": "appScreenshotSets",
            "attributes": {"screenshotDisplayType": display_type},
            "relationships": {
                "appStoreVersionLocalization": {
                    "data": {"type": "appStoreVersionLocalizations", "id": loc_id}
                }
            },
        }
    }
    result = api_post("/appScreenshotSets", payload)
    if result:
        set_id = result["data"]["id"]
        print(f"  Created screenshot set for {display_type}: {set_id}")
        return set_id
    return None


def upload_screenshot(set_id, filepath):
    """Upload a single screenshot via the App Store Connect API."""
    filename = filepath.name
    filesize = filepath.stat().st_size

    print(f"  Uploading {filename} ({filesize // 1024} KB)...")

    # 1. Reserve the screenshot
    payload = {
        "data": {
            "type": "appScreenshots",
            "attributes": {
                "fileName": filename,
                "fileSize": filesize,
            },
            "relationships": {
                "appScreenshotSet": {
                    "data": {"type": "appScreenshotSets", "id": set_id}
                }
            },
        }
    }
    result = api_post("/appScreenshots", payload)
    if not result:
        print(f"    Failed to reserve {filename}")
        return False

    screenshot_id = result["data"]["id"]
    upload_ops = result["data"]["attributes"].get("uploadOperations", [])

    if not upload_ops:
        print(f"    No upload operations returned for {filename}")
        return False

    # 2. Upload the binary data
    file_data = filepath.read_bytes()
    for op in upload_ops:
        url = op["url"]
        op_headers = {h["name"]: h["value"] for h in op.get("requestHeaders", [])}
        offset = op.get("offset", 0)
        length = op.get("length", len(file_data))
        chunk = file_data[offset:offset + length]

        resp = requests.put(url, headers=op_headers, data=chunk)
        if resp.status_code not in (200, 201):
            print(f"    Upload chunk failed ({resp.status_code})")
            return False

    # 3. Commit the upload
    import hashlib
    md5 = hashlib.md5(file_data).hexdigest()
    commit_payload = {
        "data": {
            "type": "appScreenshots",
            "id": screenshot_id,
            "attributes": {
                "uploaded": True,
                "sourceFileChecksum": md5,
            },
        }
    }
    result = api_patch(f"/appScreenshots/{screenshot_id}", commit_payload)
    if result is not None:
        print(f"    Uploaded: {filename}")
        return True
    else:
        print(f"    Failed to commit {filename}")
        return False


def set_age_rating(app_id):
    """Set age rating declaration to the lowest ratings (suitable for all ages)."""
    print("\nSetting age rating...")

    # Get the app info
    infos = api_get(f"/apps/{app_id}/appInfos")
    app_info_id = infos["data"][0]["id"]

    # Get age rating declaration
    try:
        decl = api_get(f"/appInfos/{app_info_id}/ageRatingDeclaration")
        decl_id = decl["data"]["id"]
    except Exception:
        print("  Could not find age rating declaration")
        return

    # Set all content descriptors to NONE
    payload = {
        "data": {
            "type": "ageRatingDeclarations",
            "id": decl_id,
            "attributes": {
                "alcoholTobaccoOrDrugUseOrReferences": "NONE",
                "contests": "NONE",
                "gamblingAndContests": False,
                "gambling": False,
                "gamblingSimulated": "NONE",
                "horrorOrFearThemes": "NONE",
                "matureOrSuggestiveThemes": "NONE",
                "medicalOrTreatmentInformation": "NONE",
                "profanityOrCrudeHumor": "NONE",
                "sexualContentGraphicAndNudity": "NONE",
                "sexualContentOrNudity": "NONE",
                "violenceCartoonOrFantasy": "NONE",
                "violenceRealistic": "NONE",
                "violenceRealisticProlongedGraphicOrSadistic": "NONE",
                "unrestrictedWebAccess": False,
                "kidsAgeBand": None,
                "seventeenPlus": False,
            },
        }
    }
    result = api_patch(f"/ageRatingDeclarations/{decl_id}", payload)
    if result is not None:
        print("  Age rating set (4+ / suitable for all ages)")
    else:
        print("  WARNING: Could not set age rating")


def main():
    print("=" * 60)
    print("Yaver — Upload Screenshots & Set Age Rating")
    print("=" * 60)
    print()

    app_id = find_app()
    loc_id, ver_id = get_version_localization(app_id)

    # Set age rating
    set_age_rating(app_id)

    # Upload screenshots for iPhone 6.7"
    print(f"\nUploading screenshots for {DISPLAY_TYPE_67}...")
    set_id_67 = create_screenshot_set(loc_id, DISPLAY_TYPE_67)
    if not set_id_67:
        print("ERROR: Could not create screenshot set")
        sys.exit(1)

    success = 0
    for name in SCREENSHOTS:
        filepath = SCREENSHOTS_DIR / name
        if not filepath.exists():
            print(f"  Skipping {name} (not found)")
            continue
        if upload_screenshot(set_id_67, filepath):
            success += 1

    print(f"\n{'=' * 60}")
    print(f"Uploaded {success}/{len(SCREENSHOTS)} screenshots to {DISPLAY_TYPE_67}")

    # Also create 6.5" set with same images (they're close enough in aspect ratio)
    print(f"\nUploading screenshots for {DISPLAY_TYPE_65}...")
    set_id_65 = create_screenshot_set(loc_id, DISPLAY_TYPE_65)
    if set_id_65:
        success_65 = 0
        for name in SCREENSHOTS:
            filepath = SCREENSHOTS_DIR / name
            if not filepath.exists():
                continue
            if upload_screenshot(set_id_65, filepath):
                success_65 += 1
        print(f"Uploaded {success_65}/{len(SCREENSHOTS)} screenshots to {DISPLAY_TYPE_65}")

    print(f"\n{'=' * 60}")
    print("DONE. Check App Store Connect to verify screenshots and submit.")
    print("=" * 60)


if __name__ == "__main__":
    main()
