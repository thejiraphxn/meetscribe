"""Realtime transcription via Deepgram Nova-2 (WebSocket streaming).

Feeds mixed mic+system audio (Float32 → int16 PCM) to Deepgram and re-broadcasts
`transcript` events to the UI. Final segments are persisted to SQLite as they
arrive so a crash mid-session still leaves a usable transcript.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid

from deepgram import (
    DeepgramClient,
    DeepgramClientOptions,
    LiveOptions,
    LiveTranscriptionEvents,
)

from db import LocalDB, SegmentRecord
from protocol import Hub, msg_error, msg_transcript

log = logging.getLogger("meetscribe.realtime")


class RealtimeTranscriber:
    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        hub: Hub,
        db: LocalDB,
        session_id: str,
        lang: str,
    ) -> None:
        self._hub = hub
        self._db = db
        self._session_id = session_id
        self._lang = lang
        self._model = model
        self._started_at = time.time()
        self._sequence = 0
        self._reconnected = False

        options = DeepgramClientOptions(options={"keepalive": "true"})
        self._client = DeepgramClient(api_key, options)
        self._connection = None
        self._loop = asyncio.get_event_loop()

    def _live_options(self) -> LiveOptions:
        return LiveOptions(
            model=self._model,
            language=self._lang,
            encoding="linear16",
            sample_rate=16_000,
            channels=1,
            interim_results=True,
            smart_format=True,
            punctuate=True,
        )

    async def start(self) -> None:
        self._connection = self._client.listen.asyncwebsocket.v("1")
        self._connection.on(LiveTranscriptionEvents.Transcript, self._on_transcript)
        self._connection.on(LiveTranscriptionEvents.Error, self._on_error)
        ok = await self._connection.start(self._live_options())
        if not ok:
            raise RuntimeError("Deepgram connection failed to start")
        log.info("deepgram realtime started (model=%s lang=%s)", self._model, self._lang)

    async def send_pcm(self, pcm16: bytes) -> None:
        if self._connection is not None:
            await self._connection.send(pcm16)

    async def finish(self) -> None:
        if self._connection is not None:
            try:
                await self._connection.finish()
            except Exception as exc:  # noqa: BLE001
                log.warning("deepgram finish error (ignored): %s", exc)
            self._connection = None

    # --- Deepgram event handlers (called by the SDK) -----------------------

    async def _on_transcript(self, _client: object, result: object, **_kwargs: object) -> None:
        try:
            alt = result.channel.alternatives[0]  # type: ignore[attr-defined]
            text = (alt.transcript or "").strip()
            if not text:
                return
            is_final = bool(getattr(result, "is_final", False))  # type: ignore[attr-defined]
            confidence = float(getattr(alt, "confidence", 0.0) or 0.0)
            now = time.time()
            t_rel = now - self._started_at

            await self._hub.broadcast(
                msg_transcript(
                    t=now,
                    text=text,
                    is_final=is_final,
                    sequence=self._sequence,
                    confidence=confidence,
                )
            )

            if is_final:
                seg = SegmentRecord(
                    id=str(uuid.uuid4()),
                    sessionId=self._session_id,
                    sequence=self._sequence,
                    startSec=round(t_rel, 3),
                    text=text,
                    confidence=confidence,
                    isFinal=True,
                )
                self._sequence += 1
                # Persistence must never affect the live transcript that was
                # already broadcast above.
                try:
                    await asyncio.to_thread(self._db.save_segment, seg)
                except Exception as exc:  # noqa: BLE001
                    log.warning("could not persist segment (continuing): %s", exc)
        except Exception as exc:  # noqa: BLE001
            log.exception("error handling transcript: %s", exc)

    async def _on_error(self, _client: object, error: object, **_kwargs: object) -> None:
        log.error("deepgram error: %s", error)
        await self._hub.broadcast(msg_error(f"Deepgram: {error}"))
        if not self._reconnected:
            self._reconnected = True
            log.info("attempting one Deepgram reconnect")
            try:
                await self.finish()
                await self.start()
            except Exception as exc:  # noqa: BLE001
                await self._hub.broadcast(msg_error(f"Deepgram reconnect failed: {exc}"))
