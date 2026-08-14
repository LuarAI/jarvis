# -*- coding: utf-8 -*-
"""Multi-chat (Jarvis phase 2): parallel conversations, each with its own worker/agent
session, its own transcript widgets, and its own per-turn state — Messenger-style.

Drives the real shared Overlay from conftest (FakeWorker per chat, so every chat's
`worker.calls` is independently assertable) and pushes events through the real _poll
pump to prove the per-chat routing.
"""

import json
import time

import pytest

import config
import claude_overlay as co


def _drain(ov, ticks=3):
    """Run the event pump a few times (each _poll call drains within its budget)."""
    for _ in range(ticks):
        ov._poll()


# ---------------------------------------------------------------------------
# creating / switching / closing
# ---------------------------------------------------------------------------

class TestCreateSwitchClose:

    def test_new_chat_gets_own_worker_and_becomes_active(self, overlay):
        w1 = overlay._views[0].worker
        v2 = overlay.new_chat()
        assert v2 is overlay._active
        assert len(overlay._views) == 2
        assert v2.worker is not w1
        assert ("start", ()) in v2.worker.calls          # its agent session was launched

    def test_transcripts_are_independent(self, overlay):
        overlay.add_sys("only in chat one")
        v2 = overlay.new_chat()
        assert "only in chat one" not in v2.chat.get("1.0", "end")
        assert "only in chat one" in overlay._views[0].chat.get("1.0", "end")

    def test_entry_draft_parked_and_restored(self, overlay):
        v1 = overlay._views[0]
        overlay._ph_out()
        overlay.entry.insert("1.0", "half-typed thought")
        overlay.new_chat()
        assert v1.draft == "half-typed thought"
        assert overlay._entry_text() == ""               # fresh chat → empty (placeholder)
        overlay.switch_chat(v1)
        assert overlay._entry_text() == "half-typed thought"

    def test_close_chat_returns_to_neighbor_and_shuts_worker_down(self, overlay):
        v1 = overlay._views[0]
        v2 = overlay.new_chat()
        overlay.close_chat()
        assert overlay._active is v1
        assert v2 not in overlay._views
        names = [n for (n, a) in v2.worker.calls]
        assert "interrupt" in names and "shutdown" in names

    def test_last_chat_cannot_be_closed(self, overlay):
        overlay.close_chat()
        assert len(overlay._views) == 1
        assert "only chat" in overlay.chat.get("1.0", "end")

    def test_chat_cap(self, overlay, monkeypatch):
        monkeypatch.setattr(co, "MAX_CHATS", 2)
        assert overlay.new_chat() is not None
        assert overlay.new_chat() is None                # cap reached
        assert len(overlay._views) == 2
        assert "Chat limit" in overlay.chat.get("1.0", "end")

    def test_cycle_hotkey_wraps(self, overlay):
        v1 = overlay._views[0]
        v2 = overlay.new_chat()
        overlay._cycle_chat()
        assert overlay._active is v1
        overlay._cycle_chat()
        assert overlay._active is v2
        overlay._cycle_chat(step=-1)
        assert overlay._active is v1


# ---------------------------------------------------------------------------
# event routing: each chat's queue renders into ITS transcript
# ---------------------------------------------------------------------------

class TestEventRouting:

    def test_background_delta_lands_in_background_chat(self, overlay):
        v1 = overlay._views[0]
        overlay.new_chat()                               # v2 active, v1 in the back
        v1.ui_q.put(("delta", "background words"))
        _drain(overlay)
        assert "background words" in v1.chat.get("1.0", "end")
        assert "background words" not in overlay.chat.get("1.0", "end")

    def test_simultaneous_streams_do_not_interleave(self, overlay):
        v1 = overlay._views[0]
        v2 = overlay.new_chat()
        for i in range(5):                               # interleaved arrival order
            v1.ui_q.put(("delta", f"A{i} "))
            v2.ui_q.put(("delta", f"B{i} "))
        _drain(overlay)
        t1, t2 = v1.chat.get("1.0", "end"), v2.chat.get("1.0", "end")
        assert all(f"A{i}" in t1 for i in range(5)) and "B0" not in t1
        assert all(f"B{i}" in t2 for i in range(5)) and "A0" not in t2

    def test_per_chat_busy_and_send_isolation(self, overlay, monkeypatch):
        monkeypatch.setattr(co.authstate, "dead_reason", lambda: None)
        v1 = overlay._views[0]
        v1.busy = True                                   # v1 mid-stream
        v2 = overlay.new_chat()
        overlay.auto_shot = False
        overlay._ph_out()
        overlay.entry.insert("1.0", "hello from chat two")
        overlay._send_or_stop()
        asks_v2 = [a for (n, a) in v2.worker.calls if n == "ask"]
        asks_v1 = [a for (n, a) in v1.worker.calls if n == "ask"]
        assert len(asks_v2) == 1 and not asks_v1
        assert v2.busy is True and v1.busy is True       # both in flight, independently

    def test_background_model_event_updates_that_chat_only(self, overlay):
        v1 = overlay._views[0]
        v2 = overlay.new_chat()
        v1.ui_q.put(("model", "claude-fable-5"))
        _drain(overlay)
        assert v1._model == "claude-fable-5"
        assert v2._model is None

    def test_active_statusline_shows_active_chats_model(self, overlay):
        v1 = overlay._views[0]
        v2 = overlay.new_chat()
        v2.ui_q.put(("model", "sonnet"))
        v1.ui_q.put(("model", "opus"))
        _drain(overlay)
        assert "sonnet" in overlay.statusline.cget("text")
        assert "opus" not in overlay.statusline.cget("text")


# ---------------------------------------------------------------------------
# unread marking (💬 dot) and the chats chip
# ---------------------------------------------------------------------------

class TestUnread:

    def _finish_background_turn(self, overlay, v):
        v.ui_q.put(("delta", "done deal"))
        v.ui_q.put(("turn_done", None))
        _drain(overlay)

    def test_background_finish_marks_unread_and_switch_clears(self, overlay):
        v1 = overlay._views[0]
        overlay.new_chat()
        self._finish_background_turn(overlay, v1)
        assert v1.unread is True
        assert overlay.chats_btn.cget("fg") == co.T["accent"]
        overlay.switch_chat(v1)
        assert v1.unread is False
        assert overlay.chats_btn.cget("fg") == co.T["muted"]

    def test_active_finish_is_not_unread(self, overlay):
        v1 = overlay._views[0]
        v1.ui_q.put(("delta", "x"))
        v1.ui_q.put(("turn_done", None))
        _drain(overlay)
        assert v1.unread is False

    def test_chip_counts_chats(self, overlay):
        assert overlay.chats_btn.cget("text") == "💬"
        overlay.new_chat()
        assert overlay.chats_btn.cget("text") == "💬 2"


# ---------------------------------------------------------------------------
# the 💬 menu rows
# ---------------------------------------------------------------------------

class TestChatsMenu:

    def test_rows_mark_active_and_unread(self, overlay):
        v1 = overlay._views[0]
        v2 = overlay.new_chat()
        v1.unread = True
        labels = [lbl for lbl, _ in overlay._chats_items()]
        assert any(lbl.startswith("● ") and "Chat 1" in lbl for lbl in labels)
        assert any(lbl.startswith("✓ ") and v2.name in lbl for lbl in labels)

    def test_new_and_close_rows_wired(self, overlay):
        cmds = {lbl: cmd for lbl, cmd in overlay._chats_items()}
        assert any("New chat" in lbl for lbl in cmds)
        assert not any("Close this chat" in lbl for lbl in cmds)   # single chat → no close
        overlay.new_chat()
        cmds = {lbl: cmd for lbl, cmd in overlay._chats_items()}
        close = next(cmd for lbl, cmd in cmds.items() if "Close this chat" in lbl)
        assert close == overlay.close_chat

    def test_first_prompt_snippet_in_row(self, overlay, monkeypatch):
        monkeypatch.setattr(co.authstate, "dead_reason", lambda: None)
        overlay.auto_shot = False
        overlay._ph_out()
        overlay.entry.insert("1.0", "review my resume please")
        overlay._send_or_stop()
        labels = [lbl for lbl, _ in overlay._chats_items()]
        assert any("review my resume please" in lbl for lbl in labels)


# ---------------------------------------------------------------------------
# persistence: recent_sessions + reopen
# ---------------------------------------------------------------------------

class TestRecentSessions:

    def test_persist_upserts_recent_with_name(self, overlay):
        overlay._cur.first_prompt = "cover letter draft"
        overlay._session_id = "sess-abc"
        overlay._persist_session()
        recs = co._load_state()["recent_sessions"]
        assert recs[0]["id"] == "sess-abc"
        assert recs[0]["name"] == "cover letter draft"
        assert recs[0]["cwd"] == co.WORKING_DIR
        overlay._persist_session()                      # same id again → no duplicate
        assert len([r for r in co._load_state()["recent_sessions"]
                    if r["id"] == "sess-abc"]) == 1

    def test_clear_forgets_the_recent_record(self, overlay):
        overlay._session_id = "sess-gone"
        overlay._persist_session()
        overlay.reset()
        assert all(r["id"] != "sess-gone"
                   for r in co._load_state().get("recent_sessions", []))

    def test_recent_choices_hide_open_and_foreign_sessions(self, overlay):
        co._save_state(recent_sessions=[
            {"id": "open-here", "ts": time.time(), "cwd": co.WORKING_DIR, "name": "a"},
            {"id": "other-dir", "ts": time.time(), "cwd": r"Z:\elsewhere", "name": "b"},
            {"id": "offerable", "ts": time.time(), "cwd": co.WORKING_DIR, "name": "c"},
        ])
        overlay._session_id = "open-here"
        ids = [r["id"] for r in overlay._recent_choices()]
        assert ids == ["offerable"]

    def test_reopen_spawns_chat_and_resumes(self, overlay):
        rec = {"id": "sess-42", "ts": time.time(), "cwd": co.WORKING_DIR, "name": "old talk"}
        overlay.reopen_session(rec)
        v = overlay._active
        assert v is overlay._views[-1] and len(overlay._views) == 2
        assert ("resume", ("sess-42",)) in v.worker.calls
        assert v.first_prompt == "old talk"
        assert all(r["id"] != "sess-42" for r in overlay._recent_choices())  # now open → hidden


# ---------------------------------------------------------------------------
# shutdown
# ---------------------------------------------------------------------------

class TestShutdown:

    def test_all_workers_wound_down(self, overlay):
        overlay.new_chat()
        overlay.new_chat()
        overlay._shutdown_workers()
        for v in overlay._views:
            names = [n for (n, a) in v.worker.calls]
            assert "interrupt" in names and "shutdown" in names and "join" in names
