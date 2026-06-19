# transcript-service

Self-hosted local transcription using **Faster-Whisper** (CTranslate2). FastAPI
service exposing `POST /transcribe` and `GET /health` on port **9099**.

The model init + transcription approach follows the Faster-Whisper usage pattern
from the reference `whisper-server` project (lazy single model instance;
transcribe with a temperature fallback ladder, VAD + a no-VAD fallback, and
`condition_on_previous_text=False` to avoid repetition loops).

---

## 1. Model path

Place the CTranslate2 model on the host at:

```
models/biodatlab-th-small-ct2/
```

Inside the container it resolves to `MODEL_PATH=/app/models/biodatlab-th-small-ct2`
(the `./models` host folder is mounted to `/app/models`). Required files usually:
`model.bin`, `config.json`, `tokenizer.json`, `preprocessor_config.json`,
`vocabulary.json`. See [`../models/README.md`](../models/README.md).

## 2. Environment variables

| Var            | Default                              | Notes                          |
| -------------- | ------------------------------------ | ------------------------------ |
| `MODEL_PATH`   | `/app/models/biodatlab-th-small-ct2` | CTranslate2 model directory    |
| `DEVICE`       | `cpu`                                | `cpu` or `cuda`                |
| `COMPUTE_TYPE` | `int8`                               | `int8` (CPU) / `float16` (GPU) |
| `DEFAULT_LANGUAGE` | `th`                             | used when language is auto/empty |
| `CPU_THREADS`  | `0` (auto)                           | ctranslate2 worker threads     |
| `PORT`         | `9099`                               | server port                    |

**CPU:**
```env
DEVICE=cpu
COMPUTE_TYPE=int8
```

**GPU** (requires an NVIDIA runtime / CUDA base image — the provided Dockerfile is
CPU-only; for GPU use a CUDA-enabled image and the NVIDIA container toolkit):
```env
DEVICE=cuda
COMPUTE_TYPE=float16
```

---

## 3. Run with Docker Compose (recommended)

From the repository root:

```bash
docker compose up --build transcript-service
```

This builds the image, mounts `./models` → `/app/models`, and publishes `9099`.

## 4. Run with Docker directly

```bash
cd transcript-service
docker build -t meetscribe-transcript-service .
docker run --rm -p 9099:9099 \
  -v "$(pwd)/../models:/app/models" \
  -e MODEL_PATH=/app/models/biodatlab-th-small-ct2 \
  -e DEVICE=cpu -e COMPUTE_TYPE=int8 \
  meetscribe-transcript-service
```

## 5. Run locally (no Docker)

```bash
cd transcript-service
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
MODEL_PATH=../models/biodatlab-th-small-ct2 DEVICE=cpu COMPUTE_TYPE=int8 \
  uvicorn app:app --host 0.0.0.0 --port 9099
```

---

## 6. API

### `GET /health`
```bash
curl http://localhost:9099/health
```
```json
{
  "status": "ok",
  "model_path": "/app/models/biodatlab-th-small-ct2",
  "device": "cpu",
  "compute_type": "int8",
  "model_loaded": true,
  "model_present": true
}
```

### `POST /transcribe` (multipart/form-data)

| field        | type   | default | notes                                  |
| ------------ | ------ | ------- | -------------------------------------- |
| `file`       | file   | —       | audio (wav/mp3/m4a/flac/ogg via ffmpeg)|
| `language`   | string | `th`    | `en` for English; `auto` / empty = auto-detect |
| `beam_size`  | int    | `5`     |                                        |
| `vad_filter` | bool   | `true`  | voice-activity filter (with no-VAD fallback) |
| `output`     | string | `full`  | `text` \| `segments` \| `full`         |

```bash
# Simplest — Thai by default, full response
curl -X POST http://localhost:9099/transcribe \
  -F "file=@sample.wav"

# English, plain text only
curl -X POST http://localhost:9099/transcribe \
  -F "file=@sample.wav" -F "language=en" -F "output=text"

# Auto-detect language, segments with timestamps
curl -X POST http://localhost:9099/transcribe \
  -F "file=@sample.wav" -F "language=auto" -F "output=segments"
```

`output=full` response:
```json
{
  "text": "...",
  "segments": [{ "start": 0.0, "end": 1.23, "text": "..." }],
  "language": "th",
  "language_probability": 0.98,
  "duration": 10.5
}
```

---

## 7. Integration with the MeetScribe sidecar (Python)

A reusable client is provided at [`../sidecar/transcript_client.py`](../sidecar/transcript_client.py)
— it calls this service without duplicating model loading. The sidecar's existing
Groq-based batch transcription is left intact; use this when you prefer the local
model.

```python
from transcript_client import transcribe_file

# In the sidecar (async context):
result = await transcribe_file("meeting.wav", language="th")
# result -> {"text", "segments", "language", "language_probability", "duration"}
```

Set the service URL via env:
```env
# local dev
TRANSCRIPT_SERVICE_URL=http://localhost:9099
# across the Docker network
TRANSCRIPT_SERVICE_URL=http://transcript-service:9099
```

The returned `segments` (`start`/`end`/`text`) map directly onto the sidecar's
`SegmentRecord` fields, so `transcribe_batch.py` could be extended to call
`transcribe_file()` instead of Groq while keeping the same downstream contract.

---

## 8. Troubleshooting

- **`model.bin not found` / `/health` shows `model_present: false`** — the model
  isn't in `models/biodatlab-th-small-ct2/`. Download/copy the CTranslate2 files
  there (see `../models/README.md`). The `model.bin` weights are git-ignored.
- **`POST /transcribe` returns 503** — the model couldn't load (missing/corrupt
  model dir, or wrong `COMPUTE_TYPE` for the device). Check container logs.
- **`400 invalid output type`** — `output` must be `text`, `segments`, or `full`.
- **Slow on CPU** — keep `COMPUTE_TYPE=int8`; raise `CPU_THREADS`, or move to GPU
  (`DEVICE=cuda`, `COMPUTE_TYPE=float16`) with a CUDA image.
- **Audio won't decode** — ffmpeg is installed in the image; for local (non-Docker)
  runs, install ffmpeg on your machine.
