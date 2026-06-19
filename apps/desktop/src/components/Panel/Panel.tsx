import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { SessionDetailDTO } from '../../types';
import { useEngine } from '../../hooks/useEngine';
import { useAuth } from '../../hooks/useAuth';
import { api, backendUrl } from '../../api/client';
import type { LiveSegment } from '../../hooks/useEngine';
import { AuthForm } from '../AuthForm';
import { Settings } from './Settings';
import { hasSavedLlmConfig, loadLlmConfig } from '../../lib/llmConfig';
import { ProjectSelector } from './ProjectSelector';
import { SessionHistory } from './SessionHistory';
import { TranscriptFeed } from './TranscriptFeed';
import { NotesPanel } from './NotesPanel';
import { ActionItems } from './ActionItems';

function SyncChip({
  status,
}: {
  status: ReturnType<typeof useEngine>['syncStatus'];
}): React.ReactElement | null {
  if (!status) return null;
  const map = {
    syncing: 'text-accent-amber border-accent-amber',
    synced: 'text-emerald-400 border-emerald-400',
    error: 'text-accent-red border-accent-red',
  } as const;
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full border ${map[status.status]}`}>
      {status.status}
      {status.error ? `: ${status.error.slice(0, 40)}` : ''}
    </span>
  );
}

export function Panel(): React.ReactElement {
  const engine = useEngine();
  const { isAuthenticated, user, logout } = useAuth();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [historyKey, setHistoryKey] = useState(0);
  // A past session opened from history (read-only). null = live view.
  const [viewing, setViewing] = useState<SessionDetailDTO | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const recording = engine.state === 'recording';

  // Push any saved LLM config to the sidecar once connected (config lives only
  // on this machine; it is never sent to the backend).
  useEffect(() => {
    if (engine.connected && hasSavedLlmConfig()) {
      const c = loadLlmConfig();
      engine.setLlmConfig(c.baseUrl, c.model, c.apiKey);
    }
  }, [engine.connected, engine.setLlmConfig]);

  const openSession = useCallback(async (sessionId: string) => {
    try {
      setViewing(await api.getSession(sessionId));
    } catch {
      setViewing(null);
    }
  }, []);

  // Map a viewed session's stored segments onto the live-feed shape.
  const viewingSegments: LiveSegment[] = useMemo(
    () =>
      viewing
        ? viewing.segments.map((s) => ({
            sequence: s.sequence,
            text: s.text,
            isFinal: s.isFinal,
            t: s.startSec,
            confidence: s.confidence,
          }))
        : [],
    [viewing],
  );

  // Duration timer + reset the title each time a new recording (session) begins.
  useEffect(() => {
    if (!recording) return;
    setElapsed(0);
    setTitle('');
    const id = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(id);
  }, [recording]);

  // Reload history when a sync succeeds.
  useEffect(() => {
    if (engine.syncStatus?.status === 'synced') setHistoryKey((k) => k + 1);
  }, [engine.syncStatus]);

  const durationLabel = useMemo(() => {
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }, [elapsed]);

  const onSync = useCallback(async () => {
    const token = await invoke<string | null>('get_access_token');
    if (!token) return;
    // Sidecar loads the active session from SQLite and POSTs it. The selected
    // project is applied server-side via the payload's projectId, which the
    // sidecar persists at session creation (see integration note in README).
    engine.sync(backendUrl(), token);
  }, [engine]);

  // Auto-sync when a recording finishes (processing → idle) so each session
  // shows up in history without a manual Sync click.
  const prevStateRef = useRef(engine.state);
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = engine.state;
    if (prev === 'processing' && engine.state === 'idle') {
      void onSync();
    }
  }, [engine.state, onSync]);

  if (!isAuthenticated) {
    return (
      <div className="h-full flex items-center justify-center">
        <AuthForm />
      </div>
    );
  }

  return (
    <div className="relative h-full flex text-text-primary">
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          onApply={(c) => engine.setLlmConfig(c.baseUrl, c.model, c.apiKey)}
        />
      )}
      {/* Left sidebar */}
      <aside className="w-56 shrink-0 border-r border-border p-3 flex flex-col gap-4 overflow-hidden">
        <ProjectSelector selectedId={projectId} onSelect={setProjectId} />
        <div className="flex-1 overflow-hidden">
          <SessionHistory
            projectId={projectId}
            refreshKey={historyKey}
            onOpen={(id) => void openSession(id)}
            onDeleted={(id) => {
              if (viewing?.id === id) setViewing(null);
            }}
          />
        </div>
        <div className="flex items-center justify-between text-xs text-text-muted">
          <span className="truncate">{user?.email}</span>
          <button type="button" onClick={() => void logout()} className="hover:text-accent-red">
            Sign out
          </button>
        </div>
      </aside>

      {/* Main column */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-12 shrink-0 border-b border-border px-4 flex items-center gap-3">
          {viewing ? (
            <>
              <button
                type="button"
                onClick={() => setViewing(null)}
                className="text-xs text-accent-amber hover:underline shrink-0"
              >
                ← Live
              </button>
              <span className="flex-1 min-w-0 truncate text-sm font-medium">
                {viewing.title ?? new Date(viewing.startedAt).toLocaleString()}
              </span>
              <span className="text-[10px] px-2 py-0.5 rounded-full border border-border text-text-muted uppercase">
                {viewing.mode}
              </span>
            </>
          ) : (
            <>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => title.trim() && engine.setTitle(title.trim())}
                placeholder="Untitled session"
                className="flex-1 min-w-0 bg-transparent text-sm font-medium outline-none
                           text-text-primary placeholder:text-text-muted"
              />
              {engine.mode && (
                <span className="text-[10px] px-2 py-0.5 rounded-full border border-border text-text-muted uppercase">
                  {engine.mode}
                </span>
              )}
              {recording && (
                <span className="text-xs text-accent-red tabular-nums">{durationLabel}</span>
              )}
              <SyncChip status={engine.syncStatus} />
              <button
                type="button"
                onClick={() => void onSync()}
                disabled={engine.state !== 'idle'}
                className="text-xs px-2 py-1 rounded-md border border-border
                           hover:bg-surface-overlay disabled:opacity-40"
              >
                Sync
              </button>
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                title="Model settings"
                className="shrink-0 h-7 w-7 flex items-center justify-center rounded-md
                           text-text-muted hover:bg-surface-overlay hover:text-text-primary"
              >
                ⚙
              </button>
            </>
          )}
        </header>

        {/* Stacked sections: Transcript (top) over Notes (bottom), each scrolls. */}
        <div className="flex-1 flex flex-col min-h-0">
          {/* Transcript section */}
          <section className="flex-[1.2] min-h-0 flex flex-col border-b border-border">
            <div className="shrink-0 px-4 py-1.5 flex items-center justify-between border-b border-border/60 bg-surface-elevated/40">
              <span className="text-xs uppercase tracking-wide text-text-muted">Transcript</span>
              <span className="text-[10px] text-text-muted tabular-nums">
                {(viewing ? viewingSegments : engine.segments).length} segments
              </span>
            </div>
            <div className="flex-1 min-h-0 flex flex-col">
              <TranscriptFeed
                segments={viewing ? viewingSegments : engine.segments}
                interim={viewing ? '' : engine.interim}
                progress={viewing ? null : engine.progress}
                recording={!viewing && recording}
              />
              {!viewing && engine.lastError && (
                <div className="shrink-0 px-4 py-2 text-xs text-accent-red border-t border-border">
                  {engine.lastError}
                </div>
              )}
            </div>
          </section>

          {/* Notes + action items section */}
          <section className="flex-1 min-h-0 flex flex-col">
            <div className="shrink-0 px-4 py-1.5 border-b border-border/60 bg-surface-elevated/40">
              <span className="text-xs uppercase tracking-wide text-text-muted">
                Notes &amp; Action Items
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <NotesPanel notes={viewing ? viewing.notes : engine.notes} />
              <div className="border-t border-border" />
              <ActionItems items={viewing ? viewing.actionItems : engine.actionItems} />
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
