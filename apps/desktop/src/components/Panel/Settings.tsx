import { useState } from 'react';
import type { LlmConfig } from '../../lib/llmConfig';
import { DEFAULT_LLM_CONFIG, loadLlmConfig, saveLlmConfig } from '../../lib/llmConfig';

interface Props {
  onClose: () => void;
  onApply: (config: LlmConfig) => void;
}

/** Settings modal: choose the summarisation model (local Ollama vs cloud). */
export function Settings({ onClose, onApply }: Props): React.ReactElement {
  const [config, setConfig] = useState<LlmConfig>(() => loadLlmConfig());

  const setMode = (mode: LlmConfig['mode']): void => {
    setConfig((c) => ({
      ...c,
      mode,
      // Sensible base URL default when switching modes (only if at the other default).
      baseUrl:
        mode === 'local' && !c.baseUrl ? DEFAULT_LLM_CONFIG.baseUrl : c.baseUrl,
    }));
  };

  const save = (): void => {
    const cleaned: LlmConfig = {
      ...config,
      baseUrl: config.baseUrl.trim() || DEFAULT_LLM_CONFIG.baseUrl,
      model: config.model.trim(),
      apiKey: config.mode === 'cloud' ? config.apiKey.trim() : '',
    };
    saveLlmConfig(cleaned);
    onApply(cleaned);
    onClose();
  };

  const field =
    'w-full text-sm bg-surface border border-border rounded px-3 py-2 text-text-primary ' +
    'outline-none focus:border-accent-amber placeholder:text-text-muted';

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[380px] max-w-[90%] rounded-xl bg-surface-elevated border border-border p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-text-primary">Summarisation model</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted hover:text-text-primary text-sm"
          >
            ✕
          </button>
        </div>

        {/* Mode toggle */}
        <div className="flex items-center gap-0.5 rounded-lg bg-black/30 p-0.5 border border-white/[0.05]">
          {(['local', 'cloud'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 px-3 py-1.5 rounded-md text-xs font-semibold transition
                ${config.mode === m ? 'bg-accent-amber text-black' : 'text-text-muted hover:text-text-primary'}`}
            >
              {m === 'local' ? 'Local (Ollama)' : 'Cloud'}
            </button>
          ))}
        </div>

        {/* Base URL */}
        <label className="block space-y-1">
          <span className="text-xs text-text-muted">Base URL (with port)</span>
          <input
            value={config.baseUrl}
            onChange={(e) => setConfig((c) => ({ ...c, baseUrl: e.target.value }))}
            placeholder="http://localhost:11434"
            className={field}
            spellCheck={false}
          />
        </label>

        {/* Model (free text, exact name) */}
        <label className="block space-y-1">
          <span className="text-xs text-text-muted">Model name (exact)</span>
          <input
            value={config.model}
            onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value }))}
            placeholder="e.g. llama3.1 · qwen3:8b · gemma3"
            className={field}
            spellCheck={false}
          />
          <span className="text-[10px] text-text-muted">
            Leave empty to use the sidecar default. For local, the model must be pulled
            (<code className="text-accent-amber">ollama pull &lt;name&gt;</code>).
          </span>
        </label>

        {/* API key (cloud only) */}
        {config.mode === 'cloud' && (
          <label className="block space-y-1">
            <span className="text-xs text-text-muted">API key</span>
            <input
              type="password"
              value={config.apiKey}
              onChange={(e) => setConfig((c) => ({ ...c, apiKey: e.target.value }))}
              placeholder="Bearer token"
              className={field}
              spellCheck={false}
            />
          </label>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded-md text-text-muted hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="text-sm px-4 py-1.5 rounded-md bg-accent-amber text-black font-semibold"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
