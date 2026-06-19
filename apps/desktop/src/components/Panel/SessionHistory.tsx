import { useEffect, useState } from 'react';
import type { SessionSummaryDTO } from '../../types';
import { api } from '../../api/client';

interface Props {
  projectId: string | null;
  onOpen: (sessionId: string) => void;
  /** Bump this to force a reload (e.g. after a sync completes). */
  refreshKey: number;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface Props2 extends Props {
  /** Called after a session is deleted (e.g. to close its detail view). */
  onDeleted?: (sessionId: string) => void;
}

export function SessionHistory({
  projectId,
  onOpen,
  refreshKey,
  onDeleted,
}: Props2): React.ReactElement {
  const [sessions, setSessions] = useState<SessionSummaryDTO[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const result = await api.listSessions(projectId ?? undefined);
        if (active) setSessions(result.items);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Failed to load sessions');
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, refreshKey]);

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm('Delete this session? This cannot be undone.')) return;
    try {
      await api.deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      onDeleted?.(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete session');
    }
  };

  return (
    <div className="space-y-1 overflow-y-auto">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-text-muted">Sessions</span>
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-surface-overlay text-text-muted">
          {sessions.length}
        </span>
      </div>
      {error && <p className="text-xs text-accent-red">{error}</p>}
      {sessions.length === 0 && !error && (
        <p className="text-xs text-text-muted py-2">No sessions yet.</p>
      )}
      <ul className="space-y-1">
        {sessions.map((s) => (
          <li
            key={s.id}
            className="group relative flex items-center rounded-md hover:bg-surface-overlay
                       border border-transparent hover:border-border transition"
          >
            <button
              type="button"
              onClick={() => onOpen(s.id)}
              className="flex-1 min-w-0 text-left px-2 py-1.5"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm text-text-primary truncate">
                  {s.title ?? new Date(s.startedAt).toLocaleString()}
                </span>
                <span className="text-[10px] text-text-muted ml-2 shrink-0">
                  {formatDuration(s.durationSeconds)}
                </span>
              </div>
              <span className="text-[10px] text-text-muted">{s.mode}</span>
            </button>
            <button
              type="button"
              onClick={() => void remove(s.id)}
              title="Delete session"
              className="shrink-0 px-2 self-stretch text-text-muted opacity-0 group-hover:opacity-100
                         hover:text-accent-red transition"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
