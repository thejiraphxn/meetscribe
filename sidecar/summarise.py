"""Summarisation via Ollama (local LLM, e.g. llama3.1 / qwen2.5).

Takes the list of transcript segment texts, asks the model for a Thai-language
Markdown summary, then parses Action Items out of the response.

Uses Ollama's native chat endpoint (`POST {base_url}/api/chat`). Run a model
first with e.g. `ollama pull llama3.1` (qwen2.5 tends to handle Thai better).
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid

import httpx

from db import ActionItemRecord, LocalDB
from protocol import Hub, msg_action_items, msg_notes, msg_processing

log = logging.getLogger("meetscribe.summarise")

_SYSTEM_PROMPT = """คุณเป็นผู้ช่วยจดบันทึกการประชุม ตอบเป็นภาษาไทย
สรุปออกมาในรูปแบบ Markdown:
## สรุปประเด็นหลัก
- bullet points

## การตัดสินใจ
- bullet points

## Action Items
- [ ] งาน (ผู้รับผิดชอบ: ชื่อ)"""

# Matches "- [ ] task text (ผู้รับผิดชอบ: name)" — assignee group optional.
_ACTION_RE = re.compile(
    r"-\s*\[[ xX]?\]\s*(?P<text>.+?)(?:\s*\(ผู้รับผิดชอบ:\s*(?P<assignee>.+?)\))?\s*$"
)


class Summariser:
    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        hub: Hub,
        db: LocalDB,
        api_key: str | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._api_key = api_key or None
        self._hub = hub
        self._db = db

    async def run(
        self, session_id: str, segment_texts: list[str], *, live: bool = False
    ) -> str:
        """Summarise, broadcast notes + action items, persist them. Returns markdown.

        When `live=True` (periodic summary during an ongoing recording) the
        `processing_progress` broadcasts are skipped — only notes + action items
        are pushed, so the UI updates without showing a "processing" progress bar.
        """
        if not live:
            await self._hub.broadcast(msg_processing("summarising", 20))
        transcript = "\n".join(t for t in segment_texts if t.strip())
        if not transcript:
            empty = "## สรุปประเด็นหลัก\n- (ไม่มีเนื้อหา)"
            await self._hub.broadcast(msg_notes(empty))
            return empty

        markdown = await self._call_ollama(transcript)
        if not live:
            await self._hub.broadcast(msg_processing("summarising", 80))

        await asyncio.to_thread(self._db.update_session_notes, session_id, markdown)
        await self._hub.broadcast(msg_notes(markdown))

        items = self._parse_action_items(markdown)
        records = [
            ActionItemRecord(
                id=str(uuid.uuid4()),
                sessionId=session_id,
                text=it["text"],
                assignee=it.get("assignee"),
            )
            for it in items
        ]
        await asyncio.to_thread(self._db.replace_action_items, session_id, records)
        await self._hub.broadcast(
            msg_action_items([{"text": it["text"], "assignee": it.get("assignee")} for it in items])
        )
        if not live:
            await self._hub.broadcast(msg_processing("summarising", 100))
        return markdown

    async def _call_ollama(self, transcript: str) -> str:
        payload = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": f"บันทึกการสนทนา:\n\n{transcript}"},
            ],
            "stream": False,
            "options": {"temperature": 0.3},
        }
        url = f"{self._base_url}/api/chat"
        headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else None
        async with httpx.AsyncClient(timeout=180.0) as client:
            try:
                resp = await client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                raise RuntimeError(
                    f"Ollama request failed ({url}): {exc}. "
                    f"Is Ollama running and the model '{self._model}' pulled?"
                ) from exc
        data = resp.json()
        content = data.get("message", {}).get("content", "")
        return content.strip() if content else ""

    @staticmethod
    def _parse_action_items(markdown: str) -> list[dict[str, str | None]]:
        items: list[dict[str, str | None]] = []
        in_section = False
        for line in markdown.splitlines():
            stripped = line.strip()
            if stripped.lower().startswith("## action items") or "action items" in stripped.lower() and stripped.startswith("#"):
                in_section = True
                continue
            if stripped.startswith("## "):
                in_section = False
            if not in_section:
                continue
            match = _ACTION_RE.match(stripped)
            if match:
                text = match.group("text").strip()
                assignee = match.group("assignee")
                if text:
                    items.append({"text": text, "assignee": assignee.strip() if assignee else None})
        return items
