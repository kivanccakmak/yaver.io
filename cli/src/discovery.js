const http = require('http');
const dgram = require('dgram');

// Keep this aligned with desktop/agent's canonical HTTP listener. The old
// mobile-prototype port (8347) made every manual/LAN probe miss a healthy
// desktop agent on 18080.
const YAVER_PORT = 18080;
const BEACON_PORT = 19837;
const DISCOVERY_TIMEOUT = 1500;
const HEALTH_TIMEOUT = 1200;
const LAN_SCAN_TIMEOUT = 350;

/**
 * Discover a yaver.io device on the network.
 * Priority: 1) manual IP, 2) saved config, 3) UDP beacon scan, 4) mDNS
 */
async function discoverDevice(manualIp) {
  if (manualIp) {
    const health = await fetchHealth({ ip: manualIp, port: YAVER_PORT });
    return { ip: manualIp, port: YAVER_PORT, name: health.deviceName || manualIp, platform: health.platform };
  }

  // Try UDP beacon discovery
  const beaconDevice = await listenForBeacon(DISCOVERY_TIMEOUT);
  if (beaconDevice) {
    return beaconDevice;
  }

  throw new Error(
    'No yaver.io device found on network.\n' +
    '  Make sure the Yaver desktop agent is running on the same Wi-Fi.\n' +
    '  Or specify device IP: yaver push --device <ip>'
  );
}

function deviceFromBeacon(msg, rinfo) {
  try {
    const beacon = JSON.parse(Buffer.isBuffer(msg) ? msg.toString() : String(msg));
    if (beacon.v !== 1 || !beacon.p) return null;
    const sender = rinfo && typeof rinfo.address === 'string' ? rinfo.address.trim() : '';
    const advertised = typeof beacon.ip === 'string' ? beacon.ip.trim() : '';
    const ip = advertised || sender;
    if (!ip) return null;
    return {
      ip,
      port: beacon.p,
      name: beacon.n || 'Unknown Device',
      id: beacon.id,
    };
  } catch {
    return null;
  }
}

/** Listen for UDP beacon from the Yaver desktop agent. */
function listenForBeacon(timeout) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const timer = setTimeout(() => {
      socket.close();
      resolve(null);
    }, timeout);

    socket.on('message', (msg, rinfo) => {
      const device = deviceFromBeacon(msg, rinfo);
      if (device) {
        clearTimeout(timer);
        socket.close();
        resolve(device);
      }
    });

    socket.on('error', () => {
      clearTimeout(timer);
      socket.close();
      resolve(null);
    });

    socket.bind(BEACON_PORT, () => {
      socket.setBroadcast(true);
    });
  });
}

/** Fetch /health from a device */
function fetchHealth(device, timeout = HEALTH_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const url = `http://${device.ip}:${device.port || YAVER_PORT}/health`;
    const req = http.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON from ${url}`));
        }
      });
    });
    req.on('error', (err) => reject(new Error(`Cannot reach ${device.ip}:${device.port || YAVER_PORT} — ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout connecting to ${device.ip}:${device.port || YAVER_PORT}`));
    });
  });
}

/** Scan common LAN subnets for yaver.io devices */
async function scanLAN() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  const found = [];
  const seen = new Set();

  for (const [, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      // Try common IPs on this subnet
      const subnet = addr.address.split('.').slice(0, 3).join('.');
      const ips = [];
      for (let i = 1; i <= 254; i++) {
        const ip = `${subnet}.${i}`;
        if (ip === addr.address) continue;
        ips.push(ip);
      }
      await runLimited(ips, 48, async (ip) => {
        try {
          const h = await fetchHealth({ ip, port: YAVER_PORT }, LAN_SCAN_TIMEOUT);
          const key = h.deviceId || `${ip}:${YAVER_PORT}`;
          if (seen.has(key)) return;
          seen.add(key);
          found.push({ ip, port: YAVER_PORT, name: h.deviceName, platform: h.platform });
        } catch {}
      });
    }
  }

  return found;
}

async function runLimited(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

module.exports = { discoverDevice, deviceFromBeacon, fetchHealth, listenForBeacon, scanLAN, YAVER_PORT };
