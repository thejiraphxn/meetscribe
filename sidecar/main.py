"""MeetScribe sidecar — entry point.

Opens a WebSocket server on ws://127.0.0.1:8765 and runs a small state machine:

    IDLE → (start) → RECORDING → (stop) → PROCESSING → IDLE

Models are API-based (Deepgram + Groq), so startup is cheap — no model loading.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any

# macOS / python.org Python ships without linked system CA certs, which breaks
# TLS to Deepgram (wss://) with CERTIFICATE_VERIFY_FAILED. Point OpenSSL at
# certifi's bundle before any TLS connection is made.
try:
    import certifi

    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    os.environ.setdefault("SSL_CERT_DIR", os.path.dirname(certifi.where()))
except ImportError:
    pass

from websockets.asyncio.server import ServerConnection, serve

from audio import AudioMixer, MicCapture, SystemAudioCapture, float32_to_pcm16
from config import get_settings, require_deepgram_key, require_groq_key, env_summary
from db import LocalDB, SessionRecord
from protocol import Hub, msg_error, msg_processing, msg_state
from summarise import Summariser
from sync import retry_pending, sync_session
from transcribe_batch import BatchTranscriber
from transcribe_realtime import RealtimeTranscriber

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
log = logging.getLogger("meetscribe.main")

# How often (seconds) to regenerate the live summary during a realtime recording.
LIVE_SUMMARY_INTERVAL = 25.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Engine:
    """Owns the recording lifecycle. One active session at a time."""

    def __init__(self, hub: Hub, db: LocalDB) -> None:
        self._hub = hub
        self._db = db
        self._settings = get_settings()
        self._state: str = "idle"
        self._mode: str | None = None

        # Per-session runtime state.
        self._session_id: str | None = None
        self._lang: str = "th"
        self._started_at_iso: str | None = None
        self._started_at_mono: float = 0.0
        self._segment_texts: list[str] = []

        self._capture_task: asyncio.Task[None] | None = None
        self._live_summary_task: asyncio.Task[None] | None = None
        self._last_summary_count: int = 0

        # LLM (Ollama) config overrides from the UI; fall back to settings.
        self._llm_base_url: str | None = None
        self._llm_model: str | None = None
        self._llm_api_key: str | None = None
        self._mic: MicCapture | None = None
        self._system: SystemAudioCapture | None = None
        self._realtime: RealtimeTranscriber | None = None
        self._batch: BatchTranscriber | None = None

    @property
    def state(self) -> str:
        return self._state

    async def _set_state(self, state: str, mode: str | None) -> None:
        self._state = state
        self._mode = mode
        await self._hub.broadcast(msg_state(state, mode))  # type: ignore[arg-type]

    # --- commands ----------------------------------------------------------

    async def start(
        self, mode: str, session_id: str, lang: str, project_id: str = ""
    ) -> None:
        if self._state != "idle":
            await self._hub.broadcast(msg_error(f"cannot start while {self._state}"))
            return
        if mode not in ("realtime", "batch"):
            await self._hub.broadcast(msg_error(f"unknown mode: {mode}"))
            return

        self._session_id = session_id
        self._lang = lang
        self._started_at_iso = _now_iso()
        self._started_at_mono = time.monotonic()
        self._segment_texts = []
        self._last_summary_count = 0

        # Persist a pending session row up front so segments have a parent.
        await asyncio.to_thread(
            self._db.save_session,
            SessionRecord(
                localId=session_id,
                projectId=project_id,  # supplied by the UI at start
                mode=mode,
                startedAt=self._started_at_iso,
                language=lang,
            ),
        )

        try:
            await self._start_capture(mode)
        except Exception as exc:  # noqa: BLE001
            log.exception("failed to start capture")
            await self._hub.broadcast(msg_error(f"start failed: {exc}"))
            await self._teardown_capture()
            await self._set_state("idle", None)
            return

        await self._set_state("recording", mode)
        log.info("recording started: mode=%s session=%s lang=%s", mode, session_id, lang)

    async def _start_capture(self, mode: str) -> None:
        loop = asyncio.get_running_loop()
        self._mic = MicCapture(loop)
        self._system = SystemAudioCapture(self._settings.systemtap_path)
        await self._system.start()
        self._mic.start()

        assert self._session_id is not None
        if mode == "realtime":
            key = require_deepgram_key(self._settings)
            self._realtime = RealtimeTranscriber(
                api_key=key,
                model=self._settings.deepgram_model,
                hub=self._hub,
                db=self._db,
                session_id=self._session_id,
                lang=self._lang,
            )
            await self._realtime.start()
            # Periodically summarise the in-progress transcript (live notes).
            self._live_summary_task = asyncio.create_task(self._live_summary_loop())
        else:
            key = require_groq_key(self._settings)
            self._batch = BatchTranscriber(
                api_key=key,
                model=self._settings.groq_whisper_model,
                hub=self._hub,
                db=self._db,
                session_id=self._session_id,
                lang=self._lang,
            )

        mixer = AudioMixer(self._mic, self._system)
        self._capture_task = asyncio.create_task(self._pump(mixer, mode))

    async def _pump(self, mixer: AudioMixer, mode: str) -> None:
        try:
            async for frame in mixer.frames():
                if mode == "realtime" and self._realtime is not None:
                    await self._realtime.send_pcm(float32_to_pcm16(frame))
                elif mode == "batch" and self._batch is not None:
                    self._batch.add_frame(frame)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("capture pump error")
            await self._hub.broadcast(msg_error(f"capture error: {exc}"))

    async def _live_summary_loop(self) -> None:
        """Realtime mode only: every LIVE_SUMMARY_INTERVAL seconds, re-summarise
        the transcript captured so far and push fresh notes + action items.
        Skips a cycle if no new final segments arrived since the last summary."""
        summariser = self._make_summariser()
        try:
            while True:
                await asyncio.sleep(LIVE_SUMMARY_INTERVAL)
                if self._session_id is None:
                    continue
                segments = await asyncio.to_thread(
                    self._db.load_segments, self._session_id
                )
                if len(segments) <= self._last_summary_count:
                    continue  # nothing new to summarise yet
                self._last_summary_count = len(segments)
                texts = [s["text"] for s in segments]
                try:
                    await summariser.run(self._session_id, texts, live=True)
                    log.info("live summary updated (%d segments)", len(segments))
                except Exception as exc:  # noqa: BLE001
                    log.warning("live summary failed (continuing): %s", exc)
        except asyncio.CancelledError:
            raise

    async def stop(self) -> None:
        if self._state != "recording":
            await self._hub.broadcast(msg_error(f"cannot stop while {self._state}"))
            return
        assert self._session_id is not None

        await self._set_state("processing", self._mode)
        duration = int(time.monotonic() - self._started_at_mono)
        ended_iso = _now_iso()

        # Stop audio capture first.
        await self._teardown_capture(stop_transcribers=False)

        try:
            if self._mode == "realtime" and self._realtime is not None:
                await self._realtime.finish()
                self._segment_texts = [
                    s["text"] for s in self._db.load_segments(self._session_id)
                ]
            elif self._mode == "batch" and self._batch is not None:
                self._segment_texts = await self._batch.transcribe()
        except Exception as exc:  # noqa: BLE001
            log.exception("transcription finalisation failed")
            await self._hub.broadcast(msg_error(f"transcription failed: {exc}"))

        await asyncio.to_thread(
            self._db.finalize_session, self._session_id, ended_iso, duration
        )

        # Auto-summarise once the transcript is complete.
        await self.summarise()

        await self._hub.broadcast(msg_processing("saving", 100))
        self._realtime = None
        self._batch = None
        await self._set_state("idle", None)
        log.info("session %s processed (%ds)", self._session_id, duration)

    async def set_title(self, title: str) -> None:
        if self._session_id is None:
            return
        await asyncio.to_thread(self._db.update_session_title, self._session_id, title)

    async def set_llm_config(
        self, base_url: str, model: str, api_key: str | None
    ) -> None:
        self._llm_base_url = base_url.strip() or None
        self._llm_model = model.strip() or None
        self._llm_api_key = (api_key or "").strip() or None
        log.info(
            "llm config set: base_url=%s model=%s key=%s",
            self._llm_base_url or "(default)",
            self._llm_model or "(default)",
            "set" if self._llm_api_key else "none",
        )

    def _make_summariser(self) -> Summariser:
        return Summariser(
            base_url=self._llm_base_url or self._settings.ollama_base_url,
            model=self._llm_model or self._settings.ollama_model,
            api_key=self._llm_api_key,
            hub=self._hub,
            db=self._db,
        )

    async def summarise(self) -> None:
        if self._session_id is None:
            await self._hub.broadcast(msg_error("no session to summarise"))
            return
        await self._make_summariser().run(self._session_id, self._segment_texts)

    async def sync(self, backend_url: str, access_token: str) -> None:
        if self._session_id is not None:
            await sync_session(
                db=self._db,
                hub=self._hub,
                session_id=self._session_id,
                backend_url=backend_url,
                access_token=access_token,
            )
        # Also flush any older pending sessions.
        await retry_pending(
            db=self._db, hub=self._hub, backend_url=backend_url, access_token=access_token
        )

    async def clear(self) -> None:
        if self._state == "recording":
            await self._teardown_capture()
        self._session_id = None
        self._segment_texts = []
        self._realtime = None
        self._batch = None
        await self._set_state("idle", None)

    async def _teardown_capture(self, *, stop_transcribers: bool = True) -> None:
        if self._live_summary_task is not None:
            self._live_summary_task.cancel()
            try:
                await self._live_summary_task
            except asyncio.CancelledError:
                pass
            self._live_summary_task = None
        if self._capture_task is not None:
            self._capture_task.cancel()
            try:
                await self._capture_task
            except asyncio.CancelledError:
                pass
            self._capture_task = None
        if self._mic is not None:
            self._mic.stop()
            self._mic = None
        if self._system is not None:
            await self._system.stop()
            self._system = None
        if stop_transcribers and self._realtime is not None:
            await self._realtime.finish()
            self._realtime = None


async def handle_command(engine: Engine, hub: Hub, raw: str) -> None:
    try:
        cmd: dict[str, Any] = json.loads(raw)
    except json.JSONDecodeError:
        await hub.broadcast(msg_error("invalid JSON command"))
        return

    action = cmd.get("cmd")
    try:
        if action == "start":
            await engine.start(
                mode=cmd.get("mode", "realtime"),
                session_id=cmd.get("session_id") or str(uuid.uuid4()),
                lang=cmd.get("lang", "th"),
                project_id=cmd.get("project_id") or "",
            )
        elif action == "stop":
            await engine.stop()
        elif action == "set_title":
            await engine.set_title(cmd.get("title", ""))
        elif action == "set_llm_config":
            await engine.set_llm_config(
                base_url=cmd.get("base_url", ""),
                model=cmd.get("model", ""),
                api_key=cmd.get("api_key"),
            )
        elif action == "summarise":
            await engine.summarise()
        elif action == "sync":
            await engine.sync(cmd.get("backend_url", ""), cmd.get("access_token", ""))
        elif action == "clear":
            await engine.clear()
        else:
            await hub.broadcast(msg_error(f"unknown command: {action}"))
    except Exception as exc:  # noqa: BLE001
        log.exception("command %s failed", action)
        await hub.broadcast(msg_error(f"{action} failed: {exc}"))


async def main() -> None:
    settings = get_settings()
    log.info("MeetScribe sidecar starting — %s", env_summary())
    db = LocalDB(settings.db_path)
    hub = Hub()
    engine = Engine(hub, db)

    async def connection_handler(ws: ServerConnection) -> None:
        await hub.register(ws)
        # Send current state to the freshly connected client.
        try:
            await ws.send(json.dumps(msg_state(engine.state, None)))
        except Exception:  # noqa: BLE001
            pass
        try:
            async for message in ws:
                if isinstance(message, bytes):
                    message = message.decode("utf-8", errors="replace")
                await handle_command(engine, hub, message)
        finally:
            await hub.unregister(ws)

    async with serve(connection_handler, settings.ws_host, settings.ws_port):
        log.info("WebSocket server listening on ws://%s:%d", settings.ws_host, settings.ws_port)
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("sidecar shutting down")
