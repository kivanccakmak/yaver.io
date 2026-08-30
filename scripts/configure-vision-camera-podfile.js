#!/usr/bin/env node

const fs = require('fs');

const SETTING = '$VCEnableFrameProcessors = false';

function configureVisionCameraPodfile(source) {
  const existing = /^\s*\$VCEnableFrameProcessors\s*=\s*(?:true|false)\s*$/m;
  if (existing.test(source)) return source.replace(existing, SETTING);
  return `${SETTING}\n${source}`;
}

if (require.main === module) {
  const podfile = process.argv[2];
  if (!podfile || !fs.existsSync(podfile)) {
    console.error(`ERROR: VisionCamera Podfile policy needs an existing Podfile: ${podfile || '<missing>'}`);
    process.exit(2);
  }
  const before = fs.readFileSync(podfile, 'utf8');
  const after = configureVisionCameraPodfile(before);
  if (after !== before) fs.writeFileSync(podfile, after);
  console.log('VisionCamera frame processors disabled (Yaver does not use them).');
}

module.exports = { configureVisionCameraPodfile };
