import { listReachableDevices } from '../auth';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('auth device listing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  it('returns the owner devices emitted by /devices/list', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          devices: [
            {
              deviceId: 'own-1',
              name: 'My Mac',
              platform: 'macos',
              isOnline: true,
              quicHost: '10.0.0.10',
              quicPort: 18080,
              lastHeartbeat: 123,
            },
          ],
        }),
    });

    const result = await listReachableDevices('sdk-user-token');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/devices/list'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer sdk-user-token' },
      }),
    );
    expect(result.owned).toHaveLength(1);
    expect(result.owned[0].deviceId).toBe('own-1');
  });
});
