import { useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useEngine } from '../../hooks/useEngine';

/**
 * Floating caption overlay — a compact, always-on-top pill that shows the live
 * realtime transcript over other apps. Draggable; closes itself via the ✕.
 */
export function Caption(): React.ReactElement {
  const engine = useEngine();

  // Show the last couple of finalized segments plus the current interim text,
  // kept short so the overlay stays small.
  const line = useMemo(() => {
    const finals = engine.segments.slice(-2).map((s) => s.text);
    const parts = [...finals, engine.interim].filter(Boolean);
    return parts.join(' ');
  }, [engine.segments, engine.interim]);

  const idle = engine.state !== 'recording' && !line;

  return (
    <div className="h-full w-full flex items-center justify-center p-2">
      <div
        data-tauri-drag-region
        className="relative w-full max-h-full overflow-hidden px-5 py-3 rounded-2xl
                   bg-black/75 backdrop-blur-xl border border-white/10 shadow-2xl select-none"
      >
        {/* Close button */}
        <button
          type="button"
          onClick={() => void invoke('toggle_caption')}
          title="Hide captions"
          className="absolute top-1.5 right-2 text-white/40 hover:text-white text-xs leading-none"
        >
          ✕
        </button>

        {/* Live indicator */}
        <div className="flex items-center gap-1.5 mb-1" data-tauri-drag-region>
          <span
            className={`h-2 w-2 rounded-full ${
              engine.state === 'recording' ? 'bg-accent-red animate-pulse' : 'bg-text-muted'
            }`}
          />
          <span className="text-[10px] uppercase tracking-wide text-white/40">
            {engine.state === 'recording' ? 'Live' : 'Captions'}
          </span>
        </div>

        <p
          data-tauri-drag-region
          className="text-[15px] leading-snug text-white/95 line-clamp-2"
        >
          {line || (
            <span className="text-white/40">
              {idle ? 'Start a realtime recording to see live captions…' : ''}
              <span className="inline-block ml-0.5 animate-pulse">▍</span>
            </span>
          )}
          {line && engine.interim && (
            <span className="inline-block ml-0.5 animate-pulse text-white/60">▍</span>
          )}
        </p>
      </div>
    </div>
  );
}
