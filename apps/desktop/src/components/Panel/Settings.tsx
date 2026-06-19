import { useState } from 'react';
import type { LlmConfig } from '../../lib/llmConfig';
import { DEFAULT_LLM_CONFIG, loadLlmConfig, saveLlmConfig } from '../../lib/llmConfig';
import type { TranscriptionConfig } from '../../lib/transcriptionConfig';
import {
  loadTranscriptionConfig,
  saveTranscriptionConfig,
} from '../../lib/transcriptionConfig';

interface Props {
  onClose: () => void;
  onApplyLlm: (config: LlmConfig) => void;
  onApplyTranscription: (config: TranscriptionConfig) => void;
}

const FIELD =
  'w-full text-sm bg-surface border border-border rounded px-3 py-2 text-text-primary ' +
  'outline-none focus:border-accent-amber placeholder:text-text-muted';

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="space-y-2">
      <h3 className="text-xs uppercase tracking-wide text-accent-amber">{title}</h3>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  password = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  password?: boolean;
}): React.ReactElement {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-text-muted">{label}</span>
      <input
        type={password ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={FIELD}
        spellCheck={false}
      />
    </label>
  );
}

/** Settings modal: configure transcription (Deepgram / Groq / local) + summarisation (Ollama). */
export function Settings({ onClose, onApplyLlm, onApplyTranscription }: Props): React.ReactElement {
  const [llm, setLlm] = useState<LlmConfig>(() => loadLlmConfig());
  const [trans, setTrans] = useState<TranscriptionConfig>(() => loadTranscriptionConfig());

  const save = (): void => {
    const cleanedLlm: LlmConfig = {
      ...llm,
      baseUrl: llm.baseUrl.trim() || DEFAULT_LLM_CONFIG.baseUrl,
      model: llm.model.trim(),
      apiKey: llm.mode === 'cloud' ? llm.apiKey.trim() : '',
    };
    const cleanedTrans: TranscriptionConfig = {
      ...trans,
      deepgramApiKey: trans.deepgramApiKey.trim(),
      deepgramModel: trans.deepgramModel.trim(),
      groqApiKey: trans.groqApiKey.trim(),
      groqModel: trans.groqModel.trim(),
      transcriptServiceUrl: trans.transcriptServiceUrl.trim(),
    };
    saveLlmConfig(cleanedLlm);
    saveTranscriptionConfig(cleanedTrans);
    onApplyLlm(cleanedLlm);
    onApplyTranscription(cleanedTrans);
    onClose();
  };

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-[420px] max-w-full max-h-full overflow-y-auto rounded-xl
                   bg-surface-elevated border border-border p-5 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between sticky top-0">
          <h2 className="text-base font-semibold text-text-primary">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted hover:text-text-primary text-sm"
          >
            ✕
          </button>
        </div>
        <p className="text-[11px] text-text-muted -mt-3">
          You provide your own API keys (no shared defaults). Stored only on this
          machine; never sent to the backend.
        </p>

        {/* Realtime — Deepgram */}
        <Section title="Realtime transcription · Deepgram">
          <Field
            label="API key (required)"
            password
            value={trans.deepgramApiKey}
            onChange={(v) => setTrans((c) => ({ ...c, deepgramApiKey: v }))}
            placeholder="your Deepgram API key"
          />
          <Field
            label="Model"
            value={trans.deepgramModel}
            onChange={(v) => setTrans((c) => ({ ...c, deepgramModel: v }))}
            placeholder="e.g. nova-2 · nova-3 (empty = default)"
          />
        </Section>

        {/* Batch — Groq vs Local */}
        <Section title="Batch transcription">
          <div className="flex items-center gap-0.5 rounded-lg bg-black/30 p-0.5 border border-white/[0.05]">
            {(['groq', 'local'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setTrans((c) => ({ ...c, batchProvider: p }))}
                className={`flex-1 px-3 py-1.5 rounded-md text-xs font-semibold transition
                  ${trans.batchProvider === p ? 'bg-accent-amber text-black' : 'text-text-muted hover:text-text-primary'}`}
              >
                {p === 'groq' ? 'Groq (cloud)' : 'Local model'}
              </button>
            ))}
          </div>

          {trans.batchProvider === 'groq' ? (
            <>
              <Field
                label="Groq API key (required)"
                password
                value={trans.groqApiKey}
                onChange={(v) => setTrans((c) => ({ ...c, groqApiKey: v }))}
                placeholder="your Groq API key"
              />
              <Field
                label="Whisper model"
                value={trans.groqModel}
                onChange={(v) => setTrans((c) => ({ ...c, groqModel: v }))}
                placeholder="e.g. whisper-large-v3 (empty = default)"
              />
            </>
          ) : (
            <>
              <Field
                label="transcript-service URL"
                value={trans.transcriptServiceUrl}
                onChange={(v) => setTrans((c) => ({ ...c, transcriptServiceUrl: v }))}
                placeholder="http://localhost:9099"
              />
              <p className="text-[10px] text-text-muted">
                Uses the self-hosted Faster-Whisper service (model in{' '}
                <code className="text-accent-amber">models/biodatlab-th-small-ct2</code>).
                Run it with <code className="text-accent-amber">docker compose up transcript-service</code>.
              </p>
            </>
          )}
        </Section>

        {/* Summarisation — Ollama */}
        <Section title="Summarisation · Ollama LLM">
          <div className="flex items-center gap-0.5 rounded-lg bg-black/30 p-0.5 border border-white/[0.05]">
            {(['local', 'cloud'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setLlm((c) => ({ ...c, mode: m }))}
                className={`flex-1 px-3 py-1.5 rounded-md text-xs font-semibold transition
                  ${llm.mode === m ? 'bg-accent-amber text-black' : 'text-text-muted hover:text-text-primary'}`}
              >
                {m === 'local' ? 'Local (Ollama)' : 'Cloud'}
              </button>
            ))}
          </div>
          <Field
            label="Base URL (with port)"
            value={llm.baseUrl}
            onChange={(v) => setLlm((c) => ({ ...c, baseUrl: v }))}
            placeholder="http://localhost:11434"
          />
          <Field
            label="Model name (exact)"
            value={llm.model}
            onChange={(v) => setLlm((c) => ({ ...c, model: v }))}
            placeholder="e.g. llama3.1 · qwen3:8b (empty = default)"
          />
          {llm.mode === 'cloud' && (
            <Field
              label="API key"
              password
              value={llm.apiKey}
              onChange={(v) => setLlm((c) => ({ ...c, apiKey: v }))}
              placeholder="Bearer token"
            />
          )}
        </Section>

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
