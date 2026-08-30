import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { configureVisionCameraPodfile } = require('./configure-vision-camera-podfile.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('disables VisionCamera frame processors without duplicating the setting', () => {
  const first = configureVisionCameraPodfile("platform :ios, '15.5'\n");
  assert.equal(first, "$VCEnableFrameProcessors = false\nplatform :ios, '15.5'\n");
  assert.equal(configureVisionCameraPodfile(first), first);
  assert.equal(
    configureVisionCameraPodfile("$VCEnableFrameProcessors = true\nplatform :ios, '15.5'\n"),
    "$VCEnableFrameProcessors = false\nplatform :ios, '15.5'\n",
  );
});

test('wires the same policy into clean prebuilds and canonical deploys', () => {
  const app = JSON.parse(readFileSync(join(root, 'mobile', 'app.json'), 'utf8'));
  assert.ok(app.expo.plugins.some((plugin) => Array.isArray(plugin)
    && plugin[0] === 'react-native-vision-camera'
    && plugin[1]?.enableFrameProcessors === false));
  const deploy = readFileSync(join(root, 'scripts', 'deploy-testflight.sh'), 'utf8');
  assert.match(deploy, /configure-vision-camera-podfile\.js/);
});
