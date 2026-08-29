import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const requireText = (source, expected, label) => {
  if (!source.includes(expected)) {
    throw new Error(label + " is missing: " + expected);
  }
};

const sitemap = read("app/sitemap.ts");
for (const route of ["/pricing", "/remote-ai-coding-agent", "/about", "/docs/mcp", "/manuals/free-onprem", "/manuals/local-llm"]) {
  requireText(sitemap, route, "sitemap");
}

const robots = read("public/robots.txt");
for (const agent of ["OAI-SearchBot", "ChatGPT-User", "Claude-SearchBot", "Claude-User"]) {
  requireText(robots, agent, "robots policy");
}
for (const path of ["/api/", "/auth/", "/dashboard/"]) {
  requireText(robots, path, "private crawler exclusions");
}

const llms = read("public/llms.txt");
requireText(llms, "self-hostable remote AI runner", "llms.txt category");
requireText(llms, "real-device UI testing tool", "llms.txt testing category");
requireText(llms, "https://github.com/yaver-io/yaver.io", "llms.txt repository authority");
requireText(llms, "io.github.yaver-io/yaver", "llms.txt registry identity");
requireText(llms, "https://yaver.io/remote-ai-coding-agent", "llms.txt answer page");
requireText(llms, "https://yaver.io/about", "llms.txt company page");

const registry = JSON.parse(read("../server.json"));
if (registry.name !== "io.github.yaver-io/yaver") {
  throw new Error("unexpected MCP Registry name");
}

console.log("Yaver public discovery metadata is internally consistent.");
