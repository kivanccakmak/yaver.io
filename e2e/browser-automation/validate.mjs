import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const collections = [
  {
    name: "test case",
    dir: path.join(root, "test-cases"),
    fields: ["Case ID", "Status", "Added", "Surface", "Target", "Device"],
    statuses: new Set(["queued", "running", "passed", "failed", "blocked"]),
    headings: ["Headless prerequisite", "Preconditions", "Browser arc", "Assertions", "Negative control", "Evidence requested"],
  },
  {
    name: "result",
    dir: path.join(root, "results"),
    fields: ["Result ID", "Case ID", "Status", "Run at", "Commit", "Surface", "Device", "Profile"],
    statuses: new Set(["passed", "failed", "blocked"]),
    headings: ["Headless result", "Closed-loop result", "Evidence", "Failure and route to fix"],
  },
];

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const fieldPattern = /^- ([A-Za-z ]+):\s*`?([^`\n]+)`?\s*$/gm;
const privatePatterns = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "private key" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/i, label: "bearer credential" },
  { pattern: /(?:token|api[_-]?key|password)=((?!\[redacted\]|<redacted>)[^\s&)]+)/i, label: "credential value" },
  { pattern: /\/Users\/[A-Za-z0-9._-]+\//, label: "absolute macOS home path" },
  { pattern: /\/(?:home|root)\/[A-Za-z0-9._-]+\//, label: "absolute Linux home path" },
];

const seenIds = new Map();
const errors = [];
let fileCount = 0;

for (const collection of collections) {
  let dates = [];
  try {
    dates = await fs.readdir(collection.dir, { withFileTypes: true });
  } catch (error) {
    errors.push(`${collection.name}: cannot read ${path.relative(root, collection.dir)}: ${error.message}`);
    continue;
  }

  for (const dateEntry of dates) {
    if (!dateEntry.isDirectory()) {
      errors.push(`${collection.name}: ${dateEntry.name} must be inside a YYYY-MM-DD directory`);
      continue;
    }
    if (!datePattern.test(dateEntry.name)) {
      errors.push(`${collection.name}: invalid date directory ${dateEntry.name}`);
      continue;
    }

    const dateDir = path.join(collection.dir, dateEntry.name);
    const entries = await fs.readdir(dateDir, { withFileTypes: true });
    for (const entry of entries) {
      const relative = path.relative(root, path.join(dateDir, entry.name));
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        errors.push(`${collection.name}: ${relative} must be a Markdown file`);
        continue;
      }
      fileCount += 1;
      const body = await fs.readFile(path.join(dateDir, entry.name), "utf8");
      const fields = new Map([...body.matchAll(fieldPattern)].map((match) => [match[1], match[2].trim()]));

      for (const field of collection.fields) {
        if (!fields.has(field)) errors.push(`${relative}: missing field ${field}`);
      }
      const status = fields.get("Status");
      if (status && !collection.statuses.has(status)) errors.push(`${relative}: invalid status ${status}`);
      for (const heading of collection.headings) {
        if (!body.includes(`## ${heading}`)) errors.push(`${relative}: missing heading ${heading}`);
      }

      const primaryId = fields.get(collection.name === "result" ? "Result ID" : "Case ID");
      if (primaryId) {
        if (seenIds.has(primaryId)) errors.push(`${relative}: duplicate ID also used by ${seenIds.get(primaryId)}`);
        else seenIds.set(primaryId, relative);
      }
      for (const { pattern, label } of privatePatterns) {
        if (pattern.test(body)) errors.push(`${relative}: possible ${label}; redact it`);
      }
    }
  }
}

if (errors.length) {
  console.error(`browser queue invalid (${errors.length} issue${errors.length === 1 ? "" : "s"}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`browser queue valid: ${fileCount} dated Markdown file${fileCount === 1 ? "" : "s"}`);
