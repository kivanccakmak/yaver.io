const mockAsyncValues = new Map<string, string>();
const mockSecureValues = new Map<string, string>();

const mockAsyncStorage = {
  getItem: jest.fn(async (key: string) => mockAsyncValues.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => { mockAsyncValues.set(key, value); }),
  removeItem: jest.fn(async (key: string) => { mockAsyncValues.delete(key); }),
};

const mockSecureStore = {
  getItemAsync: jest.fn(async (key: string) => mockSecureValues.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockSecureValues.set(key, value); }),
  deleteItemAsync: jest.fn(async (key: string) => { mockSecureValues.delete(key); }),
};

const mockPlatform = { OS: 'ios' };

jest.mock('@react-native-async-storage/async-storage', () => ({ default: mockAsyncStorage }));
jest.mock('expo-secure-store', () => mockSecureStore, { virtual: true });
jest.mock('react-native', () => ({ Platform: mockPlatform }));

import { clearToken, getToken, saveToken } from '../auth';

const TOKEN_KEY = 'yaver_feedback_auth_token';

describe('Feedback OAuth persistence', () => {
  beforeEach(() => {
    mockPlatform.OS = 'ios';
    mockAsyncValues.clear();
    mockSecureValues.clear();
    jest.clearAllMocks();
  });

  it('restores an OAuth session from the platform keychain after app restart', async () => {
    await saveToken('oauth-token');

    expect(mockSecureValues.get(TOKEN_KEY)).toBe('oauth-token');
    expect(mockAsyncValues.has(TOKEN_KEY)).toBe(false);
    expect(await getToken()).toBe('oauth-token');
  });

  it('migrates an older plaintext SDK token into secure storage once', async () => {
    mockAsyncValues.set(TOKEN_KEY, 'legacy-token');

    expect(await getToken()).toBe('legacy-token');
    expect(mockSecureValues.get(TOKEN_KEY)).toBe('legacy-token');
    expect(mockAsyncValues.has(TOKEN_KEY)).toBe(false);
  });

  it('removes both secure and legacy copies only on explicit sign-out', async () => {
    mockSecureValues.set(TOKEN_KEY, 'secure-token');
    mockAsyncValues.set(TOKEN_KEY, 'legacy-token');

    await clearToken();

    expect(mockSecureValues.has(TOKEN_KEY)).toBe(false);
    expect(mockAsyncValues.has(TOKEN_KEY)).toBe(false);
  });

  it('keeps web OAuth in AsyncStorage when SecureStore is bundled', async () => {
    mockPlatform.OS = 'web';

    await saveToken('web-token');

    expect(mockAsyncValues.get(TOKEN_KEY)).toBe('web-token');
    expect(mockSecureValues.has(TOKEN_KEY)).toBe(false);
    expect(await getToken()).toBe('web-token');
  });
});
