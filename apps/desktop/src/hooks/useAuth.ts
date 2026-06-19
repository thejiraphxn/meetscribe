import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UserDTO } from '../types';
import { api } from '../api/client';

interface AuthCallbackPayload {
  access_token: string;
  refresh_token: string;
}

export interface AuthApi {
  user: UserDTO | null;
  isAuthenticated: boolean;
  loading: boolean;
  login: () => Promise<void>;
  /** Development-only: log in without Google via the backend dev-login route. */
  devLogin: () => Promise<void>;
  /** Email/password sign up. */
  signUp: (email: string, password: string, name?: string) => Promise<void>;
  /** Email/password sign in. */
  signIn: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export function useAuth(): AuthApi {
  const [user, setUser] = useState<UserDTO | null>(null);
  const [loading, setLoading] = useState(true);

  const loadUser = useCallback(async () => {
    try {
      const token = await invoke<string | null>('get_access_token');
      if (!token) {
        setUser(null);
        return;
      }
      setUser(await api.me());
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUser();
  }, [loadUser]);

  useEffect(() => {
    // `auth-callback` — emitted by the Rust shell after the Google deep-link
    // handshake (carries tokens). Store them, then refresh the user.
    const cbPromise = listen<AuthCallbackPayload>('auth-callback', async (event) => {
      const { access_token, refresh_token } = event.payload;
      await invoke('store_tokens', { access: access_token, refresh: refresh_token });
      await loadUser();
    });
    return () => {
      void cbPromise.then((u) => u());
    };
  }, [loadUser]);

  // Cross-window auth sync: each window (bar + panel) is an independent React
  // tree, and Tauri cross-window events proved unreliable here. Instead, every
  // window polls the shared token store and reloads when it changes — so signing
  // in from the panel enables the bar (and vice-versa) within ~1.5s.
  const lastTokenRef = useRef<string | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      void (async () => {
        const token = await invoke<string | null>('get_access_token').catch(() => null);
        if (token !== lastTokenRef.current) {
          lastTokenRef.current = token;
          await loadUser();
        }
      })();
    }, 1500);
    return () => window.clearInterval(id);
  }, [loadUser]);

  const login = useCallback(async () => {
    await invoke('open_auth_browser');
  }, []);

  // Store tokens + refresh THIS window directly (so any error surfaces to the
  // caller). Other windows pick up the change via the poll above.
  const applyTokens = useCallback(
    async (accessToken: string, refreshToken: string) => {
      await invoke('store_tokens', { access: accessToken, refresh: refreshToken });
      await loadUser();
    },
    [loadUser],
  );

  const devLogin = useCallback(async () => {
    const tokens = await api.devLogin();
    await applyTokens(tokens.accessToken, tokens.refreshToken);
  }, [applyTokens]);

  const signUp = useCallback(
    async (email: string, password: string, name?: string) => {
      const tokens = await api.register(email, password, name);
      await applyTokens(tokens.accessToken, tokens.refreshToken);
    },
    [applyTokens],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      const tokens = await api.login(email, password);
      await applyTokens(tokens.accessToken, tokens.refreshToken);
    },
    [applyTokens],
  );

  const logout = useCallback(async () => {
    await invoke('clear_tokens');
    setUser(null);
  }, []);

  return {
    user,
    isAuthenticated: user !== null,
    loading,
    login,
    devLogin,
    signUp,
    signIn,
    logout,
  };
}
