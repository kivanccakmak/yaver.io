import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "yaver_auth_token";
const USER_KEY = "yaver_user";

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
}

export async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(USER_KEY);
}

export async function getUser(): Promise<User | null> {
  try {
    const raw = await SecureStore.getItemAsync(USER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export async function saveUser(user: User): Promise<void> {
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
}

export async function validateToken(token: string): Promise<User | null> {
  try {
    // Validate token against the backend
    const response = await fetch(
      `${getApiBaseUrl()}/api/auth/validate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data.user as User;
  } catch {
    return null;
  }
}

export function getApiBaseUrl(): string {
  // TODO: make configurable
  return "https://api.yaver.io";
}

export function getOAuthUrl(provider: "google" | "microsoft"): string {
  const base = getApiBaseUrl();
  const redirectUri = "yaver://oauth-callback";
  return `${base}/api/auth/${provider}?redirect_uri=${encodeURIComponent(redirectUri)}`;
}
