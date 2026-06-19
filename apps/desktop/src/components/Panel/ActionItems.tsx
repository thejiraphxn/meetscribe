import { useState } from 'react';
import type { ActionItemDTO } from '../../types';

interface Props {
  items: ActionItemDTO[];
}

/**
 * Live action items (pre-sync) — toggling here is local-only optimism; once a
 * session is synced, persisted items are toggled through the backend.
 */
export function ActionItems({ items }: Props): React.ReactElement {
  const [done, setDone] = useState<Set<number>>(new Set());

  const toggle = (index: number): void => {
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className="px-4 py-3">
      <h3 className="text-xs uppercase tracking-wide text-text-muted mb-2">Action items</h3>
      {items.length === 0 ? (
        <p className="text-sm text-text-muted">None yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item, i) => (
            <li key={`${item.text}-${i}`} className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={done.has(i)}
                onChange={() => toggle(i)}
                className="mt-1 accent-accent-amber"
              />
              <span
                className={`text-sm ${done.has(i) ? 'line-through text-text-muted' : 'text-text-primary'}`}
              >
                {item.text}
                {item.assignee && (
                  <span className="ml-1 text-xs text-accent-amber">@{item.assignee}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
