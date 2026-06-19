/** Transcription provider config, persisted locally and pushed to the sidecar.
 *  All values live only on this machine (localStorage); never sent to the backend. */
export interface TranscriptionConfig {
  /** Realtime — Deepgram. */
  deepgramApiKey: string;
  deepgramModel: string;
  /** Batch — Groq Whisper (cloud) or the local transcript-service. */
  batchProvider: 'groq' | 'local';
  groqApiKey: string;
  groqModel: string;
  /** Local transcript-service base URL (incl. port). */
  transcriptServiceUrl: string;
}

const KEY = 'meetscribe.transcriptionConfig';

export const DEFAULT_TRANSCRIPTION_CONFIG: TranscriptionConfig = {
  deepgramApiKey: '',
  deepgramModel: '',
  batchProvider: 'groq',
  groqApiKey: '',
  groqModel: '',
  transcriptServiceUrl: 'http://localhost:9099',
};

export function loadTranscriptionConfig(): TranscriptionConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_TRANSCRIPTION_CONFIG };
    return { ...DEFAULT_TRANSCRIPTION_CONFIG, ...(JSON.parse(raw) as Partial<TranscriptionConfig>) };
  } catch {
    return { ...DEFAULT_TRANSCRIPTION_CONFIG };
  }
}

export function saveTranscriptionConfig(config: TranscriptionConfig): void {
  localStorage.setItem(KEY, JSON.stringify(config));
}

export function hasSavedTranscriptionConfig(): boolean {
  return localStorage.getItem(KEY) !== null;
}
