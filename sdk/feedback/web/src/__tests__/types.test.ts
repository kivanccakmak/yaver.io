import type {
  FeedbackConfig,
  FeedbackBundle,
  TimelineEvent,
  DeviceInfo,
  DiscoveryResult,
} from '../types';

describe('Web SDK types', () => {
  describe('FeedbackConfig', () => {
    it('can be constructed with no fields (all optional)', () => {
      const config: FeedbackConfig = {};
      expect(config.agentUrl).toBeUndefined();
      expect(config.authToken).toBeUndefined();
      expect(config.trigger).toBeUndefined();
      expect(config.shortcut).toBeUndefined();
      expect(config.enabled).toBeUndefined();
      expect(config.maxRecordingDuration).toBeUndefined();
      expect(config.buttonPosition).toBeUndefined();
    });

    it('can be constructed with all fields', () => {
      const config: FeedbackConfig = {
        agentUrl: 'http://192.168.1.10:18080',
        authToken: 'my-token',
        trigger: 'floating-button',
        shortcut: 'ctrl+shift+f',
        enabled: true,
        maxRecordingDuration: 60,
        buttonPosition: 'bottom-right',
      };
      expect(config.trigger).toBe('floating-button');
      expect(config.buttonPosition).toBe('bottom-right');
      expect(config.maxRecordingDuration).toBe(60);
    });

    it('accepts all trigger types', () => {
      const triggers: FeedbackConfig['trigger'][] = ['floating-button', 'keyboard', 'manual'];
      triggers.forEach((trigger) => {
        const config: FeedbackConfig = { trigger };
        expect(config.trigger).toBe(trigger);
      });
    });

    it('accepts all button positions', () => {
      const positions: FeedbackConfig['buttonPosition'][] = [
        'bottom-right', 'bottom-left', 'top-right', 'top-left',
      ];
      positions.forEach((pos) => {
        const config: FeedbackConfig = { buttonPosition: pos };
        expect(config.buttonPosition).toBe(pos);
      });
    });
  });

  describe('FeedbackBundle', () => {
    it('can be constructed with required fields only', () => {
      const bundle: FeedbackBundle = {
        metadata: {
          source: 'in-app-sdk',
          deviceInfo: {
            platform: 'web',
            browser: 'Chrome',
            browserVersion: '120.0.0',
            os: 'MacIntel',
            screenSize: '1920x1080',
            userAgent: 'Mozilla/5.0...',
          },
          url: 'http://localhost:3000/dashboard',
          timeline: [],
        },
        screenshots: [],
      };

      expect(bundle.metadata.source).toBe('in-app-sdk');
      expect(bundle.metadata.deviceInfo.platform).toBe('web');
      expect(bundle.metadata.url).toBe('http://localhost:3000/dashboard');
      expect(bundle.video).toBeUndefined();
      expect(bundle.audio).toBeUndefined();
    });

    it('can include all optional fields', () => {
      const videoBlob = new Blob(['video-data'], { type: 'video/webm' });
      const audioBlob = new Blob(['audio-data'], { type: 'audio/webm' });
      const screenshotBlob = new Blob(['png-data'], { type: 'image/png' });

      const bundle: FeedbackBundle = {
        metadata: {
          source: 'in-app-sdk',
          deviceInfo: {
            platform: 'web',
            browser: 'Firefox',
            browserVersion: '130.0',
            os: 'Linux x86_64',
            screenSize: '2560x1440',
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
          },
          appVersion: '2.5.0',
          url: 'http://localhost:3000/settings',
          timeline: [
            { time: 0, type: 'screenshot', text: 'Initial state' },
            { time: 5.2, type: 'voice', text: 'The button is misaligned' },
          ],
          transcript: 'The button is misaligned on the settings page',
          consoleErrors: ['TypeError: Cannot read property x of null'],
        },
        video: videoBlob,
        audio: audioBlob,
        screenshots: [screenshotBlob],
      };

      expect(bundle.video).toBeInstanceOf(Blob);
      expect(bundle.audio).toBeInstanceOf(Blob);
      expect(bundle.screenshots).toHaveLength(1);
      expect(bundle.metadata.transcript).toBe('The button is misaligned on the settings page');
      expect(bundle.metadata.consoleErrors).toHaveLength(1);
      expect(bundle.metadata.appVersion).toBe('2.5.0');
    });
  });

  describe('TimelineEvent', () => {
    it('supports all event types', () => {
      const types: TimelineEvent['type'][] = ['voice', 'screenshot', 'annotation', 'console-error'];
      types.forEach((type) => {
        const event: TimelineEvent = { time: 1.5, type };
        expect(event.type).toBe(type);
        expect(event.time).toBe(1.5);
      });
    });

    it('supports optional text and file fields', () => {
      const event: TimelineEvent = {
        time: 10.0,
        type: 'screenshot',
        text: 'Login page broken',
        file: 'screenshot_0.png',
      };
      expect(event.text).toBe('Login page broken');
      expect(event.file).toBe('screenshot_0.png');
    });

    it('can omit optional fields', () => {
      const event: TimelineEvent = { time: 0, type: 'console-error' };
      expect(event.text).toBeUndefined();
      expect(event.file).toBeUndefined();
    });
  });

  describe('DeviceInfo', () => {
    it('has all required web-specific fields', () => {
      const device: DeviceInfo = {
        platform: 'web',
        browser: 'Safari',
        browserVersion: '17.0',
        os: 'MacIntel',
        screenSize: '1440x900',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
      };
      expect(device.platform).toBe('web');
      expect(device.browser).toBe('Safari');
      expect(device.screenSize).toBe('1440x900');
    });
  });

  describe('DiscoveryResult', () => {
    it('has correct structure', () => {
      const result: DiscoveryResult = {
        url: 'http://192.168.1.10:18080',
        hostname: 'MacBook-Pro',
        version: '1.44.0',
        latency: 3,
      };
      expect(result.url).toBe('http://192.168.1.10:18080');
      expect(result.hostname).toBe('MacBook-Pro');
      expect(result.version).toBe('1.44.0');
      expect(result.latency).toBe(3);
    });

    it('latency is a number in milliseconds', () => {
      const result: DiscoveryResult = {
        url: 'http://localhost:18080',
        hostname: 'local',
        version: '1.0',
        latency: 0,
      };
      expect(typeof result.latency).toBe('number');
      expect(result.latency).toBeGreaterThanOrEqual(0);
    });
  });
});
