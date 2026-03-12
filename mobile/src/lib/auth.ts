import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "yaver_auth_token";
const USER_KEY = "yaver_user";

export type OAuthProvider = "google" | "microsoft" | "apple";

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  surveyCompleted?: boolean;
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
    const response = await fetch(
      `${getConvexSiteUrl()}/auth/validate`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    const u = data.user;
    return {
      id: u.userId ?? u.id,
      email: u.email,
      name: u.fullName ?? u.name,
      avatarUrl: u.avatarUrl,
      surveyCompleted: u.surveyCompleted ?? false,
    } as User;
  } catch {
    return null;
  }
}

export function getWebBaseUrl(): string {
  return "https://yaver.io";
}

export function getConvexSiteUrl(): string {
  return "https://shocking-echidna-394.eu-west-1.convex.site";
}

export function getOAuthUrl(provider: OAuthProvider): string {
  const base = getWebBaseUrl();
  return `${base}/api/auth/oauth/${provider}?client=mobile`;
}

export async function signupWithEmail(
  fullName: string,
  email: string,
  password: string
): Promise<{ token: string; userId: string }> {
  const response = await fetch(`${getConvexSiteUrl()}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fullName, email, password }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? "Signup failed");
  }
  return response.json();
}

export async function loginWithEmail(
  email: string,
  password: string
): Promise<{ token: string; userId: string }> {
  const response = await fetch(`${getConvexSiteUrl()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? "Login failed");
  }
  return response.json();
}

export async function updateProfile(
  token: string,
  data: { fullName?: string }
): Promise<void> {
  const response = await fetch(`${getConvexSiteUrl()}/auth/update-profile`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error ?? "Failed to update profile");
  }
}

export async function submitSurvey(
  token: string,
  data: {
    isDeveloper: boolean;
    fullName?: string;
    languages?: string[];
    experienceLevel?: string;
    role?: string;
    companySize?: string;
    useCase?: string;
  }
): Promise<void> {
  const response = await fetch(`${getConvexSiteUrl()}/survey/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error ?? "Failed to submit survey");
  }
}

export async function getSurveyStatus(
  token: string
): Promise<{ completed: boolean }> {
  const response = await fetch(`${getConvexSiteUrl()}/survey`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    return { completed: false };
  }
  return response.json();
}

export async function deleteAccount(): Promise<boolean> {
  const token = await getToken();
  if (!token) return false;

  try {
    const response = await fetch(`${getConvexSiteUrl()}/auth/delete-account`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) return false;
    await clearToken();
    return true;
  } catch {
    return false;
  }
}
