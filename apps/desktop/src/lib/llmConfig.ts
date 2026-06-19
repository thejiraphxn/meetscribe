/** LLM (summarisation) configuration, persisted locally and pushed to the sidecar. */
export interface LlmConfig {
  /** 'local' = Ollama on this machine; 'cloud' = a hosted Ollama-compatible endpoint. */
  mode: 'local' | 'cloud';
  /** Ollama-compatible base URL incl. port, e.g. http://localhost:11434 */
  baseUrl: string;
  /** Exact model name as pulled/hosted, e.g. llama3.1 or qwen3:8b (free text). */
  model: string;
  /** Bearer token for cloud endpoints (ignored for local). */
  apiKey: string;
}

const KEY = 'meetscribe.llmConfig';

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  mode: 'local',
  baseUrl: 'http://localhost:11434',
  model: '',
  apiKey: '',
};

export function loadLlmConfig(): LlmConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_LLM_CONFIG };
    const parsed = JSON.parse(raw) as Partial<LlmConfig>;
    return { ...DEFAULT_LLM_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_LLM_CONFIG };
  }
}

export function saveLlmConfig(config: LlmConfig): void {
  localStorage.setItem(KEY, JSON.stringify(config));
}

/** True once the user has explicitly saved a config (so we push it to the sidecar). */
export function hasSavedLlmConfig(): boolean {
  return localStorage.getItem(KEY) !== null;
}
