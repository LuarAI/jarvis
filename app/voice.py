# -*- coding: utf-8 -*-
"""Jarvis voice input: push-to-talk dictation → text into the message box.

Local-first STT: sounddevice (PortAudio) records the default mic at 16 kHz mono and
faster-whisper (CTranslate2, int8 on CPU) transcribes — nothing leaves the machine,
which is the whole point of an open-source overlay (the Windows cloud dictation APIs
would silently ship audio to Microsoft). Both are OPTIONAL dependencies so the core
app stays slim: everything here degrades to a clear "how to enable" message when
they're missing (see requirements-voice.txt).

Language is auto-detected per utterance (the user dictates in Spanish, English, or a
mix — never hardcode one), and the transcript is inserted into the entry for REVIEW,
never auto-sent: dictation that fires messages on its own is the classic regression.

Threading contract: everything slow (device open, recording, model load, transcribe)
runs on daemon threads; results are posted to the queue the caller provides as
(kind, payload) tuples — ("voice_text", str), ("voice_err", str), ("status", str) —
which the overlay drains on the Tk thread like any other app event.
"""

import threading
import time

# module-level so the ~0.5 GB model loads once per process, not once per utterance
_model = None
_model_size = None
_model_lock = threading.Lock()

SAMPLE_RATE = 16_000          # what Whisper expects; PortAudio resamples if the mic differs
MAX_SECONDS = 120             # hard stop: a forgotten-open mic must not record forever


def missing_deps():
    """The pip names of the optional voice dependencies that aren't installed
    (empty list → voice input is ready to use)."""
    out = []
    try:
        import sounddevice  # noqa: F401
    except Exception:
        out.append("sounddevice")
    try:
        import faster_whisper  # noqa: F401
    except Exception:
        out.append("faster-whisper")
    return out


def available():
    return not missing_deps()


def list_input_devices():
    """[(label, value)] rows for a mic picker. First row is always
    ("System default (…)", None) — value None means "follow Windows". The rest are
    real input devices filtered to the WASAPI host API (one entry per physical device;
    PortAudio otherwise lists every device 3-4x across MME/DirectSound/WASAPI/WDM-KS,
    and MME truncates names to 31 chars). Values are device NAMES — stable across
    restarts, unlike indices."""
    default_name = None
    rows = []
    try:
        import sounddevice as sd
        try:
            default_name = sd.query_devices(kind="input")["name"]
        except Exception:
            pass
        for api in sd.query_hostapis():
            if "WASAPI" not in api["name"]:
                continue
            for idx in api["devices"]:
                dev = sd.query_devices(idx)
                if dev["max_input_channels"] > 0:
                    rows.append((dev["name"], dev["name"]))
    except Exception:
        pass
    label = f"System default ({default_name})" if default_name else "System default"
    return [(label, None)] + rows


def _resolve_device(name):
    """(device_index_or_None, extra_settings) for InputStream. A picked name resolves
    to its WASAPI endpoint with AUTOCONVERTPCM (so 16 kHz works whatever the device's
    shared-mode format); None/unresolvable → PortAudio default (MME, which resamples)."""
    if not name:
        return None, None
    try:
        import sounddevice as sd
        for api in sd.query_hostapis():
            if "WASAPI" not in api["name"]:
                continue
            for idx in api["devices"]:
                dev = sd.query_devices(idx)
                if dev["name"] == name and dev["max_input_channels"] > 0:
                    return idx, sd.WasapiSettings(auto_convert=True)
    except Exception:
        pass
    return None, None


class Recorder:
    """One utterance: start() opens the mic and buffers audio on PortAudio's callback
    thread; stop() closes the stream and returns the captured mono float32 array (or
    None if nothing usable was captured). A fresh Recorder per utterance — reopening
    each time also picks up a changed default-mic setting. `peak` holds the highest
    |sample| since the UI last zeroed it — the live level-meter feed."""

    def __init__(self):
        self._chunks = []
        self._stream = None
        self._t0 = None
        self.peak = 0.0

    def start(self, device_name=None):
        import sounddevice as sd

        def cb(indata, frames, t, status):   # PortAudio thread — no Tk here
            self._chunks.append(indata.copy())
            p = float(abs(indata).max())
            if p > self.peak:
                self.peak = p

        device, extra = _resolve_device(device_name)
        self._stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1,
                                      dtype="float32", callback=cb,
                                      device=device, extra_settings=extra)
        self._stream.start()
        self._t0 = time.monotonic()

    def elapsed(self):
        return 0.0 if self._t0 is None else (time.monotonic() - self._t0)

    def stop(self):
        try:
            if self._stream is not None:
                self._stream.stop()
                self._stream.close()
        except Exception:
            pass
        self._stream = None
        if not self._chunks:
            return None
        import numpy as np
        audio = np.concatenate(self._chunks)[:, 0]
        self._chunks = []
        # guard against a dead/muted mic: near-silence in, garbage hallucinations out
        if len(audio) < SAMPLE_RATE // 4 or float(abs(audio).max() or 0) < 1e-4:
            return None
        return audio


def _get_model(size):
    """The shared WhisperModel, (re)loaded only when the configured size changes.
    First call downloads the model from Hugging Face (~145 MB base / ~480 MB small)."""
    global _model, _model_size
    with _model_lock:
        if _model is None or _model_size != size:
            from faster_whisper import WhisperModel
            _model = WhisperModel(size, device="cpu", compute_type="int8")
            _model_size = size
        return _model


def transcribe(audio, model_size="small"):
    """Blocking transcription (call on a worker thread). Returns the utterance text,
    "" when nothing was recognized. language=None → per-utterance auto-detect."""
    model = _get_model(model_size)
    segments, _info = model.transcribe(audio, language=None, vad_filter=True)
    return " ".join(s.text.strip() for s in segments).strip()
