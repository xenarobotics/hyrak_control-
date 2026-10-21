"""
Speech to text for Copilot: transformers Whisper (openai/whisper-large-v3-turbo
by default), fp16 on CUDA, fp32 on CPU.

The browser sends what MediaRecorder made (webm/opus, or a wav). ffmpeg
decodes it to 16 kHz mono float32, capped at MAX_SECONDS; nothing is
written to disk. Language is English by default (a short command in
accented English is sometimes detected as another language, and the
parser only reads English); COPILOT_STT_LANGUAGE=auto lets Whisper detect it.
"""
from __future__ import annotations

import logging
import os
import subprocess
import time
from typing import Optional

import numpy as np

from app.copilot.models import ModelSlot, device_and_dtype

logger = logging.getLogger("verocore.copilot.stt")

MODEL_ID = os.environ.get("COPILOT_STT_MODEL", "openai/whisper-large-v3-turbo")
LANGUAGE = os.environ.get("COPILOT_STT_LANGUAGE", "en")
SAMPLE_RATE = 16000
MAX_SECONDS = 15.0
MAX_BYTES = 1_500_000
# Shorter than this is a click of the button, not speech.
MIN_SECONDS = 0.3


class AudioError(Exception):
    pass


def _ffmpeg(src: str, data: Optional[bytes], max_seconds: float) -> subprocess.CompletedProcess:
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", src,
           "-t", f"{max_seconds:g}", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1"]
    try:
        return subprocess.run(cmd, input=data, capture_output=True, timeout=20, check=False)
    except FileNotFoundError:
        raise AudioError("ffmpeg is not installed on the server")
    except subprocess.TimeoutExpired:
        raise AudioError("decoding the audio took too long")


def decode_audio(data: bytes, max_seconds: float = MAX_SECONDS, mime: str = "") -> np.ndarray:
    """Any container ffmpeg reads (webm/opus, ogg, mp4/aac from Safari, wav)
    to 16 kHz mono float32 in [-1, 1], at most max_seconds long. Streamed
    through a pipe; an mp4 whose index sits at the end cannot be read that
    way, so a failed pipe read is retried from a private temporary file
    that is deleted straight after."""
    if not data:
        raise AudioError("no audio")
    if len(data) > MAX_BYTES:
        raise AudioError("audio too long")
    out = _ffmpeg("pipe:0", data, max_seconds)
    if out.returncode != 0 or not out.stdout:
        import tempfile
        suffix = ".mp4" if "mp4" in mime or "m4a" in mime or "aac" in mime else ".bin"
        with tempfile.NamedTemporaryFile(prefix="copilot-", suffix=suffix) as f:
            f.write(data)
            f.flush()
            out = _ffmpeg(f.name, None, max_seconds)
    if out.returncode != 0 or not out.stdout:
        err = out.stderr.decode(errors="replace").strip().splitlines()[-1:] or ["no output"]
        raise AudioError(f"could not decode the audio ({err[0][:120]})")
    return np.frombuffer(out.stdout, dtype=np.float32).copy()


def _load():
    import torch
    from transformers import AutoProcessor, WhisperForConditionalGeneration
    device, dtype = device_and_dtype()
    processor = AutoProcessor.from_pretrained(MODEL_ID)
    model = WhisperForConditionalGeneration.from_pretrained(
        MODEL_ID, dtype=dtype, low_cpu_mem_usage=True).to(device)
    model.eval()
    torch.set_grad_enabled(False)
    return {"model": model, "processor": processor, "device": device, "dtype": dtype}


slot = ModelSlot("stt", _load)


def transcribe_array(audio: np.ndarray, language: Optional[str] = None) -> str:
    """Blocking: run on slot.executor."""
    if audio.size < int(MIN_SECONDS * SAMPLE_RATE):
        return ""
    # Silence (a held button, nobody speaking) makes Whisper invent words.
    if float(np.sqrt(np.mean(np.square(audio)))) < 0.002:
        return ""
    import torch
    m = slot.get()
    t0 = time.perf_counter()
    feats = m["processor"](audio, sampling_rate=SAMPLE_RATE, return_tensors="pt").input_features
    feats = feats.to(m["device"], dtype=m["dtype"])
    lang = language if language is not None else LANGUAGE
    kwargs = {"task": "transcribe", "max_new_tokens": 128}
    if lang and lang != "auto":
        kwargs["language"] = lang
    with torch.inference_mode():
        ids = m["model"].generate(feats, **kwargs)
    text = m["processor"].batch_decode(ids, skip_special_tokens=True)[0].strip()
    logger.info(f"Copilot STT {audio.size / SAMPLE_RATE:.1f}s audio in "
                f"{time.perf_counter() - t0:.2f}s")
    return text


def transcribe_bytes(data: bytes, mime: str = "") -> str:
    """Blocking: decode, then transcribe. Run on slot.executor."""
    return transcribe_array(decode_audio(data, mime=mime))
