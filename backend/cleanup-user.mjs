#!/usr/bin/env node
/**
 * Remove specific user data from Convex (users, sessions, devices).
 *
 * Usage:
 *   cd backend && node cleanup-user.mjs                  # dry-run
 *   cd backend && node cleanup-user.mjs --confirm        # actually delete
 *   CONVEX_URL=<url> node cleanup-user.mjs --confirm     # target specific deployment
 *
 * Only deletes data for the emails listed in EMAILS below.
 */

import { ConvexHttpClient } from "convex/browser";
import { api } from "./convex/_generated/api.js";

const EMAILS = [
  "kivanc.cakmak@simkab.com",
  "kivanccakmak@gmail.com",
  "kivanc.cakmak@icloud.com",
];

const CONVEX_URL =
  process.env.CONVEX_URL ||
  "https://shocking-echidna-394.eu-west-1.convex.cloud";

const dryRun = !process.argv.includes("--confirm");

async function run() {
  const client = new ConvexHttpClient(CONVEX_URL);

  console.log(`Target: ${CONVEX_URL}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (pass --confirm to delete)" : "DELETING"}`);
  console.log(`Emails: ${EMAILS.join(", ")}\n`);

  for (const email of EMAILS) {
    console.log(`--- ${email} ---`);

    const users = await client.query(api.admin.getUsersByEmail, { email });

    if (!users || users.length === 0) {
      console.log("  No user found.\n");
      continue;
    }

    for (const user of users) {
      console.log(`  User: ${user._id} (${user.fullName}, provider: ${user.provider})`);
      console.log(`  Created: ${new Date(user.createdAt).toISOString()}`);

      if (!dryRun) {
        const result = await client.mutation(api.admin.deleteUserData, { userId: user._id });
        console.log(`  Deleted: ${result.sessionsDeleted} sessions, ${result.devicesDeleted} devices, 1 user`);
      } else {
        console.log("  (would delete user + all sessions + all devices)");
      }
    }
    console.log();
  }

  console.log(dryRun ? "Dry run complete. Pass --confirm to actually delete." : "Done.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
