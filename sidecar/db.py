"""SQLite local store — mirrors the PostgreSQL/Prisma schema column-for-column.

`localId` (UUID4 generated on device) is the primary key for sessions and is
what the backend upserts on, making sync idempotent.

All public methods are synchronous (sqlite3 is fast + local); callers on the
asyncio loop should wrap them with `asyncio.to_thread` for the rare slow write.
"""

from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  localId         TEXT PRIMARY KEY,
  projectId       TEXT NOT NULL,
  title           TEXT,
  mode            TEXT NOT NULL,
  durationSeconds INTEGER NOT NULL DEFAULT 0,
  language        TEXT NOT NULL DEFAULT 'th',
  startedAt       TEXT NOT NULL,
  endedAt         TEXT,
  notes           TEXT,
  syncStatus      TEXT NOT NULL DEFAULT 'pending',
  createdAt       TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id         TEXT PRIMARY KEY,
  sessionId  TEXT NOT NULL REFERENCES sessions(localId) ON DELETE CASCADE,
  sequence   INTEGER NOT NULL,
  startSec   REAL NOT NULL,
  endSec     REAL,
  text       TEXT NOT NULL,
  speaker    TEXT,
  confidence REAL,
  isFinal    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_segments_session ON transcript_segments(sessionId, sequence);

CREATE TABLE IF NOT EXISTS action_items (
  id        TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL REFERENCES sessions(localId) ON DELETE CASCADE,
  text      TEXT NOT NULL,
  assignee  TEXT,
  done      INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_queue (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  attempts   INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
"""


@dataclass
class SessionRecord:
    localId: str
    projectId: str
    mode: str
    startedAt: str
    language: str = "th"
    title: str | None = None
    durationSeconds: int = 0
    endedAt: str | None = None
    notes: str | None = None


@dataclass
class SegmentRecord:
    id: str
    sessionId: str
    sequence: int
    startSec: float
    text: str
    endSec: float | None = None
    speaker: str | None = None
    confidence: float | None = None
    isFinal: bool = True


@dataclass
class ActionItemRecord:
    id: str
    sessionId: str
    text: str
    assignee: str | None = None
    done: bool = False


class LocalDB:
    """Thread-safe wrapper around a single SQLite connection."""

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA foreign_keys=ON;")
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # --- writes ------------------------------------------------------------

    def save_session(self, s: SessionRecord) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO sessions
                  (localId, projectId, title, mode, durationSeconds, language,
                   startedAt, endedAt, notes, syncStatus)
                VALUES (?,?,?,?,?,?,?,?,?, 'pending')
                ON CONFLICT(localId) DO UPDATE SET
                  title=excluded.title,
                  durationSeconds=excluded.durationSeconds,
                  endedAt=excluded.endedAt,
                  notes=excluded.notes
                """,
                (
                    s.localId, s.projectId, s.title, s.mode, s.durationSeconds,
                    s.language, s.startedAt, s.endedAt, s.notes,
                ),
            )
            self._conn.commit()

    def update_session_notes(self, local_id: str, notes: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE sessions SET notes=? WHERE localId=?", (notes, local_id)
            )
            self._conn.commit()

    def update_session_title(self, local_id: str, title: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE sessions SET title=? WHERE localId=?", (title, local_id)
            )
            self._conn.commit()

    def finalize_session(self, local_id: str, ended_at: str, duration: int) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE sessions SET endedAt=?, durationSeconds=? WHERE localId=?",
                (ended_at, duration, local_id),
            )
            self._conn.commit()

    def save_segment(self, seg: SegmentRecord) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO transcript_segments
                  (id, sessionId, sequence, startSec, endSec, text, speaker, confidence, isFinal)
                VALUES (?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                  text=excluded.text, endSec=excluded.endSec,
                  confidence=excluded.confidence, isFinal=excluded.isFinal
                """,
                (
                    seg.id, seg.sessionId, seg.sequence, seg.startSec, seg.endSec,
                    seg.text, seg.speaker, seg.confidence, int(seg.isFinal),
                ),
            )
            self._conn.commit()

    def save_action_item(self, item: ActionItemRecord) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO action_items (id, sessionId, text, assignee, done)
                VALUES (?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET text=excluded.text, assignee=excluded.assignee
                """,
                (item.id, item.sessionId, item.text, item.assignee, int(item.done)),
            )
            self._conn.commit()

    def replace_action_items(self, session_id: str, items: list[ActionItemRecord]) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM action_items WHERE sessionId=?", (session_id,))
            self._conn.executemany(
                "INSERT INTO action_items (id, sessionId, text, assignee, done) VALUES (?,?,?,?,?)",
                [(i.id, i.sessionId, i.text, i.assignee, int(i.done)) for i in items],
            )
            self._conn.commit()

    # --- sync bookkeeping --------------------------------------------------

    def set_sync_status(self, session_id: str, status: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE sessions SET syncStatus=? WHERE localId=?", (status, session_id)
            )
            self._conn.commit()

    def enqueue_sync(self, queue_id: str, session_id: str) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO sync_queue (id, session_id) VALUES (?, ?)
                ON CONFLICT(id) DO NOTHING
                """,
                (queue_id, session_id),
            )
            self._conn.commit()

    def record_sync_failure(self, session_id: str, error: str) -> None:
        with self._lock:
            self._conn.execute(
                """
                UPDATE sync_queue
                SET attempts = attempts + 1, last_error = ?
                WHERE session_id = ?
                """,
                (error, session_id),
            )
            self._conn.execute(
                "UPDATE sessions SET syncStatus='error' WHERE localId=?", (session_id,)
            )
            self._conn.commit()

    def dequeue_sync(self, session_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM sync_queue WHERE session_id=?", (session_id,))
            self._conn.execute(
                "UPDATE sessions SET syncStatus='synced' WHERE localId=?", (session_id,)
            )
            self._conn.commit()

    def get_pending_sync(self, max_attempts: int = 5) -> list[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT session_id FROM sync_queue WHERE attempts < ? ORDER BY created_at",
                (max_attempts,),
            ).fetchall()
        return [r["session_id"] for r in rows]

    # --- reads (used by sync.py to assemble the payload) -------------------

    def load_session(self, local_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM sessions WHERE localId=?", (local_id,)
            ).fetchone()
        return dict(row) if row else None

    def load_segments(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM transcript_segments WHERE sessionId=? ORDER BY sequence",
                (session_id,),
            ).fetchall()
        return [dict(r) for r in rows]

    def load_action_items(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM action_items WHERE sessionId=? ORDER BY rowid",
                (session_id,),
            ).fetchall()
        return [dict(r) for r in rows]
