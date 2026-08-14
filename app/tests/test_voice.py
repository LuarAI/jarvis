# -*- coding: utf-8 -*-
"""Voice input (🎤 dictation): the Overlay state machine and event plumbing, with the
audio/STT layer mocked — no microphone, no model download in tests. voice.py's own
Recorder/transcribe are exercised only for their dependency-gating logic."""

import types

import pytest

import claude_overlay as co
import voice


class FakeRecorder:
    """Stands in for voice.Recorder: records nothing, returns what the test plants."""
    audio = "fake-audio"          # any non-None sentinel

    def __init__(self):
        self.started = False
        self.stopped = False

    def start(self):
        self.started = True

    def elapsed(self):
        return 3.0

    def stop(self):
        self.stopped = True
        return self.audio


@pytest.fixture
def voiced(overlay, monkeypatch):
    """Voice deps 'installed' + fake recorder; transcription captured, not run."""
    monkeypatch.setattr(co.voice, "missing_deps", lambda: [])
    monkeypatch.setattr(co.voice, "Recorder", FakeRecorder)
    FakeRecorder.audio = "fake-audio"
    return overlay


def _pump(ov, n=3):
    for _ in range(n):
        ov._poll()


# ── dependency gating ────────────────────────────────────────────────────────

def test_missing_deps_shows_install_hint_and_does_not_record(overlay, monkeypatch):
    monkeypatch.setattr(co.voice, "missing_deps", lambda: ["sounddevice", "faster-whisper"])
    overlay.toggle_voice()
    assert overlay._voice_rec is None
    t = overlay.chat.get("1.0", "end")
    assert "requirements-voice.txt" in t and "sounddevice" in t

def test_voice_module_reports_missing_deps_as_pip_names():
    # In the dev environment the deps may or may not be installed; the contract is the
    # return TYPE and values being pip-installable names.
    missing = voice.missing_deps()
    assert isinstance(missing, list)
    assert all(m in ("sounddevice", "faster-whisper") for m in missing)


# ── record → stop → transcribe → entry ───────────────────────────────────────

class TestVoiceFlow:

    def test_click_starts_recording_and_paints_red(self, voiced):
        voiced.toggle_voice()
        assert isinstance(voiced._voice_rec, FakeRecorder)
        assert voiced._voice_rec.started
        assert voiced.mic_btn.cget("fg") == co.T["err"]
        assert "recording" in voiced.busy_lbl.cget("text")

    def test_second_click_stops_and_transcribes_into_entry(self, voiced, monkeypatch):
        seen = {}
        def fake_transcribe(audio, model_size):
            seen["audio"], seen["model"] = audio, model_size
            return "  hola, revisa este formulario  "
        monkeypatch.setattr(co.voice, "transcribe", fake_transcribe)
        voiced.toggle_voice()
        rec = voiced._voice_rec
        voiced.toggle_voice()                       # stop
        assert rec.stopped and voiced._voice_rec is None
        for _ in range(200):                        # transcription thread → app queue
            if not voiced._app_q.empty():
                break
            import time as _t; _t.sleep(0.01)
        _pump(voiced)
        assert seen["audio"] == "fake-audio" and seen["model"] == co.VOICE_MODEL
        assert voiced._entry_text() == "hola, revisa este formulario"
        assert voiced._voice_busy is False

    def test_transcript_is_reviewed_not_sent(self, voiced, monkeypatch):
        monkeypatch.setattr(co.voice, "transcribe", lambda a, m: "dictated words")
        voiced.toggle_voice(); voiced.toggle_voice()
        for _ in range(200):
            if not voiced._app_q.empty():
                break
            import time as _t; _t.sleep(0.01)
        _pump(voiced)
        assert all(name != "ask" for name, _ in voiced.worker.calls)   # nothing auto-sent

    def test_escape_cancels_without_transcribing(self, voiced, monkeypatch):
        called = []
        monkeypatch.setattr(co.voice, "transcribe",
                            lambda a, m: called.append(True) or "")
        voiced.toggle_voice()
        voiced._cancel_voice()
        assert voiced._voice_rec is None
        assert not called
        assert voiced._voice_busy is False

    def test_empty_capture_reports_mic_hint(self, voiced):
        FakeRecorder.audio = None                   # dead/muted mic
        voiced.toggle_voice()
        voiced.toggle_voice()
        assert voiced._voice_busy is False
        assert "microphone" in voiced.chat.get("1.0", "end")

    def test_empty_transcription_reports_no_words(self, voiced):
        voiced._app_q.put(("voice_text", "   "))
        _pump(voiced)
        assert "Didn't catch" in voiced.chat.get("1.0", "end")

    def test_transcription_error_lands_in_chat(self, voiced):
        voiced._voice_busy = True
        voiced._app_q.put(("voice_err", "RuntimeError: boom"))
        _pump(voiced)
        assert voiced._voice_busy is False
        assert "Transcription failed" in voiced.chat.get("1.0", "end")

    def test_voice_text_goes_to_active_chats_entry_only(self, voiced, monkeypatch):
        # Voice events ride the APP queue: they always serve the chat on screen.
        monkeypatch.setattr(co.voice, "transcribe", lambda a, m: "for chat two")
        voiced.new_chat()
        voiced.toggle_voice(); voiced.toggle_voice()
        for _ in range(200):
            if not voiced._app_q.empty():
                break
            import time as _t; _t.sleep(0.01)
        _pump(voiced)
        assert voiced._entry_text() == "for chat two"
