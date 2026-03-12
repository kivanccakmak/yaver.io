import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  User,
  getToken,
  getUser,
  saveToken,
  saveUser,
  clearToken,
  validateToken,
} from "../lib/auth";

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (token: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Restore session on mount
  useEffect(() => {
    (async () => {
      try {
        const storedToken = await getToken();
        if (storedToken) {
          const storedUser = await getUser();
          if (storedUser) {
            setToken(storedToken);
            setUser(storedUser);
          } else {
            // Token exists but no cached user — validate remotely
            const validatedUser = await validateToken(storedToken);
            if (validatedUser) {
              setToken(storedToken);
              setUser(validatedUser);
              await saveUser(validatedUser);
            } else {
              await clearToken();
            }
          }
        }
      } catch {
        // Silently fail; user stays unauthenticated.
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (newToken: string) => {
    const validatedUser = await validateToken(newToken);
    if (!validatedUser) {
      throw new Error("Invalid token");
    }
    await saveToken(newToken);
    await saveUser(validatedUser);
    setToken(newToken);
    setUser(validatedUser);
  }, []);

  const logout = useCallback(async () => {
    await clearToken();
    setToken(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      token,
      isLoading,
      isAuthenticated: !!token && !!user,
      login,
      logout,
    }),
    [user, token, isLoading, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
