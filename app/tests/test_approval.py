# -*- coding: utf-8 -*-
"""Action approval (Claude Code-style) + selectable user messages.

The contract these lock down:
  * READS never interrupt; ACTIONS pause for Approve / Reject;
  * a rejection is reported back to the model as a denial, not an error;
  * "Always allow" is session-scoped and can only be set by a click;
  * a turn that ends (Stop / Clear) never leaves a card waiting forever;
  * your own messages are real text, so the transcript can be selected and copied.
"""

import asyncio
import queue
import types

import pytest
from conftest import chat_text

import claude_overlay as co
from worker import ClaudeWorker


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _worker(mode="bypassPermissions"):
    return ClaudeWorker(queue.Queue(), permission_mode=mode)


# ── which tools ask ──────────────────────────────────────────────────────────

class TestNeedsApproval:

    @pytest.mark.parametrize("tool", ["Read", "Grep", "Glob", "WebFetch", "WebSearch",
                                      "mcp__jarvis_browser__browser_read_page",
                                      "mcp__jarvis_browser__browser_list_fields"])
    def test_reads_never_ask(self, tool):
        assert _worker()._needs_approval(tool) is False

    @pytest.mark.parametrize("tool", ["Bash", "Write", "Edit", "PowerShell",
                                      "mcp__jarvis_browser__browser_fill_form"])
    def test_actions_ask(self, tool):
        assert _worker()._needs_approval(tool) is True


# ── the permission callback ──────────────────────────────────────────────────

class TestAllowToolFlow:

    def _answer(self, w, ok, always=False):
        """Drain the approval request the callback queued and answer it."""
        kind, payload = w.ui.get(timeout=2)
        assert kind == "approval"
        payload["answer"](ok, always)
        return payload

    def test_approve_lets_the_tool_run(self, monkeypatch):
        monkeypatch.setattr(co, "APPROVE_ACTIONS", True, raising=False)
        w = _worker()
        loop = asyncio.new_event_loop()

        async def drive():
            task = loop.create_task(w._allow_tool("Bash", {"command": "echo hi"}, None))
            await asyncio.sleep(0.05)
            self._answer(w, True)
            return await task
        res = loop.run_until_complete(drive())
        assert type(res).__name__ == "PermissionResultAllow"

    def test_reject_denies_with_guidance(self):
        w = _worker()
        loop = asyncio.new_event_loop()

        async def drive():
            task = loop.create_task(w._allow_tool("Write", {"file_path": "x"}, None))
            await asyncio.sleep(0.05)
            self._answer(w, False)
            return await task
        res = loop.run_until_complete(drive())
        assert type(res).__name__ == "PermissionResultDeny"
        assert "declined" in res.message and "Don't retry" in res.message

    def test_always_allow_stops_asking(self):
        w = _worker()
        loop = asyncio.new_event_loop()

        async def drive():
            task = loop.create_task(w._allow_tool("Bash", {"command": "a"}, None))
            await asyncio.sleep(0.05)
            self._answer(w, True, always=True)
            first = await task
            # the next action must NOT queue a card
            second = await w._allow_tool("Bash", {"command": "b"}, None)
            return first, second
        first, second = loop.run_until_complete(drive())
        assert type(first).__name__ == "PermissionResultAllow"
        assert type(second).__name__ == "PermissionResultAllow"
        assert w.ui.empty(), "second action should not have asked"

    def test_reads_do_not_queue_a_card(self):
        w = _worker()
        res = _run(w._allow_tool("Read", {"file_path": "x"}, None))
        assert type(res).__name__ == "PermissionResultAllow"
        assert w.ui.empty()

    def test_disabled_by_config(self, monkeypatch):
        import worker as worker_module
        monkeypatch.setattr(worker_module, "APPROVE_ACTIONS", False)
        w = _worker()
        res = _run(w._allow_tool("Bash", {"command": "rm -rf /"}, None))
        assert type(res).__name__ == "PermissionResultAllow"
        assert w.ui.empty()

    def test_unanswered_card_denies_instead_of_hanging(self, monkeypatch):
        """A card nobody clicks must not wedge the turn forever."""
        import worker as worker_module
        monkeypatch.setattr(worker_module, "APPROVAL_TIMEOUT", 0.2)
        w = _worker()
        res = _run(w._allow_tool("Bash", {"command": "x"}, None))
        assert type(res).__name__ == "PermissionResultDeny"

    def test_read_only_still_wins_over_approval(self):
        # plan mode denies actions outright — the card must not offer to approve them
        w = _worker("plan")
        res = _run(w._allow_tool("Bash", {"command": "x"}, None))
        assert type(res).__name__ == "PermissionResultDeny"
        assert w.ui.empty()



class TestUnlockedModePairsWithCards:
    """Turning Read-only OFF must land in a mode where our card is authoritative.
    acceptEdits/bypassPermissions let the CLI approve file edits ITSELF, so the card
    would never appear for exactly the action it exists to gate."""

    def test_full_mode_is_default_when_approvals_are_on(self, overlay):
        if co.APPROVE_ACTIONS:
            assert overlay._full_mode == "default"

    def test_toggle_targets_that_mode(self, overlay, monkeypatch):
        sent = []
        monkeypatch.setattr(overlay.worker, "set_permission_mode", lambda m: sent.append(m))
        overlay.read_only = True
        overlay.toggle_read_only()
        assert sent == [overlay._full_mode]
        if co.APPROVE_ACTIONS:
            assert sent == ["default"]


# ── the card in the UI ───────────────────────────────────────────────────────

def _card(overlay, tool="Bash", inp=None, answers=None):
    answers = answers if answers is not None else []
    overlay._render_approval({"id": 1, "tool": tool, "input": inp or {"command": "echo hi"},
                              "answer": lambda ok, always=False: answers.append((ok, always))})
    widgets = [overlay.chat.nametowidget(n) for n in overlay.chat.window_names()]
    return widgets[-1], answers


class TestApprovalCard:

    def test_card_shows_what_it_would_do(self, overlay):
        _card(overlay, "Bash", {"command": "git push --force"})
        t = chat_text(overlay)
        assert "Needs your approval" in t and "Run a command" in t
        assert "git push --force" in t          # the actual command is visible

    def test_edit_shows_the_change(self, overlay):
        _card(overlay, "Edit", {"file_path": "notes.md", "old_string": "aaa",
                                "new_string": "bbb"})
        t = chat_text(overlay)
        assert "notes.md" in t and "− aaa" in t and "+ bbb" in t

    def test_approve_answers_true(self, overlay):
        btn, answers = _card(overlay)
        btn._click(types.SimpleNamespace(x=1, y=5))
        assert answers == [(True, False)]
        assert btn._ustate == "approved"

    def test_reject_answers_false(self, overlay):
        btn, answers = _card(overlay)
        btn._click(types.SimpleNamespace(x=10_000, y=5))    # far right → "Always"
        assert answers and answers[0][0] is True            # sanity: right zone is Always
        btn2, answers2 = _card(overlay)
        # middle zone = Reject
        mid = (btn2._overlay_fonts and 0) or 0
        btn2._decide("rejected", False)
        assert answers2 == [(False, False)]

    def test_second_click_is_inert(self, overlay):
        btn, answers = _card(overlay)
        btn._click(types.SimpleNamespace(x=1, y=5))
        btn._click(types.SimpleNamespace(x=1, y=5))
        assert len(answers) == 1                            # one decision only

    def test_stop_retires_open_cards(self, overlay, monkeypatch):
        btn, answers = _card(overlay)
        overlay.busy = True
        monkeypatch.setattr(overlay.worker, "interrupt", lambda: None)
        overlay._send_or_stop()                             # Stop
        assert answers == [(False, False)]                  # released, as a rejection
        assert btn._ustate == "rejected"

    def test_clear_retires_open_cards(self, overlay):
        btn, answers = _card(overlay)
        overlay.reset()
        assert answers == [(False, False)]

    def test_answered_card_is_not_retired_twice(self, overlay):
        btn, answers = _card(overlay)
        btn._click(types.SimpleNamespace(x=1, y=5))
        overlay.reset()
        assert answers == [(True, False)]                   # still just the one answer


# ── selectable user messages ─────────────────────────────────────────────────

class TestSelectableTranscript:

    def test_user_message_is_real_text(self, overlay):
        overlay.add_user("please review my cover letter")
        # it must appear in the Text content — an embedded widget would not
        assert "please review my cover letter" in chat_text(overlay)

    def test_whole_conversation_selects(self, overlay):
        overlay.add_user("my question")
        overlay.add_delta("Claude's answer\n")
        overlay._md_finalize()
        overlay.chat.tag_add("sel", "1.0", "end-1c")
        sel = overlay.chat.get("sel.first", "sel.last")
        assert "my question" in sel and "Claude's answer" in sel

    def test_ctrl_a_selects_everything(self, overlay):
        overlay.add_user("hello there")
        overlay._readonly_keys(types.SimpleNamespace(state=0x4, keysym="a"))
        sel = overlay.chat.get("sel.first", "sel.last")
        assert "hello there" in sel

    def test_user_text_keeps_its_card_styling(self, overlay):
        overlay.add_user("styled?")
        # the "user" tag must cover the message, or it won't look like a card
        idx = overlay.chat.search("styled?", "1.0", "end")
        assert idx, "message not found in the transcript"
        assert "user" in overlay.chat.tag_names(idx)
