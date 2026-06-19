"""WebSocket protocol helpers — message builders and the broadcast hub.

Message shapes mirror `packages/shared/src/types.ts` (`WsMessage` / `WsCommand`).
Keep the two in sync.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Literal

from websockets.asyncio.server import ServerConnection

log = logging.getLogger("meetscribe.protocol")

EngineState = Literal["idle", "recording", "processing"]
ProcessingStep = Literal["transcribing", "summarising", "saving"]
TranscriptionMode = Literal["realtime", "batch"]


# --- Outbound message builders (sidecar → UI) ------------------------------


def msg_state(state: EngineState, mode: TranscriptionMode | None) -> dict[str, Any]:
    return {"type": "state", "state": state, "mode": mode}


def msg_transcript(
    *,
    t: float,
    text: str,
    is_final: bool,
    sequence: int,
    speaker: str | None = None,
    confidence: float | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "type": "transcript",
        "t": t,
        "text": text,
        "is_final": is_final,
        "sequence": sequence,
    }
    if speaker is not None:
        out["speaker"] = speaker
    if confidence is not None:
        out["confidence"] = confidence
    return out


def msg_processing(step: ProcessingStep, pct: int) -> dict[str, Any]:
    return {"type": "processing_progress", "step": step, "pct": pct}


def msg_notes(markdown: str) -> dict[str, Any]:
    return {"type": "notes", "markdown": markdown}


def msg_action_items(items: list[dict[str, Any]]) -> dict[str, Any]:
    return {"type": "action_items", "items": items}


def msg_sync_status(status: str, error: str | None) -> dict[str, Any]:
    return {"type": "sync_status", "status": status, "error": error}


def msg_error(message: str) -> dict[str, Any]:
    return {"type": "error", "message": message}


# --- Broadcast hub ----------------------------------------------------------


class Hub:
    """Tracks connected clients and fans out broadcast messages to all of them."""

    def __init__(self) -> None:
        self._clients: set[ServerConnection] = set()
        self._lock = asyncio.Lock()

    async def register(self, ws: ServerConnection) -> None:
        async with self._lock:
            self._clients.add(ws)
        log.info("client connected (%d total)", len(self._clients))

    async def unregister(self, ws: ServerConnection) -> None:
        async with self._lock:
            self._clients.discard(ws)
        log.info("client disconnected (%d total)", len(self._clients))

    async def broadcast(self, message: dict[str, Any]) -> None:
        """Send `message` to every connected client; drop dead connections."""
        payload = json.dumps(message, ensure_ascii=False)
        async with self._lock:
            targets = list(self._clients)
        dead: list[ServerConnection] = []
        for ws in targets:
            try:
                await ws.send(payload)
            except Exception:  # noqa: BLE001 - any send failure means a dead client
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)
