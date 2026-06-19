# MeetScribe sidecar

Python audio engine. Captures mic + system audio, transcribes (Deepgram realtime
or Groq batch), summarises (local Ollama LLM), stores locally in SQLite, and syncs to
the backend. Talks to the desktop app over `ws://127.0.0.1:8765`.

## Setup

```bash
cd sidecar
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in DEEPGRAM_API_KEY + GROQ_API_KEY
python main.py
```

## Protocol

Commands (UI → sidecar) and broadcasts (sidecar → UI) mirror the `WsCommand` /
`WsMessage` unions in `packages/shared/src/types.ts`.

| File                     | Responsibility                                  |
| ------------------------ | ----------------------------------------------- |
| `main.py`                | WS server + IDLE→RECORDING→PROCESSING state machine |
| `audio.py`               | mic + system capture, mixing, Float32→PCM16     |
| `transcribe_realtime.py` | Deepgram Nova-2 streaming                        |
| `transcribe_batch.py`    | Groq Whisper batch                              |
| `summarise.py`           | Ollama (local LLM) → Thai Markdown + action items |
| `db.py`                  | SQLite local store (mirrors Prisma schema)      |
| `sync.py`                | local → cloud `POST /api/v1/sessions`           |
| `config.py`              | pydantic env validation                         |

System audio requires the compiled `native/systemtap` helper (see `native/README.md`).
Without it, the sidecar falls back to mic-only capture.
