"""Audio capture — microphone + system audio, mixed to a single mono stream.

`MicCapture`         : sounddevice InputStream → asyncio queue of Float32 frames.
`SystemAudioCapture` : subprocess wrapping ./native/systemtap, reads Float32 PCM
                       from its stdout.
`AudioMixer`         : sums mic + system, clips to [-1, 1], yields mixed frames.

Everything downstream consumes mono Float32 numpy arrays at 16 kHz.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import AsyncIterator

import numpy as np
import sounddevice as sd

log = logging.getLogger("meetscribe.audio")

SAMPLE_RATE = 16_000
CHANNELS = 1
BLOCK_SIZE = 512
_BYTES_PER_BLOCK = BLOCK_SIZE * 4  # Float32


class MicCapture:
    """Microphone capture via sounddevice, bridged onto the asyncio loop."""

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._queue: asyncio.Queue[np.ndarray] = asyncio.Queue(maxsize=64)
        self._stream: sd.InputStream | None = None

    def _callback(self, indata: np.ndarray, frames: int, time_info: object, status: object) -> None:
        if status:
            log.warning("mic status: %s", status)
        # indata is (frames, channels) float32; flatten to mono.
        mono = indata[:, 0].copy() if indata.ndim > 1 else indata.copy()
        # sounddevice runs this on a non-asyncio thread → hop back to the loop.
        self._loop.call_soon_threadsafe(self._enqueue, mono)

    def _enqueue(self, frame: np.ndarray) -> None:
        try:
            self._queue.put_nowait(frame)
        except asyncio.QueueFull:
            # Drop oldest to stay realtime.
            try:
                self._queue.get_nowait()
                self._queue.put_nowait(frame)
            except asyncio.QueueEmpty:
                pass

    def start(self) -> None:
        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            blocksize=BLOCK_SIZE,
            dtype="float32",
            callback=self._callback,
        )
        self._stream.start()
        log.info("mic capture started @ %dHz", SAMPLE_RATE)

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
            log.info("mic capture stopped")

    async def frames(self) -> AsyncIterator[np.ndarray]:
        while True:
            yield await self._queue.get()


class SystemAudioCapture:
    """Wraps the Swift `systemtap` helper, reading Float32 PCM from its stdout."""

    def __init__(self, helper_path: Path) -> None:
        self._helper_path = helper_path
        self._proc: asyncio.subprocess.Process | None = None

    @property
    def available(self) -> bool:
        return self._helper_path.exists()

    async def start(self) -> bool:
        if not self.available:
            log.warning("systemtap helper not found at %s — system audio disabled", self._helper_path)
            return False
        self._proc = await asyncio.create_subprocess_exec(
            str(self._helper_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        asyncio.create_task(self._drain_stderr())
        log.info("system audio capture started (pid %s)", self._proc.pid)
        return True

    async def _drain_stderr(self) -> None:
        if self._proc is None or self._proc.stderr is None:
            return
        async for line in self._proc.stderr:
            log.info("systemtap: %s", line.decode(errors="replace").rstrip())

    async def stop(self) -> None:
        if self._proc is None:
            return
        try:
            self._proc.terminate()
            await asyncio.wait_for(self._proc.wait(), timeout=2.0)
        except (ProcessLookupError, asyncio.TimeoutError):
            try:
                self._proc.kill()
            except ProcessLookupError:
                pass
        finally:
            self._proc = None
            log.info("system audio capture stopped")

    async def frames(self) -> AsyncIterator[np.ndarray]:
        if self._proc is None or self._proc.stdout is None:
            return
        stdout = self._proc.stdout
        while True:
            chunk = await stdout.readexactly(_BYTES_PER_BLOCK)
            yield np.frombuffer(chunk, dtype=np.float32).copy()


class AudioMixer:
    """Sums mic + (optional) system frames into a single mono stream.

    When system audio is unavailable, this is a pass-through of the mic.
    """

    def __init__(self, mic: MicCapture, system: SystemAudioCapture | None) -> None:
        self._mic = mic
        self._system = system

    async def frames(self) -> AsyncIterator[np.ndarray]:
        if self._system is None or not self._system.available:
            async for frame in self._mic.frames():
                yield np.clip(frame, -1.0, 1.0)
            return

        # Pull from both; pad to the shorter length and sum.
        mic_iter = self._mic.frames()
        sys_iter = self._system.frames()
        sys_buf = np.zeros(0, dtype=np.float32)

        async for mic_frame in mic_iter:
            try:
                while sys_buf.shape[0] < mic_frame.shape[0]:
                    sys_buf = np.concatenate([sys_buf, await asyncio.wait_for(sys_iter.__anext__(), 0.05)])
            except (asyncio.TimeoutError, StopAsyncIteration):
                pass

            n = mic_frame.shape[0]
            sys_slice = sys_buf[:n]
            if sys_slice.shape[0] < n:
                sys_slice = np.pad(sys_slice, (0, n - sys_slice.shape[0]))
            sys_buf = sys_buf[n:]

            mixed = np.clip(mic_frame + sys_slice, -1.0, 1.0)
            yield mixed


def float32_to_pcm16(frame: np.ndarray) -> bytes:
    """Convert Float32 [-1,1] → little-endian int16 PCM bytes (for Deepgram)."""
    clipped = np.clip(frame, -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


def write_wav_file(path: str, frames: list[np.ndarray], sample_rate: int = SAMPLE_RATE) -> None:
    """Write accumulated Float32 frames to a 16-bit mono WAV (for local playback)."""
    import wave

    audio = np.concatenate(frames) if frames else np.zeros(0, dtype=np.float32)
    pcm16 = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm16.tobytes())
