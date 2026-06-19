import { useEffect, useState } from 'react';
import type { ProjectDTO } from '../../types';
import { api } from '../../api/client';

/** Shared between the panel and bar windows (same origin → shared localStorage). */
export const SELECTED_PROJECT_KEY = 'meetscribe.selectedProjectId';

interface Props {
  selectedId: string | null;
  onSelect: (projectId: string) => void;
}

export function ProjectSelector({ selectedId, onSelect }: Props): React.ReactElement {
  // Persist the selection so the bar window knows which project to record into.
  const select = (projectId: string): void => {
    if (projectId) localStorage.setItem(SELECTED_PROJECT_KEY, projectId);
    onSelect(projectId);
  };
  const [projects, setProjects] = useState<ProjectDTO[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const list = await api.listProjects();
      setProjects(list);
      if (!selectedId && list[0]) select(list[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load projects');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async (): Promise<void> => {
    const name = newName.trim();
    if (!name) return;
    try {
      const project = await api.createProject(name);
      setNewName('');
      setCreating(false);
      setProjects((prev) => [project, ...prev]);
      select(project.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create project');
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-text-muted">Project</span>
        <button
          type="button"
          onClick={() => setCreating((c) => !c)}
          className="text-xs text-accent-amber hover:underline"
        >
          {creating ? 'Cancel' : '+ New'}
        </button>
      </div>

      {creating ? (
        <div className="flex gap-1 items-stretch">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            placeholder="Project name"
            className="flex-1 min-w-0 text-sm bg-surface-elevated border border-border rounded px-2 py-1
                       text-text-primary outline-none focus:border-accent-amber"
            autoFocus
          />
          <button
            type="button"
            onClick={() => void create()}
            className="shrink-0 text-sm px-2 rounded bg-accent-amber text-black font-medium"
          >
            Add
          </button>
        </div>
      ) : (
        <select
          value={selectedId ?? ''}
          onChange={(e) => select(e.target.value)}
          className="w-full min-w-0 text-sm bg-surface-elevated border border-border rounded px-2 py-1.5
                     text-text-primary outline-none focus:border-accent-amber"
        >
          {projects.length === 0 && <option value="">No projects yet</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.sessionCount !== undefined ? ` (${p.sessionCount})` : ''}
            </option>
          ))}
        </select>
      )}

      {error && <p className="text-xs text-accent-red">{error}</p>}
    </div>
  );
}
