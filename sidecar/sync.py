"""Local → cloud sync. Assembles a SessionPayload from SQLite and POSTs it to
the backend, with retry bookkeeping in the sync_queue table.

Payload shape mirrors `SessionPayload` in packages/shared/src/types.ts.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

import httpx

from db import LocalDB
from protocol import Hub, msg_sync_status

log = logging.getLogger("meetscribe.sync")

MAX_ATTEMPTS = 5


def _build_payload(db: LocalDB, session_id: str) -> dict[str, Any] | None:
    session = db.load_session(session_id)
    if session is None:
        return None
    segments = db.load_segments(session_id)
    action_items = db.load_action_items(session_id)

    return {
        "localId": session["localId"],
        "projectId": session["projectId"],
        "title": session.get("title"),
        "mode": session["mode"],
        "durationSeconds": int(session.get("durationSeconds") or 0),
        "language": session.get("language") or "th",
        "startedAt": session["startedAt"],
        "endedAt": session.get("endedAt") or session["startedAt"],
        "notes": session.get("notes"),
        "segments": [
            {
                "sequence": s["sequence"],
                "startSec": s["startSec"],
                "endSec": s.get("endSec"),
                "text": s["text"],
                "speaker": s.get("speaker"),
                "confidence": s.get("confidence"),
            }
            for s in segments
        ],
        "actionItems": [
            {"text": a["text"], "assignee": a.get("assignee")} for a in action_items
        ],
    }


async def sync_session(
    *,
    db: LocalDB,
    hub: Hub,
    session_id: str,
    backend_url: str,
    access_token: str,
) -> bool:
    """Sync a single session. Returns True on success."""
    payload = _build_payload(db, session_id)
    if payload is None:
        log.warning("sync: session %s not found locally", session_id)
        return False

    db.enqueue_sync(str(uuid.uuid4()), session_id)
    db.set_sync_status(session_id, "syncing")
    await hub.broadcast(msg_sync_status("syncing", None))

    url = backend_url.rstrip("/") + "/api/v1/sessions"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                url,
                json=payload,
                headers={"Authorization": f"Bearer {access_token}"},
            )
    except httpx.HTTPError as exc:
        db.record_sync_failure(session_id, str(exc))
        await hub.broadcast(msg_sync_status("error", str(exc)))
        log.warning("sync network error: %s", exc)
        return False

    if resp.status_code in (200, 201):
        db.dequeue_sync(session_id)
        await hub.broadcast(msg_sync_status("synced", None))
        log.info("session %s synced", session_id)
        return True

    err = f"HTTP {resp.status_code}: {resp.text[:200]}"
    db.record_sync_failure(session_id, err)
    await hub.broadcast(msg_sync_status("error", err))
    log.warning("sync failed: %s", err)
    return False


async def retry_pending(
    *, db: LocalDB, hub: Hub, backend_url: str, access_token: str
) -> None:
    """Called at startup / on demand: retry every session still in the queue."""
    pending = db.get_pending_sync(MAX_ATTEMPTS)
    if not pending:
        return
    log.info("retrying %d pending sync(s)", len(pending))
    for session_id in pending:
        await sync_session(
            db=db,
            hub=hub,
            session_id=session_id,
            backend_url=backend_url,
            access_token=access_token,
        )
