"""UI feature tests for session restore (Jarvis: messenger-style, replaces the seed
app's resume-offer button):
  - _maybe_restore_last gating (state present/absent, wrong cwd, too old) and that a
    passing gate actually resumes + schedules the transcript replay
  - _render_replay: bubbles/replies, attachment-preamble stripping, caps, no Copy button
  - resumed / resume_failed / resume_lost announcements (no button anymore)
  - _persist_session on turn_done, and reset() wiping the record
  - _age_str
"""
import time
import types

import pytest
from conftest import chat_text

import claude_overlay as co


def _seed_last_session(sid="sess-1", **overrides):
    """Write a resumable-looking record into the (throwaway) STATE_FILE."""
    rec = {"id": sid, "ts": time.time(), "cwd": co.WORKING_DIR}
    rec.update(overrides)
    co._save_state(last_session=rec)
    return rec


def _msg(mtype, text):
    """A stand-in for claude_agent_sdk.SessionMessage (only .type/.message are read)."""
    return types.SimpleNamespace(type=mtype,
                                 message={"role": mtype,
                                          "content": [{"type": "text", "text": text}]})


@pytest.fixture
def replay_spy(overlay, monkeypatch):
    """Capture _replay_transcript calls instead of spawning the loader thread."""
    calls = []
    monkeypatch.setattr(overlay, "_replay_transcript",
                        lambda v, sid: calls.append((v, sid)))
    return calls


# ── _age_str ─────────────────────────────────────────────────────────────────

def test_age_str_minutes():
    assert co.Overlay._age_str(0) == "1 min"          # never "0 min"
    assert co.Overlay._age_str(5 * 60) == "5 min"

def test_age_str_hours_and_days():
    assert co.Overlay._age_str(3 * 3600) == "3 h"
    assert co.Overlay._age_str(2 * 86400 + 5) == "2 d"


# ── _maybe_restore_last gating ───────────────────────────────────────────────

def test_restore_for_fresh_same_cwd_session(overlay, replay_spy):
    _seed_last_session("sess-42")
    overlay._maybe_restore_last()
    assert ("resume", ("sess-42",)) in overlay.worker.calls
    assert replay_spy == [(overlay._views[0], "sess-42")]
    assert overlay._session_id == "sess-42"           # 💬 → Reopen won't double-offer it
    assert "Restoring your conversation" in chat_text(overlay)

def test_no_restore_without_saved_session(overlay, replay_spy):
    co._save_state(last_session=None)
    overlay._maybe_restore_last()
    assert all(name != "resume" for name, _ in overlay.worker.calls)
    assert not replay_spy

def test_no_restore_for_other_working_dir(overlay, replay_spy):
    # CLI sessions are stored per directory — a record from elsewhere can't resume here.
    _seed_last_session(cwd=r"C:\somewhere\else")
    overlay._maybe_restore_last()
    assert all(name != "resume" for name, _ in overlay.worker.calls)

def test_no_restore_for_too_old_session(overlay, replay_spy):
    _seed_last_session(ts=time.time() - co.RESUME_OFFER_MAX_AGE - 60)
    overlay._maybe_restore_last()
    assert all(name != "resume" for name, _ in overlay.worker.calls)

def test_no_restore_for_malformed_record(overlay, replay_spy):
    co._save_state(last_session={"ts": time.time(), "cwd": co.WORKING_DIR})  # no id
    overlay._maybe_restore_last()
    co._save_state(last_session="sess-1")                                    # not a dict
    overlay._maybe_restore_last()
    assert all(name != "resume" for name, _ in overlay.worker.calls)


# ── transcript replay rendering ──────────────────────────────────────────────

class TestRenderReplay:

    def test_renders_user_and_assistant_messages(self, overlay):
        overlay._render_replay([_msg("user", "what does this error mean?"),
                                _msg("assistant", "It means the file is **missing**.")])
        t = chat_text(overlay)
        assert "missing" in t                       # assistant text rendered
        assert "restored · keep going" in t
        # user messages are real text now (selectable), not embedded widgets
        assert "what does this error mean?" in t

    def test_strips_attachment_preambles(self, overlay):
        overlay._render_replay([
            _msg("user", "[Attached: a live screenshot of my screen — monitor 1.]\n\n"
                         "review this page"),
            _msg("assistant", "Looks fine.")])
        # the preamble text must not appear anywhere in the restored transcript
        assert "[Attached:" not in chat_text(overlay)

    def test_empty_transcript_says_so(self, overlay):
        overlay._render_replay([])
        assert "empty" in chat_text(overlay)

    def test_skips_cli_internal_command_records(self, overlay):
        # /model etc. are stored as user messages wrapped in <command-name> tags —
        # process noise that must not render as user bubbles.
        overlay._render_replay([
            _msg("user", "<command-name>/model</command-name>"),
            _msg("user", "<local-command-stdout>Set model to opus</local-command-stdout>"),
            _msg("user", "a real question"),
            _msg("assistant", "a real answer")])
        t = chat_text(overlay)
        assert "command-name" not in t and "Set model to opus" not in t
        assert "a real answer" in t

    def test_caps_marathon_transcripts(self, overlay):
        msgs = [_msg("user" if i % 2 == 0 else "assistant", f"message number {i}")
                for i in range(120)]
        overlay._render_replay(msgs)
        t = chat_text(overlay)
        assert "earlier messages omitted" in t
        assert "message number 119" in t            # the tail is what's shown
        assert "message number 3" not in t

    def test_replay_grows_no_copy_button(self, overlay):
        overlay._render_replay([_msg("assistant", "an old reply")])
        assert overlay._turn_raw == ""
        assert overlay._turn_copy_added is False

    def test_replay_names_the_chat_from_first_user_message(self, overlay):
        overlay._render_replay([_msg("user", "help with my cover letter"),
                                _msg("assistant", "sure")])
        assert overlay._cur.first_prompt.startswith("help with my cover letter")

    def test_replay_event_routes_to_owning_chat(self, overlay):
        v1 = overlay._views[0]
        overlay.new_chat()                          # active is now chat 2
        v1.ui_q.put(("replay", [_msg("assistant", "old words for chat one")]))
        for _ in range(3):
            overlay._poll()
        assert "old words for chat one" in v1.chat.get("1.0", "end")
        assert "old words for chat one" not in overlay.chat.get("1.0", "end")


# ── outcome announcements (no button anymore) ────────────────────────────────

def test_resumed_event_announces_and_persists(overlay):
    overlay._session_id = "sess-42"
    overlay._handle("resumed", None)
    assert "Resumed" in chat_text(overlay)
    assert co._load_state()["last_session"]["id"] == "sess-42"

def test_resume_failed_announces_fresh_session(overlay):
    overlay._handle("resume_failed", None)
    assert "fresh" in chat_text(overlay)

def test_resume_lost_event_corrects_the_claim(overlay):
    overlay._handle("resume_lost", None)
    assert "couldn't be restored" in chat_text(overlay)


# ── reopen (💬 menu) also replays ────────────────────────────────────────────

def test_reopen_session_replays_transcript(overlay, replay_spy):
    rec = {"id": "sess-77", "ts": time.time(), "cwd": co.WORKING_DIR, "name": "old"}
    overlay.reopen_session(rec)
    assert replay_spy and replay_spy[0][1] == "sess-77"


# ── persistence ──────────────────────────────────────────────────────────────

def test_turn_done_persists_current_session(overlay):
    overlay._handle("session", "sess-9")
    overlay._handle("turn_done", None)
    saved = co._load_state().get("last_session")
    assert isinstance(saved, dict)
    assert saved["id"] == "sess-9"
    assert saved["cwd"] == co.WORKING_DIR
    assert abs(time.time() - saved["ts"]) < 5

def test_turn_done_without_session_keeps_existing_record(overlay):
    rec = _seed_last_session("sess-old")
    overlay._session_id = None
    overlay._handle("turn_done", None)            # e.g. an errored turn before init
    assert co._load_state().get("last_session")["id"] == rec["id"]

def test_reset_wipes_the_record(overlay):
    _seed_last_session("sess-9")
    overlay._session_id = "sess-9"
    overlay.reset()
    assert co._load_state().get("last_session") is None
    assert overlay._session_id is None

def test_clear_race_stale_events_dont_resurrect(overlay):
    # A turn's (session / turn_done) batch enqueued just before Clear must not re-set the
    # id or re-persist the record while the discard is pending — the worker's reset_done
    # hasn't drained yet. (#5 review, finding 2.)
    overlay._handle("session", "sess-live")
    overlay._handle("turn_done", None)
    assert co._load_state()["last_session"]["id"] == "sess-live"

    overlay.reset()                               # user clicks Clear
    assert overlay._discard_pending is True
    assert co._load_state().get("last_session") is None

    overlay._handle("session", "sess-live")       # stale batch drains AFTER the click
    overlay._handle("turn_done", None)
    assert overlay._session_id is None            # not resurrected
    assert co._load_state().get("last_session") is None

    overlay._handle("reset_done", None)           # worker confirms the wipe
    assert overlay._discard_pending is False
    overlay._handle("session", "sess-new")        # a genuine new turn persists again
    overlay._handle("turn_done", None)
    assert co._load_state()["last_session"]["id"] == "sess-new"
