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
import re
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


def container_of(data: bytes) -> str:
    """The ffmpeg demuxer for what a browser recorder makes, from the file's
    own signature (never the client's mime string): webm/matroska, ogg,
    wav, or mp4/m4a. Anything else is refused before ffmpeg sees it, so a
    crafted upload cannot pick a demuxer (playlists, concat lists) that
    opens other files or URLs."""
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "matroska"
    if data[:4] == b"OggS":
        return "ogg"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav"
    if data[4:8] == b"ftyp":
        return "mov"
    raise AudioError("unsupported audio format")


def _ffmpeg(src: str, data: Optional[bytes], max_seconds: float, fmt: str) -> subprocess.CompletedProcess:
    # The demuxer is fixed by container_of and only the pipe or our own
    # temporary file may be read.
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
           "-protocol_whitelist", "pipe,file", "-f", fmt, "-i", src,
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
    fmt = container_of(data)
    out = _ffmpeg("pipe:0", data, max_seconds, fmt)
    if out.returncode != 0 or not out.stdout:
        import tempfile
        suffix = ".mp4" if "mp4" in mime or "m4a" in mime or "aac" in mime else ".bin"
        with tempfile.NamedTemporaryFile(prefix="copilot-", suffix=suffix) as f:
            f.write(data)
            f.flush()
            out = _ffmpeg(f.name, None, max_seconds, fmt)
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


# Drone command vocabulary given to Whisper as a prompt: it decodes the
# words a pilot actually says (take off, metres, survey, orbit) instead of
# the nearest everyday phrase, which matters for short, quiet clips.
VOCAB_PROMPT = ("Drone pilot commands: take off to 10 metres, land, hold, stop, come back, "
                "return home, go up 5 metres, move forward 20 metres, follow the man in the red shirt, "
                "follow me, track the white car, count the people, what do you see, "
                "survey a 50 metre radius at 30 metres, orbit here, status, battery, yes, no, cancel.")
TARGET_PEAK = 0.7
MAX_GAIN = 30.0


def prepare(audio: np.ndarray) -> np.ndarray:
    """Quiet microphones (a laptop mic at a low input level) give Whisper a
    faint signal it fills with invented words: remove DC, bring the peak to
    a fixed level (gain capped so noise is not blown up), and pad a short
    silence at both ends so the first syllable is not clipped."""
    a = audio.astype(np.float32) - float(np.mean(audio))
    peak = float(np.max(np.abs(a))) if a.size else 0.0
    if peak > 0:
        a = a * min(MAX_GAIN, TARGET_PEAK / peak)
    pad = np.zeros(int(0.25 * SAMPLE_RATE), dtype=np.float32)
    return np.concatenate([pad, a, pad])


def has_speech(audio: np.ndarray) -> bool:
    """Speech rises and falls (syllables, pauses); fan noise, hum and an
    open line stay flat. Needs a real spread between quiet and loud 20 ms
    frames and about a quarter second of loud frames. Without this,
    Whisper turns steady noise into confident words."""
    n = int(0.02 * SAMPLE_RATE)
    frames = audio[: audio.size // n * n].reshape(-1, n)
    if frames.shape[0] < 10:
        return False
    e = np.sqrt(np.mean(np.square(frames - frames.mean(axis=1, keepdims=True)), axis=1)) + 1e-7
    lo, hi = float(np.percentile(e, 15)), float(np.percentile(e, 95))
    if hi / lo < 4.0:                             # under ~12 dB of dynamics: not speech
        return False
    loud = int(np.sum(e > lo * 4.0))
    return loud * 0.02 >= 0.25


def looks_invented(text: str) -> bool:
    """Whisper's tells when it hears no words: only punctuation, or one
    phrase repeated over and over."""
    words = re.findall(r"[a-z0-9']+", text.lower())
    if not words:
        return True
    phrases = [p.strip() for p in re.split(r"[,.;!?]+", text.lower()) if p.strip()]
    if len(phrases) >= 3 and len(set(phrases)) <= max(1, len(phrases) // 3):
        return True
    return len(words) >= 8 and len(set(words)) <= len(words) // 3


def transcribe_array(audio: np.ndarray, language: Optional[str] = None) -> str:
    """Blocking: run on slot.executor."""
    if audio.size < int(MIN_SECONDS * SAMPLE_RATE):
        logger.info(f"Copilot STT dropped a {audio.size / SAMPLE_RATE:.2f}s clip: too short")
        return ""
    # Silence (a held button, nobody speaking) makes Whisper invent words.
    rms = float(np.sqrt(np.mean(np.square(audio))))
    peak = float(np.max(np.abs(audio)))
    if rms < 0.002:
        logger.info(f"Copilot STT dropped a {audio.size / SAMPLE_RATE:.1f}s clip: silent (rms {rms:.5f})")
        return ""
    if not has_speech(audio):
        logger.info(f"Copilot STT dropped a {audio.size / SAMPLE_RATE:.1f}s clip: no speech "
                    f"(steady sound, rms {rms:.4f})")
        return ""
    import torch
    m = slot.get()
    t0 = time.perf_counter()
    feats = m["processor"](prepare(audio), sampling_rate=SAMPLE_RATE, return_tensors="pt").input_features
    feats = feats.to(m["device"], dtype=m["dtype"])
    lang = language if language is not None else LANGUAGE
    # Beam search is more careful than greedy on short commands and still
    # fast on the GPU; the prompt carries the command vocabulary.
    kwargs = {"task": "transcribe", "max_new_tokens": 48, "num_beams": 4}
    if lang and lang != "auto":
        kwargs["language"] = lang
    prompt_ids = None
    try:
        prompt_ids = m["processor"].get_prompt_ids(VOCAB_PROMPT, return_tensors="pt").to(m["device"])
        kwargs["prompt_ids"] = prompt_ids
    except Exception as e:                        # older processors: no prompt
        logger.debug(f"Copilot STT prompt unavailable: {e}")
    with torch.inference_mode():
        ids = m["model"].generate(feats, **kwargs)
    text = m["processor"].batch_decode(ids, skip_special_tokens=True)[0].strip()
    # Some versions return the prompt in front of the answer.
    if text.startswith(VOCAB_PROMPT):
        text = text[len(VOCAB_PROMPT):].strip()
    logger.info(f"Copilot STT {audio.size / SAMPLE_RATE:.1f}s audio (rms {rms:.3f}, peak {peak:.2f}) "
                f"in {time.perf_counter() - t0:.2f}s")
    if looks_invented(text):
        logger.info("Copilot STT dropped an invented transcript (repeats or no words)")
        return ""
    return text


def transcribe_bytes(data: bytes, mime: str = "") -> str:
    """Blocking: decode, then transcribe. Run on slot.executor."""
    return transcribe_array(decode_audio(data, mime=mime))
