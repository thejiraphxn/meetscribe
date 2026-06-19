"""Batch transcription via Groq Whisper (whisper-large-v3).

Buffers Float32 audio during recording, then on stop writes a temporary WAV and
sends it to Groq for a full transcript with segment-level timestamps.
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import uuid
import wave

import numpy as np
from groq import Groq

from db import LocalDB, SegmentRecord
from protocol import Hub, msg_processing, msg_transcript

log = logging.getLogger("meetscribe.batch")

SAMPLE_RATE = 16_000


class BatchTranscriber:
    def __init__(
        self,
        *,
        hub: Hub,
        db: LocalDB,
        session_id: str,
        lang: str,
        provider: str = "groq",
        api_key: str | None = None,
        model: str = "whisper-large-v3",
        transcript_service_url: str | None = None,
    ) -> None:
        self._provider = provider
        self._model = model
        self._transcript_service_url = transcript_service_url
        # Groq client created lazily only when actually using the cloud provider.
        self._client = Groq(api_key=api_key) if (provider == "groq" and api_key) else None
        self._hub = hub
        self._db = db
        self._session_id = session_id
        self._lang = lang
        self._chunks: list[np.ndarray] = []

    def add_frame(self, frame: np.ndarray) -> None:
        """Accumulate a mixed audio frame (called during recording)."""
        self._chunks.append(frame)

    def _write_wav(self) -> str:
        audio = (
            np.concatenate(self._chunks) if self._chunks else np.zeros(0, dtype=np.float32)
        )
        pcm16 = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
        fd, path = tempfile.mkstemp(suffix=".wav", prefix="meetscribe-")
        os.close(fd)
        with wave.open(path, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)  # 16-bit
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(pcm16.tobytes())
        return path

    async def transcribe(self) -> list[str]:
        """Run on stop. Returns the list of segment texts (for summarisation)."""
        await self._hub.broadcast(msg_processing("transcribing", 10))
        wav_path = await asyncio.to_thread(self._write_wav)
        try:
            if self._provider == "local":
                segments = await self._call_local(wav_path)
            else:
                result = await asyncio.to_thread(self._call_groq, wav_path)
                segments = self._extract_segments(result)
        finally:
            try:
                os.remove(wav_path)
            except OSError:
                pass

        await self._hub.broadcast(msg_processing("transcribing", 80))
        texts: list[str] = []

        for sequence, seg in enumerate(segments):
            text = (seg.get("text") or "").strip()
            if not text:
                continue
            start = float(seg.get("start", 0.0) or 0.0)
            end_raw = seg.get("end")
            end = float(end_raw) if end_raw is not None else None

            record = SegmentRecord(
                id=str(uuid.uuid4()),
                sessionId=self._session_id,
                sequence=sequence,
                startSec=round(start, 3),
                endSec=round(end, 3) if end is not None else None,
                text=text,
                isFinal=True,
            )
            await asyncio.to_thread(self._db.save_segment, record)
            await self._hub.broadcast(
                msg_transcript(t=start, text=text, is_final=True, sequence=sequence)
            )
            texts.append(text)

        await self._hub.broadcast(msg_processing("transcribing", 100))
        return texts

    async def _call_local(self, wav_path: str) -> list[dict[str, object]]:
        """Transcribe via the self-hosted transcript-service (Faster-Whisper)."""
        from transcript_client import transcribe_file

        result = await transcribe_file(
            wav_path,
            language=self._lang,
            output="segments",
            base_url=self._transcript_service_url,
        )
        return [
            {"start": s.get("start", 0.0), "end": s.get("end"), "text": s.get("text", "")}
            for s in (result.get("segments") or [])
        ]

    def _call_groq(self, wav_path: str) -> object:
        with open(wav_path, "rb") as fh:
            return self._client.audio.transcriptions.create(
                file=(os.path.basename(wav_path), fh.read()),
                model=self._model,
                language=self._lang,
                response_format="verbose_json",
                timestamp_granularities=["segment"],
            )

    @staticmethod
    def _extract_segments(result: object) -> list[dict[str, object]]:
        # Groq SDK returns an object with `.segments`; fall back to dict access.
        segments = getattr(result, "segments", None)
        if segments is None and isinstance(result, dict):
            segments = result.get("segments")
        if not segments:
            # No timestamped segments — wrap the flat text as a single segment.
            text = getattr(result, "text", "") or (
                result.get("text", "") if isinstance(result, dict) else ""
            )
            return [{"start": 0.0, "end": None, "text": text}] if text else []
        normalised: list[dict[str, object]] = []
        for s in segments:
            if isinstance(s, dict):
                normalised.append(s)
            else:
                normalised.append(
                    {
                        "start": getattr(s, "start", 0.0),
                        "end": getattr(s, "end", None),
                        "text": getattr(s, "text", ""),
                    }
                )
        return normalised
