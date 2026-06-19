/**
 * MeetScribe shared types — the single source of truth for every DTO that
 * crosses a boundary (desktop ↔ backend ↔ sidecar).
 *
 * Column / field names here MUST stay in sync with:
 *   - apps/backend/prisma/schema.prisma  (PostgreSQL)
 *   - sidecar/db.py                       (SQLite mirror)
 */

// ---------------------------------------------------------------------------
// Enums / primitives
// ---------------------------------------------------------------------------

export type TranscriptionMode = 'realtime' | 'batch';

export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'error';

/** Sidecar lifecycle state. */
export type EngineState = 'idle' | 'recording' | 'processing';

/** Steps reported during post-recording processing. */
export type ProcessingStep = 'transcribing' | 'summarising' | 'saving';

// ---------------------------------------------------------------------------
// Core domain DTOs
// ---------------------------------------------------------------------------

export interface TranscriptSegmentDTO {
  sequence: number;
  startSec: number;
  endSec?: number;
  text: string;
  speaker?: string;
  confidence?: number;
}

export interface ActionItemDTO {
  text: string;
  assignee?: string;
}

/**
 * Payload the desktop app POSTs to `POST /api/v1/sessions` to sync a
 * completed recording. Upserted server-side by `localId`.
 */
export interface SessionPayload {
  localId: string;
  projectId: string;
  title?: string;
  mode: TranscriptionMode;
  durationSeconds: number;
  language: string;
  /** ISO 8601 */
  startedAt: string;
  /** ISO 8601 */
  endedAt: string;
  notes?: string;
  segments: TranscriptSegmentDTO[];
  actionItems: ActionItemDTO[];
}

// ---------------------------------------------------------------------------
// Server-side read models (what the backend returns to the desktop)
// ---------------------------------------------------------------------------

export interface UserDTO {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export interface ProjectDTO {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  sessionCount?: number;
}

export interface PersistedActionItemDTO extends ActionItemDTO {
  id: string;
  done: boolean;
}

export interface SessionSummaryDTO {
  id: string;
  localId: string;
  projectId: string;
  title: string | null;
  mode: TranscriptionMode;
  durationSeconds: number;
  language: string;
  startedAt: string;
  endedAt: string;
  createdAt: string;
}

export interface SessionDetailDTO extends SessionSummaryDTO {
  notes: string | null;
  segments: (TranscriptSegmentDTO & { id: string; isFinal: boolean })[];
  actionItems: PersistedActionItemDTO[];
}

// ---------------------------------------------------------------------------
// Auth DTOs
// ---------------------------------------------------------------------------

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  name?: string;
  iat: number;
  exp: number;
}

export interface RefreshRequest {
  refreshToken: string;
}

// ---------------------------------------------------------------------------
// API envelope
// ---------------------------------------------------------------------------

export interface ApiError {
  code: string;
  message: string;
  /** Optional per-field validation detail. */
  details?: Record<string, string>;
}

export type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: ApiError };

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Sidecar WebSocket protocol (ws://127.0.0.1:8765)
// ---------------------------------------------------------------------------

/** Commands: UI → sidecar. */
export type WsCommand =
  | {
      cmd: 'start';
      mode: TranscriptionMode;
      session_id: string;
      lang: string;
      /** Project the session belongs to (persisted locally for idempotent sync). */
      project_id?: string;
      /** Run live + on-stop LLM summarisation. Default true. */
      auto_summarise?: boolean;
    }
  | { cmd: 'stop' }
  | { cmd: 'set_title'; title: string }
  | {
      cmd: 'set_llm_config';
      /** Ollama-compatible base URL, e.g. http://localhost:11434 or a cloud URL. */
      base_url: string;
      model: string;
      /** Bearer token for cloud / authenticated endpoints (optional for local). */
      api_key?: string;
    }
  | {
      cmd: 'set_transcription_config';
      /** Realtime (Deepgram). */
      deepgram_api_key?: string;
      deepgram_model?: string;
      /** Batch provider: Groq Whisper (cloud) or the local transcript-service. */
      batch_provider?: 'groq' | 'local';
      groq_api_key?: string;
      groq_model?: string;
      /** Base URL of the local transcript-service, e.g. http://localhost:9099 */
      transcript_service_url?: string;
    }
  | { cmd: 'summarise' }
  | { cmd: 'sync'; backend_url: string; access_token: string }
  | { cmd: 'clear' };

/** Broadcasts: sidecar → UI. */
export type WsMessage =
  | { type: 'state'; state: EngineState; mode: TranscriptionMode | null }
  | {
      type: 'transcript';
      t: number;
      text: string;
      is_final: boolean;
      sequence: number;
      speaker?: string;
      confidence?: number;
    }
  | { type: 'processing_progress'; step: ProcessingStep; pct: number }
  | { type: 'notes'; markdown: string }
  | { type: 'action_items'; items: ActionItemDTO[] }
  | { type: 'sync_status'; status: Exclude<SyncStatus, 'pending'>; error: string | null }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isWsMessage(value: unknown): value is WsMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string'
  );
}
