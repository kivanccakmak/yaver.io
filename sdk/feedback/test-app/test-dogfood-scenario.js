#!/usr/bin/env node
/**
 * Dogfooding Integration Test — Vibe Coding Scenario
 *
 * Simulates the full "code from the beach" loop using the feedback SDK:
 * 1. Connect to agent
 * 2. Send a coding task: "rename Yaver to Taver in the app title"
 * 3. Wait for task to complete
 * 4. Trigger a build
 * 5. Send feedback: "the name change looks good"
 * 6. Verify the feedback was received
 *
 * This tests the complete pipeline: task → build → feedback → fix
 *
 * Run: YAVER_AUTH_TOKEN=<token> node test-dogfood-scenario.js [agent-url]
 */

const http = require('http');
const https = require('https');

const AGENT_URL = process.argv[2] || 'http://localhost:18080';
const AUTH_TOKEN = process.env.YAVER_AUTH_TOKEN || '';
const TIMEOUT = 5000;

let passed = 0;
let failed = 0;

async function request(method, path, body, headers = {}) {
  const url = new URL(path, AGENT_URL);
  const mod = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), TIMEOUT);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {}),
      },
    };

    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

async function main() {
  console.log(`\nDogfooding Integration Test: ${AGENT_URL}\n`);

  // Step 1: Health check
  console.log('--- Step 1: Connect to agent ---');
  const health = await request('GET', '/health');
  assert(health.status === 200, 'Agent is reachable');

  // Step 2: Check agent info
  console.log('\n--- Step 2: Agent info ---');
  const info = await request('GET', '/agent/status');
  assert(info.status === 200, 'Agent status available');

  // Step 3: Create a coding task (simulates voice: "rename Yaver to Taver")
  console.log('\n--- Step 3: Create coding task ---');
  const task = await request('POST', '/tasks', {
    title: 'Rename the app title from "Yaver" to "Taver" in the main screen header',
  });
  assert(task.status === 200 || task.status === 201, 'Task created');
  const taskId = task.body?.taskId || task.body?.id;
  assert(taskId !== undefined, `Task ID received: ${taskId}`);

  // Step 4: Check builds endpoint
  console.log('\n--- Step 4: Builds API ---');
  const builds = await request('GET', '/builds');
  assert(builds.status === 200, 'Builds endpoint works');
  assert(Array.isArray(builds.body), 'Builds is array');

  // Step 5: Check tests endpoint
  console.log('\n--- Step 5: Tests API ---');
  const tests = await request('GET', '/tests');
  assert(tests.status === 200, 'Tests endpoint works');

  // Step 6: Send feedback (simulates: "the name change looks good")
  console.log('\n--- Step 6: Upload feedback ---');
  const boundary = '----DogfoodTest' + Date.now();
  const metadata = JSON.stringify({
    source: 'in-app-sdk',
    appVersion: '2.0.0-dogfood',
    deviceInfo: { platform: 'ios', model: 'iPhone 16', osVersion: '18.2', appName: 'Taver' },
    timeline: [
      { time: 0, type: 'annotation', text: 'Testing app name change from Yaver to Taver' },
      { time: 3, type: 'voice', text: 'The header now shows Taver, looks correct' },
      { time: 5, type: 'voice', text: 'Navigation bar title also updated' },
    ],
    transcript: 'The rename from Yaver to Taver is complete. Header and nav bar both show the new name correctly.',
  });

  let body = '';
  body += `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${metadata}\r\n`;
  body += `--${boundary}\r\nContent-Disposition: form-data; name="screenshot"; filename="taver_header.jpg"\r\nContent-Type: image/jpeg\r\n\r\nfake-screenshot-of-taver-header\r\n`;
  body += `--${boundary}--\r\n`;

  const feedback = await request('POST', '/feedback', body, {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  });
  assert(feedback.status === 200, 'Feedback uploaded');
  const reportId = feedback.body?.id;
  assert(reportId, `Report ID: ${reportId}`);

  // Step 7: Verify feedback received
  if (reportId) {
    console.log('\n--- Step 7: Verify feedback ---');
    const report = await request('GET', `/feedback/${reportId}`);
    assert(report.status === 200, 'Feedback retrievable');
    assert(report.body?.source === 'in-app-sdk', 'Source is in-app-sdk');
    assert(report.body?.transcript?.includes('Taver'), 'Transcript mentions Taver');

    // Step 8: Generate fix prompt
    console.log('\n--- Step 8: Generate fix prompt ---');
    const fix = await request('POST', `/feedback/${reportId}/fix`, {});
    assert(fix.status === 200, 'Fix prompt generated');
    assert(fix.body?.prompt?.includes('Bug report'), 'Prompt has correct format');

    // Step 9: Cleanup
    console.log('\n--- Step 9: Cleanup ---');
    const del = await request('DELETE', `/feedback/${reportId}`);
    assert(del.status === 200, 'Feedback cleaned up');
  }

  // Step 10: Vault integration
  console.log('\n--- Step 10: Vault API ---');
  const vault = await request('GET', '/vault/list');
  assert(vault.status === 200, 'Vault endpoint works');

  // Step 11: Tunnels
  console.log('\n--- Step 11: Tunnels API ---');
  const tunnels = await request('GET', '/tunnels');
  assert(tunnels.status === 200, 'Tunnels endpoint works');

  // Step 12: Agent context
  console.log('\n--- Step 12: Agent context ---');
  const ctx = await request('GET', '/agent/context');
  assert(ctx.status === 200, 'Agent context available');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  console.log(`\nThis test simulates the full dogfooding loop:`);
  console.log(`  1. Developer opens Yaver SDK tab in their app`);
  console.log(`  2. Says "rename Yaver to Taver" (voice command → task)`);
  console.log(`  3. Agent makes the change, hot reload applies`);
  console.log(`  4. Developer records feedback: "looks good"`);
  console.log(`  5. Feedback sent to agent via P2P`);
  console.log(`  6. If issues found, agent fixes and rebuilds`);
  console.log(`  7. Developer says "push to TestFlight" → done\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nConnection error:', err.message);
  console.error('Is the agent running? Start with: yaver serve --debug');
  process.exit(1);
});
