import { useEffect, useRef } from 'react';
import type { ProcessingProgress, LiveSegment } from '../../hooks/useEngine';

interface Props {
  segments: LiveSegment[];
  interim: string;
  progress: ProcessingProgress | null;
  recording: boolean;
}

export function TranscriptFeed({
  segments,
  interim,
  progress,
  recording,
}: Props): React.ReactElement {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [segments, interim]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
      {segments.length === 0 && !interim && !recording && (
        <p className="text-sm text-text-muted">
          Press record to start transcribing. Live text appears here.
        </p>
      )}

      {segments.map((seg) => (
        <p key={seg.sequence} className="text-sm text-text-primary leading-relaxed">
          {seg.text}
          {seg.confidence !== undefined && seg.confidence < 0.6 && (
            <span className="ml-1 text-[10px] text-accent-amber" title="low confidence">
              ?
            </span>
          )}
        </p>
      ))}

      {interim && (
        <p className="text-sm text-text-muted italic leading-relaxed">
          {interim}
          <span className="inline-block ml-1 animate-pulse">▍</span>
        </p>
      )}

      {progress && (
        <div className="mt-3">
          <div className="flex justify-between text-xs text-text-muted mb-1">
            <span className="capitalize">{progress.step}…</span>
            <span>{progress.pct}%</span>
          </div>
          <div className="h-1 bg-surface-overlay rounded">
            <div
              className="h-1 bg-accent-amber rounded transition-all"
              style={{ width: `${progress.pct}%` }}
            />
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
