import { useEffect, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';

/**
 * Plays a session's local recording, if one exists on this machine.
 * Recordings are stored locally only (~/.meetscribe/recordings/<localId>.wav)
 * and are never synced, so this renders nothing for sessions recorded elsewhere.
 */
export function RecordingPlayer({ localId }: { localId: string }): React.ReactElement | null {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSrc(null);
    void invoke<string | null>('recording_path', { localId })
      .then((path) => {
        if (active) setSrc(path ? convertFileSrc(path) : null);
      })
      .catch(() => {
        if (active) setSrc(null);
      });
    return () => {
      active = false;
    };
  }, [localId]);

  if (!src) return null;

  return (
    <div className="shrink-0 px-4 py-2 flex items-center gap-3 border-b border-border/60 bg-surface-elevated/40">
      <span className="text-[10px] uppercase tracking-wide text-text-muted shrink-0">Recording</span>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio controls src={src} className="h-8 w-full" />
    </div>
  );
}
