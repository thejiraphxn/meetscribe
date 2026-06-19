"""MeetScribe local transcription service — Faster-Whisper (CTranslate2).

Self-hosted FastAPI wrapper around a local CTranslate2 Whisper model. The model
init + transcription approach follows the Faster-Whisper usage pattern from the
reference `whisper-server` project (lazy single instance; transcribe with a
temperature fallback ladder, VAD with a no-VAD fallback, and
`condition_on_previous_text=False` to avoid repetition loops).

Endpoints:
  POST /transcribe   multipart: file, language, beam_size, vad_filter, output
  GET  /health       status, model_path, device, compute_type
"""

from __future__ import annotations

import logging
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from faster_whisper import WhisperModel

# --------------------------------------------------------------------------
# Configuration (all env-overridable)
# --------------------------------------------------------------------------

MODEL_PATH = os.getenv("MODEL_PATH", "/app/models/biodatlab-th-small-ct2")
DEVICE = os.getenv("DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("COMPUTE_TYPE", "int8")
DEFAULT_LANGUAGE = os.getenv("DEFAULT_LANGUAGE", "th")
# ctranslate2 worker threads (CPU path). 0 = let ctranslate2 pick (~num cores).
CPU_THREADS = int((os.getenv("CPU_THREADS", "0") or "0").split("#")[0].strip() or "0")
# Scratch dir for uploaded audio; cleaned up after every request.
TMP_DIR = os.getenv("TMP_DIR", tempfile.gettempdir())

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
log = logging.getLogger("transcript-service")

# --------------------------------------------------------------------------
# Model lifecycle — lazy, single instance, shared across requests
# --------------------------------------------------------------------------

_model: Optional[WhisperModel] = None


def _model_present() -> bool:
    """True if the CTranslate2 model directory + weights exist on disk."""
    return os.path.isdir(MODEL_PATH) and os.path.exists(os.path.join(MODEL_PATH, "model.bin"))


def _load_model() -> WhisperModel:
    if not os.path.isdir(MODEL_PATH):
        raise FileNotFoundError(f"model directory not found: {MODEL_PATH}")
    if not _model_present():
        raise FileNotFoundError(
            f"model.bin not found in {MODEL_PATH} — place the CTranslate2 model "
            "there (see models/README.md)"
        )
    log.info(
        "loading model from %s (device=%s, compute_type=%s, cpu_threads=%s)",
        MODEL_PATH,
        DEVICE,
        COMPUTE_TYPE,
        CPU_THREADS or "auto",
    )
    # Passing a filesystem path loads the local CT2 model directly;
    # local_files_only avoids any Hugging Face hub lookup.
    return WhisperModel(
        MODEL_PATH,
        device=DEVICE,
        compute_type=COMPUTE_TYPE,
        cpu_threads=CPU_THREADS,
        local_files_only=True,
    )


def get_model() -> WhisperModel:
    global _model
    if _model is None:
        _model = _load_model()
    return _model


# --------------------------------------------------------------------------
# Transcription
# --------------------------------------------------------------------------


def _resolve_language(language: str | None) -> str | None:
    """Map the request language to faster-whisper's expectation.

    "" or "auto" -> None (auto-detect); otherwise the code as-is (e.g. th, en).
    """
    lang = (language or "").strip().lower()
    if lang in ("", "auto"):
        return None
    return lang


def _transcribe(path: str, language: str | None, beam_size: int, vad_filter: bool) -> tuple[list[Any], Any]:
    model = get_model()
    kwargs: dict[str, Any] = {
        "language": _resolve_language(language),
        "beam_size": beam_size,
        # Temperature fallback ladder — retries on low-confidence / repetitive
        # output instead of locking into a greedy repetition loop.
        "temperature": [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
        "compression_ratio_threshold": 2.4,
        "log_prob_threshold": -1.0,
        "no_speech_threshold": 0.6,
        # Breaks repetition cascades — don't feed a hallucinated line back in.
        "condition_on_previous_text": False,
    }
    if vad_filter:
        kwargs["vad_filter"] = True
        kwargs["vad_parameters"] = {
            "threshold": 0.35,
            "min_speech_duration_ms": 200,
            "min_silence_duration_ms": 300,
        }

    def _do(use_vad: bool) -> tuple[list[Any], Any]:
        local = dict(kwargs)
        if not use_vad:
            local.pop("vad_filter", None)
            local.pop("vad_parameters", None)
        segments_iter, info = model.transcribe(path, **local)
        return list(segments_iter), info

    try:
        segments, info = _do(use_vad=vad_filter)
    except ValueError as exc:
        # faster-whisper raises "max() iterable argument is empty" when no
        # speech frames are found; retry once without VAD.
        if "max() iterable argument is empty" not in str(exc):
            raise
        log.warning("VAD pass found no speech for %s — retrying without VAD", path)
        try:
            segments, info = _do(use_vad=False)
        except ValueError as exc2:
            if "max() iterable argument is empty" in str(exc2):
                return [], info_for_empty(language)
            raise

    # VAD ran but produced nothing on a clearly non-empty clip — retry no-VAD.
    if vad_filter and not segments and os.path.getsize(path) > 10_000:
        log.warning("VAD produced 0 segments for %s — retrying without VAD", path)
        try:
            segments, info = _do(use_vad=False)
        except ValueError as exc:
            if "max() iterable argument is empty" not in str(exc):
                raise
            return [], info_for_empty(language)

    return segments, info


def info_for_empty(language: str | None) -> Any:
    from types import SimpleNamespace

    return SimpleNamespace(
        language=_resolve_language(language) or DEFAULT_LANGUAGE or "unknown",
        language_probability=0.0,
        duration=0.0,
    )


# --------------------------------------------------------------------------
# App
# --------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Best-effort preload so the first request is fast; tolerate a missing model
    # so /health can still report the problem instead of crash-looping.
    try:
        await run_in_threadpool(get_model)
        log.info("model loaded and ready")
    except Exception as exc:  # noqa: BLE001
        log.warning("model not loaded at startup: %s", exc)
    yield


app = FastAPI(title="MeetScribe Transcript Service", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    present = _model_present()
    return {
        "status": "ok" if (_model is not None or present) else "degraded",
        "model_path": MODEL_PATH,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "model_loaded": _model is not None,
        "model_present": present,
    }


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form("th"),
    beam_size: int = Form(5),
    vad_filter: bool = Form(True),
    output: str = Form("full"),
) -> Any:
    if output not in ("text", "segments", "full"):
        raise HTTPException(
            status_code=400,
            detail="invalid output type — expected one of: text, segments, full",
        )

    # Surface a missing model as 503 (service not ready) rather than 500.
    try:
        get_model()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception:  # noqa: BLE001
        log.exception("model failed to load")
        raise HTTPException(status_code=503, detail="model failed to load")

    suffix = Path(file.filename or "audio").suffix or ".bin"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix, prefix="upload-", dir=TMP_DIR)
    os.close(fd)
    try:
        content = await file.read()
        if not content:
            raise HTTPException(status_code=400, detail="empty file upload")
        with open(tmp_path, "wb") as fh:
            fh.write(content)

        segments, info = await run_in_threadpool(
            _transcribe, tmp_path, language, beam_size, vad_filter
        )
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001
        log.exception("transcription failed")
        raise HTTPException(status_code=500, detail="transcription failed")
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    seg_list = [
        {
            "start": round(float(s.start), 3),
            "end": round(float(s.end), 3),
            "text": (s.text or "").strip(),
        }
        for s in segments
    ]
    full_text = " ".join(s["text"] for s in seg_list if s["text"]).strip()

    if output == "text":
        return {"text": full_text}
    if output == "segments":
        return {"segments": seg_list}
    return {
        "text": full_text,
        "segments": seg_list,
        "language": getattr(info, "language", None),
        "language_probability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 4),
        "duration": round(float(getattr(info, "duration", 0.0) or 0.0), 3),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "9099")))
