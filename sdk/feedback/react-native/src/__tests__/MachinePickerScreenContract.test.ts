import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(__dirname, '..', 'MachinePickerScreen.tsx'), 'utf8');

describe('MachinePickerScreen progressive reachability contract', () => {
  it('makes heartbeat-online machines immediately selectable', () => {
    expect(source).toContain("const direct = device.isOnline");
    expect(source).toContain("? { reachable: true } as DeviceReachability");
    expect(source).not.toContain("statusLine = 'Checking connection…'");
    expect(source).toContain("statusLine = device.platform || 'Online'");
  });

  it('does not hold every row behind the slowest direct probe', () => {
    expect(source).not.toContain('Promise.allSettled');
    expect(source).toContain("filter((candidate) => !candidate.isOnline)");
    expect(source).toContain("setReachability((prev) => ({ ...prev, [device.deviceId]: probe }))");
  });

  it('names the selected machine connection operation', () => {
    expect(source).toContain("statusLine = 'Connecting…'");
    expect(source).toContain('disabled={selectingDeviceId !== null}');
  });
});
