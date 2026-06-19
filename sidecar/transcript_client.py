"""Reusable client for the local transcript-service (Faster-Whisper).

Optional helper — the sidecar's batch transcription currently uses Groq Whisper
(transcribe_batch.py); this module lets you transcribe via the self-hosted
local service instead, without duplicating model loading in the sidecar.

Usage:
    from transcript_client import transcribe_file
    result = await transcribe_file("meeting.wav", language="th")
    # result -> {"text", "segments", "language", "language_probability", "duration"}

The service URL comes from TRANSCRIPT_SERVICE_URL (default http://localhost:9099;
use http://transcript-service:9099 when calling across the Docker network).
"""

from __future__ import annotations

import os
from typing import Any

import httpx

DEFAULT_URL = os.getenv("TRANSCRIPT_SERVICE_URL", "http://localhost:9099")


async def transcribe_file(
    audio_path: str,
    *,
    language: str = "th",
    beam_size: int = 5,
    vad_filter: bool = True,
    output: str = "full",
    base_url: str | None = None,
    timeout: float = 600.0,
) -> dict[str, Any]:
    """POST an audio file to the local transcript-service and return its JSON.

    Raises httpx.HTTPStatusError on a non-2xx response.
    """
    url = (base_url or DEFAULT_URL).rstrip("/") + "/transcribe"
    with open(audio_path, "rb") as fh:
        files = {"file": (os.path.basename(audio_path), fh.read())}
    data = {
        "language": language,
        "beam_size": str(beam_size),
        "vad_filter": str(vad_filter).lower(),
        "output": output,
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, data=data, files=files)
        resp.raise_for_status()
        return resp.json()


async def health(base_url: str | None = None, timeout: float = 5.0) -> dict[str, Any]:
    """Return the service /health payload (status, model_path, device, ...)."""
    url = (base_url or DEFAULT_URL).rstrip("/") + "/health"
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.json()
