"""Environment validation for the MeetScribe sidecar.

API keys are *not* hard-required at startup: the sidecar can boot and serve the
WebSocket without them, but a `start` command will fail loudly if the key for
the requested mode is missing. We still validate types/shape via pydantic so a
malformed env fails fast and clearly.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Sidecar configuration, sourced from environment variables."""

    model_config = SettingsConfigDict(
        env_prefix="",
        env_file=".env",
        extra="ignore",
    )

    # WebSocket server bind address.
    ws_host: str = Field(default="127.0.0.1", alias="MEETSCRIBE_WS_HOST")
    ws_port: int = Field(default=8765, alias="MEETSCRIBE_WS_PORT")

    # Transcription / summarisation providers. Optional at boot; required per-mode.
    deepgram_api_key: str | None = Field(default=None, alias="DEEPGRAM_API_KEY")
    groq_api_key: str | None = Field(default=None, alias="GROQ_API_KEY")

    # Transcription models (cloud).
    deepgram_model: str = Field(default="nova-2", alias="DEEPGRAM_MODEL")
    groq_whisper_model: str = Field(default="whisper-large-v3", alias="GROQ_WHISPER_MODEL")

    # Summarisation LLM via Ollama (local).
    ollama_base_url: str = Field(default="http://localhost:11434", alias="OLLAMA_BASE_URL")
    ollama_model: str = Field(default="llama3.1", alias="OLLAMA_MODEL")

    # Local SQLite store + native helper path.
    db_path: Path = Field(
        default=Path.home() / ".meetscribe" / "local.db",
        alias="MEETSCRIBE_DB_PATH",
    )
    systemtap_path: Path = Field(
        default=Path(__file__).resolve().parent.parent / "native" / "systemtap",
        alias="MEETSCRIBE_SYSTEMTAP_PATH",
    )

    # Audio.
    sample_rate: int = 16_000
    channels: int = 1
    block_size: int = 512

    @field_validator("db_path", "systemtap_path")
    @classmethod
    def _expand_user(cls, value: Path) -> Path:
        # Expand a leading ~ so `MEETSCRIBE_DB_PATH=~/.meetscribe/local.db` in
        # .env resolves to the home directory rather than a literal "~" folder.
        return value.expanduser()


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Validate and cache settings. Raises pydantic ValidationError on bad env."""
    # Allow either alias or the documented bare name; pydantic-settings reads
    # from os.environ at construction time.
    return Settings()  # type: ignore[call-arg]


def require_deepgram_key(settings: Settings) -> str:
    if not settings.deepgram_api_key:
        raise RuntimeError("DEEPGRAM_API_KEY is required for realtime mode")
    return settings.deepgram_api_key


def require_groq_key(settings: Settings) -> str:
    if not settings.groq_api_key:
        raise RuntimeError("GROQ_API_KEY is required for batch transcription / summarisation")
    return settings.groq_api_key


def env_summary() -> str:
    """Human-readable summary for boot logs (never prints secret values)."""
    s = get_settings()
    return (
        f"ws={s.ws_host}:{s.ws_port} "
        f"deepgram={'set' if s.deepgram_api_key else 'MISSING'} "
        f"groq={'set' if s.groq_api_key else 'MISSING'} "
        f"ollama={s.ollama_base_url}({s.ollama_model}) "
        f"db={s.db_path}"
    )
