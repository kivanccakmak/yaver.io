/**
 * Basic client — connect to agent, create task, stream output.
 *
 * Run: YAVER_URL=http://localhost:18080 YAVER_TOKEN=xxx npx tsx examples/js/client_basic.ts
 */
import { YaverClient } from "../../js/src/index";

const url = process.env.YAVER_URL || "http://localhost:18080";
const token = process.env.YAVER_TOKEN || "";
if (!token) {
  console.error("Set YAVER_TOKEN env var");
  process.exit(1);
}

const client = new YaverClient(url, token);

async function main() {
  // Health check
  console.log("Health:", await client.health());
  console.log(`Ping: ${await client.ping()}ms`);

  // Agent info
  const info = await client.info();
  console.log(`Connected to ${info.Hostname} (v${info.Version})\n`);

  // Create task
  const task = await client.createTask("List all TypeScript files in the current directory");
  console.log(`Task ${task.id} created (status: ${task.status})\n`);

  // Stream output
  for await (const chunk of client.streamOutput(task.id)) {
    process.stdout.write(chunk);
  }

  // Final result
  const final = await client.getTask(task.id);
  console.log(`\n\nTask finished (status: ${final.status})`);

  // Clean up
  await client.deleteTask(task.id);
}

main().catch(console.error);
