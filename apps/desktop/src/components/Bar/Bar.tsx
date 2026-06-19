import { useCallback, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { TranscriptionMode } from '../../types';
import { useEngine } from '../../hooks/useEngine';
import { useAuth } from '../../hooks/useAuth';
import { backendUrl } from '../../api/client';

type WakeState = 'idle' | 'waking' | 'awake' | 'error';

function newSessionId(): string {
  return crypto.randomUUID();
}

/** Small icon button used for panel / hide / quit. */
function IconButton({
  onClick,
  title,
  children,
  danger = false,
  disabled = false,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`h-8 w-8 shrink-0 flex items-center justify-center rounded-lg text-text-muted transition
        ${disabled ? 'opacity-40 cursor-not-allowed' : danger
          ? 'hover:bg-accent-red/20 hover:text-accent-red'
          : 'hover:bg-white/[0.06] hover:text-text-primary'}`}
    >
      {children}
    </button>
  );
}

export function Bar(): React.ReactElement {
  const engine = useEngine();
  const { isAuthenticated } = useAuth();
  const [mode, setMode] = useState<TranscriptionMode>('realtime');

  const recording = engine.state === 'recording';
  const processing = engine.state === 'processing';
  const locked = !isAuthenticated || processing; // can't change mode / record

  const statusColor = useMemo(() => {
    if (!engine.connected) return 'bg-text-muted';
    if (recording) return 'bg-accent-red animate-pulse';
    if (processing) return 'bg-accent-amber animate-pulse';
    return 'bg-emerald-400';
  }, [engine.connected, recording, processing]);

  const statusLabel = !engine.connected
    ? 'Offline'
    : processing
      ? 'Processing'
      : recording
        ? 'Recording'
        : 'Ready';

  const toggleRecord = useCallback(() => {
    if (recording) {
      engine.stop();
    } else {
      const projectId = localStorage.getItem('meetscribe.selectedProjectId') ?? '';
      const autoSummarise = localStorage.getItem('meetscribe.autoSummarise') !== 'false';
      engine.start(mode, newSessionId(), 'th', projectId, autoSummarise);
    }
  }, [recording, engine, mode]);

  const openPanel = useCallback(() => void invoke('toggle_panel'), []);
  const toggleCaption = useCallback(() => void invoke('toggle_caption'), []);
  const hide = useCallback(() => void invoke('hide_bar'), []);
  const quit = useCallback(() => void invoke('quit'), []);

  // On-demand wake for the (free-tier) backend — pings /health, retrying through
  // the cold start (~30-50s) until it responds.
  const [wake, setWake] = useState<WakeState>('idle');
  const wakeServer = useCallback(async () => {
    const base = backendUrl();
    if (!base) {
      setWake('error');
      return;
    }
    setWake('waking');
    for (let i = 0; i < 8; i += 1) {
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(15000) });
        if (res.ok) {
          setWake('awake');
          return;
        }
      } catch {
        // cold start / network blip — retry
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    setWake('error');
  }, []);

  const wakeColor =
    wake === 'awake'
      ? 'text-emerald-400'
      : wake === 'error'
        ? 'text-accent-red'
        : wake === 'waking'
          ? 'text-accent-amber'
          : 'text-text-muted';

  const modeBtn = (value: TranscriptionMode, label: string, hint: string): React.ReactElement => (
    <button
      type="button"
      title={hint}
      disabled={locked || recording}
      onClick={() => setMode(value)}
      className={`px-3 py-1 rounded-md text-xs font-semibold transition whitespace-nowrap
        ${mode === value ? 'bg-accent-amber text-black shadow' : 'text-text-muted hover:text-text-primary'}
        ${locked || recording ? 'cursor-not-allowed' : ''}`}
    >
      {label}
    </button>
  );

  return (
    <div className="h-full w-full flex items-center p-1.5">
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 h-full w-full px-2.5 rounded-2xl
                   bg-[rgba(24,25,30,0.82)] backdrop-blur-xl
                   border border-white/[0.08] shadow-lg select-none"
      >
        {/* Status */}
        <div
          data-tauri-drag-region
          className="flex items-center gap-1.5 shrink-0 cursor-grab pl-0.5"
        >
          <span className={`h-2.5 w-2.5 rounded-full ${statusColor}`} />
          <span className="text-xs text-text-muted w-[68px] tabular-nums">{statusLabel}</span>
        </div>

        {/* Mode segmented control */}
        <div className="flex items-center gap-0.5 shrink-0 rounded-lg bg-black/30 p-0.5 border border-white/[0.05]">
          {modeBtn('realtime', 'Realtime', 'Live transcription as you speak (Deepgram)')}
          {modeBtn('batch', 'Normal', 'Transcribe in one batch after you stop (Groq Whisper)')}
        </div>

        {/* Record / Stop */}
        <button
          type="button"
          onClick={toggleRecord}
          disabled={locked}
          title={recording ? 'Stop recording' : 'Start recording'}
          className={`flex items-center gap-1.5 px-3 h-8 shrink-0 rounded-lg text-xs font-semibold transition
            ${locked ? 'opacity-40 cursor-not-allowed bg-surface-overlay text-text-muted' : ''}
            ${recording
              ? 'bg-accent-red text-white hover:bg-accent-red/90'
              : !locked
                ? 'bg-surface-overlay text-text-primary hover:bg-white/[0.1]'
                : ''}`}
        >
          <span
            className={recording ? 'h-2.5 w-2.5 rounded-[2px] bg-white' : 'h-2.5 w-2.5 rounded-full bg-accent-red'}
          />
          {recording ? 'Stop' : 'Record'}
        </button>

        {/* Spacer */}
        <div className="flex-1 min-w-0" />

        {/* Right controls */}
        {!isAuthenticated && (
          <button
            type="button"
            onClick={openPanel}
            className="shrink-0 text-xs px-3 h-8 rounded-lg bg-accent-amber text-black font-semibold"
          >
            Sign in
          </button>
        )}
        <button
          type="button"
          onClick={() => void wakeServer()}
          disabled={wake === 'waking'}
          title={
            wake === 'awake'
              ? 'Backend is awake'
              : wake === 'error'
                ? 'Backend unreachable — click to retry'
                : 'Wake the backend server'
          }
          className={`h-8 w-8 shrink-0 flex items-center justify-center rounded-lg transition
            hover:bg-white/[0.06] disabled:cursor-wait ${wakeColor}`}
        >
          <span className={wake === 'waking' ? 'inline-block animate-spin' : ''}>
            {wake === 'waking' ? '⟳' : '⏻'}
          </span>
        </button>

        <IconButton onClick={toggleCaption} title="Toggle floating captions">
          <span className="text-[10px] font-bold tracking-tight">CC</span>
        </IconButton>
        <IconButton onClick={openPanel} title="Open panel" disabled={!isAuthenticated}>
          ⤢
        </IconButton>
        <IconButton onClick={hide} title="Hide (reopen from the menu-bar icon)">
          –
        </IconButton>
        <IconButton onClick={quit} title="Quit" danger>
          ✕
        </IconButton>
      </div>
    </div>
  );
}
