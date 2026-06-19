import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ActionItemDTO,
  EngineState,
  ProcessingStep,
  TranscriptionMode,
  WsCommand,
  WsMessage,
} from '../types';

const SIDECAR_URL = 'ws://127.0.0.1:8765';
const MAX_BACKOFF_MS = 30_000;

export interface LiveSegment {
  sequence: number;
  text: string;
  isFinal: boolean;
  t: number;
  confidence?: number;
}

export interface ProcessingProgress {
  step: ProcessingStep;
  pct: number;
}

export interface EngineSyncStatus {
  status: 'syncing' | 'synced' | 'error';
  error: string | null;
}

export interface EngineApi {
  connected: boolean;
  state: EngineState;
  mode: TranscriptionMode | null;
  segments: LiveSegment[];
  interim: string;
  notes: string | null;
  actionItems: ActionItemDTO[];
  progress: ProcessingProgress | null;
  syncStatus: EngineSyncStatus | null;
  lastError: string | null;
  start: (
    mode: TranscriptionMode,
    sessionId: string,
    lang?: string,
    projectId?: string,
    autoSummarise?: boolean,
  ) => void;
  stop: () => void;
  setTitle: (title: string) => void;
  setLlmConfig: (baseUrl: string, model: string, apiKey: string) => void;
  setTranscriptionConfig: (cfg: {
    deepgramApiKey: string;
    deepgramModel: string;
    batchProvider: 'groq' | 'local';
    groqApiKey: string;
    groqModel: string;
    transcriptServiceUrl: string;
  }) => void;
  summarise: () => void;
  sync: (backendUrl: string, accessToken: string) => void;
  clear: () => void;
}

export function useEngine(): EngineApi {
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(1000);
  const reconnectTimer = useRef<number | null>(null);
  const closedByUs = useRef(false);

  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<EngineState>('idle');
  const [mode, setMode] = useState<TranscriptionMode | null>(null);
  const [segments, setSegments] = useState<LiveSegment[]>([]);
  const [interim, setInterim] = useState('');
  const [notes, setNotes] = useState<string | null>(null);
  const [actionItems, setActionItems] = useState<ActionItemDTO[]>([]);
  const [progress, setProgress] = useState<ProcessingProgress | null>(null);
  const [syncStatus, setSyncStatus] = useState<EngineSyncStatus | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const handleMessage = useCallback((msg: WsMessage) => {
    switch (msg.type) {
      case 'state':
        setState(msg.state);
        setMode(msg.mode);
        if (msg.state === 'recording') setProgress(null);
        break;
      case 'transcript':
        if (msg.is_final) {
          setInterim('');
          setSegments((prev) => {
            // Replace if we already have this sequence, else append.
            const next = prev.filter((s) => s.sequence !== msg.sequence);
            next.push({
              sequence: msg.sequence,
              text: msg.text,
              isFinal: true,
              t: msg.t,
              confidence: msg.confidence,
            });
            return next.sort((a, b) => a.sequence - b.sequence);
          });
        } else {
          setInterim(msg.text);
        }
        break;
      case 'processing_progress':
        setProgress({ step: msg.step, pct: msg.pct });
        break;
      case 'notes':
        setNotes(msg.markdown);
        break;
      case 'action_items':
        setActionItems(msg.items);
        break;
      case 'sync_status':
        setSyncStatus({ status: msg.status, error: msg.error });
        break;
      case 'error':
        setLastError(msg.message);
        break;
    }
  }, []);

  const connect = useCallback(() => {
    if (closedByUs.current) return;
    const ws = new WebSocket(SIDECAR_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      backoffRef.current = 1000;
    };
    ws.onclose = () => {
      setConnected(false);
      if (closedByUs.current) return;
      const delay = Math.min(backoffRef.current, MAX_BACKOFF_MS);
      backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
      reconnectTimer.current = window.setTimeout(connect, delay);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (event) => {
      try {
        const parsed: unknown = JSON.parse(event.data as string);
        if (parsed && typeof parsed === 'object' && 'type' in parsed) {
          handleMessage(parsed as WsMessage);
        }
      } catch {
        // ignore malformed frames
      }
    };
  }, [handleMessage]);

  useEffect(() => {
    closedByUs.current = false;
    connect();
    return () => {
      closedByUs.current = true;
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((cmd: WsCommand) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(cmd));
    } else {
      setLastError('Sidecar not connected');
    }
  }, []);

  const start = useCallback(
    (m: TranscriptionMode, sessionId: string, lang = 'th', projectId = '', autoSummarise = true) => {
      setSegments([]);
      setInterim('');
      setNotes(null);
      setActionItems([]);
      setProgress(null);
      setSyncStatus(null);
      setLastError(null);
      send({
        cmd: 'start',
        mode: m,
        session_id: sessionId,
        lang,
        project_id: projectId,
        auto_summarise: autoSummarise,
      });
    },
    [send],
  );

  const stop = useCallback(() => send({ cmd: 'stop' }), [send]);
  const setTitle = useCallback((title: string) => send({ cmd: 'set_title', title }), [send]);
  const setLlmConfig = useCallback(
    (baseUrl: string, model: string, apiKey: string) =>
      send({ cmd: 'set_llm_config', base_url: baseUrl, model, api_key: apiKey }),
    [send],
  );
  const setTranscriptionConfig = useCallback<EngineApi['setTranscriptionConfig']>(
    (cfg) =>
      send({
        cmd: 'set_transcription_config',
        deepgram_api_key: cfg.deepgramApiKey,
        deepgram_model: cfg.deepgramModel,
        batch_provider: cfg.batchProvider,
        groq_api_key: cfg.groqApiKey,
        groq_model: cfg.groqModel,
        transcript_service_url: cfg.transcriptServiceUrl,
      }),
    [send],
  );
  const summarise = useCallback(() => send({ cmd: 'summarise' }), [send]);
  const sync = useCallback(
    (backendUrl: string, accessToken: string) =>
      send({ cmd: 'sync', backend_url: backendUrl, access_token: accessToken }),
    [send],
  );
  const clear = useCallback(() => {
    setSegments([]);
    setInterim('');
    setNotes(null);
    setActionItems([]);
    send({ cmd: 'clear' });
  }, [send]);

  return {
    connected,
    state,
    mode,
    segments,
    interim,
    notes,
    actionItems,
    progress,
    syncStatus,
    lastError,
    start,
    stop,
    setTitle,
    setLlmConfig,
    setTranscriptionConfig,
    summarise,
    sync,
    clear,
  };
}
