import { invoke } from '@tauri-apps/api/core';
import type {
  ApiResponse,
  AuthTokens,
  ProjectDTO,
  SessionDetailDTO,
  SessionPayload,
  SessionSummaryDTO,
  UserDTO,
  Paginated,
} from '../types';

const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? '';

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export function backendUrl(): string {
  return BACKEND_URL;
}

async function getAccessToken(): Promise<string | null> {
  return invoke<string | null>('get_access_token');
}

async function refreshAccessToken(): Promise<string | null> {
  const refresh = await invoke<string | null>('get_refresh_token').catch(() => null);
  if (!refresh) return null;
  const res = await fetch(`${BACKEND_URL}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: refresh }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as ApiResponse<AuthTokens>;
  if (!body.success) return null;
  await invoke('store_tokens', {
    access: body.data.accessToken,
    refresh: body.data.refreshToken,
  });
  return body.data.accessToken;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
  /** Internal: prevents infinite refresh loops. */
  _retried?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, _retried = false } = opts;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (auth) {
    const token = await getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  // Transparent one-shot refresh on 401.
  if (res.status === 401 && auth && !_retried) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return request<T>(path, { ...opts, _retried: true });
    }
  }

  const json = (await res.json()) as ApiResponse<T>;
  if (!json.success) {
    throw new ApiClientError(json.error.code, json.error.message, res.status);
  }
  return json.data;
}

export const api = {
  me: (): Promise<UserDTO> => request<UserDTO>('/api/v1/auth/me'),
  devLogin: (email = 'dev@meetscribe.test'): Promise<AuthTokens> =>
    request<AuthTokens>('/api/v1/auth/dev-login', {
      method: 'POST',
      body: { email },
      auth: false,
    }),
  register: (email: string, password: string, name?: string): Promise<AuthTokens> =>
    request<AuthTokens>('/api/v1/auth/register', {
      method: 'POST',
      body: { email, password, name },
      auth: false,
    }),
  login: (email: string, password: string): Promise<AuthTokens> =>
    request<AuthTokens>('/api/v1/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    }),

  listProjects: (): Promise<ProjectDTO[]> => request<ProjectDTO[]>('/api/v1/projects'),
  createProject: (name: string, description?: string): Promise<ProjectDTO> =>
    request<ProjectDTO>('/api/v1/projects', {
      method: 'POST',
      body: { name, description },
    }),

  listSessions: (projectId?: string, cursor?: string): Promise<Paginated<SessionSummaryDTO>> => {
    const params = new URLSearchParams();
    if (projectId) params.set('projectId', projectId);
    if (cursor) params.set('cursor', cursor);
    const qs = params.toString();
    return request<Paginated<SessionSummaryDTO>>(`/api/v1/sessions${qs ? `?${qs}` : ''}`);
  },
  getSession: (id: string): Promise<SessionDetailDTO> =>
    request<SessionDetailDTO>(`/api/v1/sessions/${id}`),
  syncSession: (payload: SessionPayload): Promise<SessionSummaryDTO> =>
    request<SessionSummaryDTO>('/api/v1/sessions', { method: 'POST', body: payload }),
  toggleActionItem: (sessionId: string, aiId: string): Promise<{ id: string; done: boolean }> =>
    request<{ id: string; done: boolean }>(
      `/api/v1/sessions/${sessionId}/action-items/${aiId}`,
      { method: 'PATCH' },
    ),
  deleteSession: (id: string): Promise<{ deleted: boolean }> =>
    request<{ deleted: boolean }>(`/api/v1/sessions/${id}`, { method: 'DELETE' }),
};
