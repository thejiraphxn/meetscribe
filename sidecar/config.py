"""Environment validation for the MeetScribe sidecar.

Transcription API keys + models are NOT read from the environment — the user
provides them in the app's Settings (sent via `set_transcription_config`). This
file only handles infra (WebSocket bind, local paths) and the Ollama
summarisation defaults.
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

    # Transcription keys + models are supplied by the app at runtime (no env
    # fallback). See set_transcription_config in main.py.

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


def env_summary() -> str:
    """Human-readable summary for boot logs (never prints secret values)."""
    s = get_settings()
    return (
        f"ws={s.ws_host}:{s.ws_port} "
        f"transcription=user-provided "
        f"ollama={s.ollama_base_url}({s.ollama_model}) "
        f"db={s.db_path}"
    )
