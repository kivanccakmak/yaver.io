#!/usr/bin/env python3
"""Set Google Play Store listing for Yaver (io.yaver.mobile).

Updates the default (en-US) store listing with title, descriptions,
contact info, and release notes for the latest production track release.

Idempotent: safe to run multiple times. Each run creates a fresh edit,
applies all listing data, and commits.

Requirements: pip install google-auth google-api-python-client
"""

import sys
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

PACKAGE = "io.yaver.mobile"
KEY_FILE = "/Users/kivanccakmak/Workspace/talos/play-upload-key-elevathor.json"
SCOPES = ["https://www.googleapis.com/auth/androidpublisher"]

LANGUAGE = "en-US"

TITLE = "Yaver \u2014 Code from Your Phone"

SHORT_DESCRIPTION = "Run AI coding agents on your dev machine, directly from your phone."

FULL_DESCRIPTION = """\
Yaver lets developers run AI coding agents on their development machines \u2014 directly from their phone.

Your code never leaves your machine. Tasks flow peer-to-peer between your phone and your dev machine through encrypted connections. Our servers only handle authentication and peer discovery.

HOW IT WORKS
1. Install the Yaver CLI on your dev machine
2. Open the Yaver app on your phone
3. Send coding tasks to your machine from anywhere

FEATURES
\u2022 Run Claude, Codex, Aider, or any custom AI agent
\u2022 Switch between agents per task \u2014 use the best tool for each job
\u2022 Works over Wi-Fi and cellular \u2014 seamless roaming between networks
\u2022 Direct connection when on the same network, relay fallback when remote
\u2022 See real-time output as your agent works
\u2022 Multiple device support \u2014 connect to any of your dev machines

PRIVACY FIRST
\u2022 Your code and task data never touch our servers
\u2022 All communication is end-to-end encrypted
\u2022 Relay servers are pass-through only \u2014 zero data storage
\u2022 Open infrastructure: relay servers, CLI, and networking are transparent

REQUIREMENTS
\u2022 A Mac, Linux, or Windows machine with the Yaver CLI installed
\u2022 An AI agent (Claude Code, OpenAI Codex, Aider, or any CLI-based agent)"""

RELEASE_NOTES = """\
\u2022 Network-aware reconnection \u2014 seamless WiFi to cellular transitions
\u2022 Increased connection resilience with 15 retry attempts
\u2022 Choose your AI agent per task from the app
\u2022 Improved connection stability and error recovery"""

CONTACT_WEBSITE = "https://yaver.io"
CONTACT_EMAIL = "support@yaver.io"


def main():
    print(f"Setting store listing for {PACKAGE} ({LANGUAGE})...")

    credentials = Credentials.from_service_account_file(KEY_FILE, scopes=SCOPES)
    service = build("androidpublisher", "v3", credentials=credentials)
    edits = service.edits()

    # 1. Create an edit
    edit = edits.insert(body={}, packageName=PACKAGE).execute()
    edit_id = edit["id"]
    print(f"Created edit: {edit_id}")

    try:
        # 2. Update store listing (title, short description, full description, contact)
        listing_body = {
            "language": LANGUAGE,
            "title": TITLE,
            "shortDescription": SHORT_DESCRIPTION,
            "fullDescription": FULL_DESCRIPTION,
            "video": "",
        }

        edits.listings().update(
            packageName=PACKAGE,
            editId=edit_id,
            language=LANGUAGE,
            body=listing_body,
        ).execute()
        print(f"Updated listing: title, shortDescription, fullDescription")

        # 3. Update contact info via details endpoint
        try:
            edits.details().update(
                packageName=PACKAGE,
                editId=edit_id,
                body={
                    "contactWebsite": CONTACT_WEBSITE,
                    "contactEmail": CONTACT_EMAIL,
                    "defaultLanguage": LANGUAGE,
                },
            ).execute()
            print(f"Updated details: contactWebsite, contactEmail, defaultLanguage")
        except Exception as e:
            print(f"Warning: could not update details (may need manual setup): {e}")

        # 4. Try to update release notes (may fail on draft apps)
        release_notes_updated = False
        for track_name in ["internal", "alpha", "beta", "production"]:
            try:
                track = edits.tracks().get(
                    packageName=PACKAGE,
                    editId=edit_id,
                    track=track_name,
                ).execute()

                releases = track.get("releases", [])
                if not releases:
                    continue

                # Force all releases to draft and add release notes
                for release in releases:
                    release["releaseNotes"] = [
                        {"language": LANGUAGE, "text": RELEASE_NOTES}
                    ]
                    release["status"] = "draft"

                edits.tracks().update(
                    packageName=PACKAGE,
                    editId=edit_id,
                    track=track_name,
                    body=track,
                ).execute()
                print(f"Updated release notes on '{track_name}' track ({len(releases)} release(s))")
                release_notes_updated = True
                break

            except Exception as e:
                print(f"  Skipping '{track_name}' track: {e}")
                continue

        if not release_notes_updated:
            print("Note: Release notes not updated (will be set when app leaves draft state)")

        # 5. Commit the edit
        try:
            edits.commit(packageName=PACKAGE, editId=edit_id).execute()
            print(f"Edit committed successfully.")
        except Exception as commit_err:
            # If commit fails (e.g. draft app restrictions), retry without track changes
            print(f"  Commit failed: {commit_err}")
            print("  Retrying with listing and details only (no track changes)...")
            try:
                edits.delete(packageName=PACKAGE, editId=edit_id).execute()
            except Exception:
                pass

            # Create a fresh edit with only listing + details
            edit2 = edits.insert(body={}, packageName=PACKAGE).execute()
            edit_id2 = edit2["id"]

            edits.listings().update(
                packageName=PACKAGE, editId=edit_id2, language=LANGUAGE,
                body={"language": LANGUAGE, "title": TITLE,
                      "shortDescription": SHORT_DESCRIPTION,
                      "fullDescription": FULL_DESCRIPTION, "video": ""},
            ).execute()

            edits.details().update(
                packageName=PACKAGE, editId=edit_id2,
                body={"contactWebsite": CONTACT_WEBSITE,
                      "contactEmail": CONTACT_EMAIL,
                      "defaultLanguage": LANGUAGE},
            ).execute()

            edits.commit(packageName=PACKAGE, editId=edit_id2).execute()
            print("  Edit committed (listing + details only).")

    except Exception as e:
        # Clean up the edit on failure
        print(f"Error: {e}", file=sys.stderr)
        try:
            edits.delete(packageName=PACKAGE, editId=edit_id).execute()
            print("Edit rolled back.")
        except Exception:
            pass
        sys.exit(1)

    print()
    print("Store listing updated:")
    print(f"  Title:             {TITLE}")
    print(f"  Short description: {SHORT_DESCRIPTION}")
    print(f"  Full description:  ({len(FULL_DESCRIPTION)} chars)")
    print(f"  Contact website:   {CONTACT_WEBSITE}")
    print(f"  Contact email:     {CONTACT_EMAIL}")
    print(f"  Language:          {LANGUAGE}")


if __name__ == "__main__":
    main()
