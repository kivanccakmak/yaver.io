#!/usr/bin/env python3
"""Check Google Play Console for existing apps and try to create an edit for Yaver."""

import os
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

KEY_FILE = os.environ.get("PLAY_STORE_KEY_FILE", "")
SCOPES = ["https://www.googleapis.com/auth/androidpublisher"]

credentials = Credentials.from_service_account_file(KEY_FILE, scopes=SCOPES)
service = build("androidpublisher", "v3", credentials=credentials)

# Try to list what we can access
# The API doesn't have a "list apps" endpoint, but let's try known packages
packages = ["io.yaver.mobile", "works.talos.mobile"]

for pkg in packages:
    try:
        edit = service.edits().insert(body={}, packageName=pkg).execute()
        print(f"✓ {pkg} - accessible (edit: {edit['id']})")
        # Clean up - delete the edit
        service.edits().delete(packageName=pkg, editId=edit['id']).execute()
    except Exception as e:
        print(f"✗ {pkg} - {e}")
