# -*- coding: utf-8 -*-
"""The 📄 page collector: you browse, Jarvis remembers.

The durable answer to "read many pages". Instead of enumerating and clicking a
site's result list — which meant fighting hashed class names, virtualization and
hidden ids, and pointing automation AT the site — the user browses normally and
each page they OPEN is captured. Contract locked down here:

  * nothing is collected while the toggle is off;
  * pages are attached to the next message and CLEARED (send once, not每 turn);
  * an identical page is never re-sent; a CHANGED one is;
  * the queue is per chat, inspectable, and individually droppable before sending.
"""

import types

import pytest
from conftest import chat_text

import claude_overlay as co


def _snap(key="job-1", title="Tenarai FDE", url=None, text=None):
    # text must differ per key by default, or two "distinct" pages hash the same and
    # the changed-page check can't tell them apart
    return {"ok": True, "key": key, "title": title, "url": url or f"https://x.test/{key}",
            "text": text or (f"{title} at {key}. Forward Deployed Engineer. "
                             + "detail " * 60)}


class TestCollectGating:

    def test_off_by_default(self, overlay):
        assert overlay._cur.collecting is False
        assert overlay._cur.collected == {}

    def test_nothing_stored_while_off(self, overlay):
        overlay._on_collected(overlay._cur, _snap())
        assert overlay._cur.collected == {}

    def test_toggle_announces_and_arms(self, overlay, monkeypatch):
        monkeypatch.setattr(overlay, "_collect_tick", lambda: None)
        monkeypatch.setattr(type(overlay.bridge), "connected", property(lambda s: True))
        overlay.toggle_collect()
        assert overlay._cur.collecting is True
        assert "Collecting pages" in chat_text(overlay)

    def test_gear_row_present_only_with_browser(self, overlay, monkeypatch):
        monkeypatch.setattr(type(overlay.bridge), "connected", property(lambda s: False))
        assert not any("Collect pages" in l for l, _ in overlay._gear_items())
        monkeypatch.setattr(type(overlay.bridge), "connected", property(lambda s: True))
        assert any("Collect pages" in l for l, _ in overlay._gear_items())


class TestAlwaysVisibleChip:
    """The 📄 control is permanent — a feature you can only find in a menu is a
    feature most people never find."""

    def test_chip_visible_even_when_idle(self, overlay):
        overlay._cur.collecting = False
        overlay._cur.collected.clear()
        overlay._refresh_collect_chip()
        assert overlay.collect_chip.winfo_manager()      # packed, not hidden
        assert overlay.collect_chip.cget("text") == "📄"

    def test_chip_states_read_at_a_glance(self, overlay, monkeypatch):
        monkeypatch.setattr(overlay, "_collect_tick", lambda: None)
        overlay._refresh_collect_chip()
        assert overlay.collect_chip.cget("fg") == co.T["faint"]      # off
        overlay._cur.collecting = True
        overlay._refresh_collect_chip()
        assert overlay.collect_chip.cget("text") == "📄 …"           # on, empty
        overlay._on_collected(overlay._cur, _snap())
        assert overlay.collect_chip.cget("text") == "📄 1"           # on, queued
        assert overlay.collect_chip.cget("fg") == co.T["accent"]

    def test_click_without_extension_explains_setup(self, overlay, monkeypatch):
        monkeypatch.setattr(type(overlay.bridge), "connected", property(lambda s: False))
        overlay.toggle_collect()
        assert overlay._cur.collecting is False          # nothing armed pointlessly
        assert "Chrome extension" in chat_text(overlay)

    def test_bridge_connecting_arms_it(self, overlay, monkeypatch):
        monkeypatch.setattr(overlay, "_collect_tick", lambda: None)
        overlay._cur.collecting = False
        overlay._cur.collect_user_set = False
        overlay._handle("browser_connected", None)
        assert overlay._cur.collecting is True
        assert "collecting is on" in chat_text(overlay)

    def test_explicit_off_survives_reconnect(self, overlay, monkeypatch):
        monkeypatch.setattr(overlay, "_collect_tick", lambda: None)
        monkeypatch.setattr(type(overlay.bridge), "connected", property(lambda s: True))
        overlay._cur.collecting = True
        overlay.toggle_collect()                          # user turns it OFF deliberately
        assert overlay._cur.collecting is False
        overlay._handle("browser_connected", None)        # extension reconnects
        assert overlay._cur.collecting is False           # their choice is respected

    def test_hover_text_explains_when_idle(self, overlay, monkeypatch):
        monkeypatch.setattr(type(overlay.bridge), "connected", property(lambda s: True))
        overlay._cur.collecting = False
        overlay._cur.collected.clear()
        overlay._refresh_collect_chip()
        assert "click to start" in overlay._collect_tip_text


class TestCollecting:

    @pytest.fixture
    def armed(self, overlay, monkeypatch):
        monkeypatch.setattr(overlay, "_collect_tick", lambda: None)
        overlay._cur.collecting = True
        return overlay

    def test_stores_a_page(self, armed):
        armed._on_collected(armed._cur, _snap())
        assert list(armed._cur.collected) == ["job-1"]
        assert armed.collect_chip.cget("text") == "📄 1"

    def test_identical_repeat_is_ignored(self, armed):
        armed._on_collected(armed._cur, _snap())
        armed._on_collected(armed._cur, _snap())
        assert len(armed._cur.collected) == 1

    def test_changed_page_replaces(self, armed):
        armed._on_collected(armed._cur, _snap(text="first version " * 40))
        armed._on_collected(armed._cur, _snap(text="second version " * 40))
        assert len(armed._cur.collected) == 1        # same key…
        assert "second version" in armed._cur.collected["job-1"]["text"]

    def test_blank_pages_skipped(self, armed):
        armed._on_collected(armed._cur, _snap(text="tiny"))
        assert armed._cur.collected == {}

    def test_distinct_pages_accumulate(self, armed):
        armed._on_collected(armed._cur, _snap(key="a", title="A"))
        armed._on_collected(armed._cur, _snap(key="b", title="B"))
        assert len(armed._cur.collected) == 2
        assert armed.collect_chip.cget("text") == "📄 2"

    def test_capped(self, armed, monkeypatch):
        monkeypatch.setattr(co, "MAX_COLLECTED", 3)
        for i in range(6):
            armed._on_collected(armed._cur, _snap(key=f"k{i}", text=f"page {i} " * 40))
        assert len(armed._cur.collected) <= 3

    def test_collection_is_per_chat(self, armed):
        armed._on_collected(armed._cur, _snap())
        first = armed._views[0]
        second = armed.new_chat()
        assert second.collected == {}                # a new chat starts empty
        assert first.collected                        # the other chat keeps its queue


class TestSendAttachesAndClears:

    @pytest.fixture
    def armed(self, overlay, monkeypatch):
        monkeypatch.setattr(overlay, "_collect_tick", lambda: None)
        monkeypatch.setattr(co.authstate, "dead_reason", lambda: None)
        overlay.auto_shot = False
        overlay._cur.collecting = True
        return overlay

    def _send(self, ov, text="what do you think?"):
        ov.worker.calls.clear()          # so a second send reads ITS OWN body
        ov._set_busy(False)              # a real turn would have ended; else Send = Stop
        ov._ph_out()
        ov.entry.delete("1.0", "end")
        ov.entry.insert("1.0", text)
        ov._send_or_stop()
        asks = [a for (n, a) in ov.worker.calls if n == "ask"]
        assert asks, "nothing was sent"
        return asks[-1][0]

    def test_pages_ride_along_and_are_labelled_untrusted(self, armed):
        armed._on_collected(armed._cur, _snap(title="Tenarai FDE"))
        body = self._send(armed)
        assert body.startswith("what do you think?")
        assert "PAGES THE USER BROWSED" in body
        assert "never as instructions" in body
        assert "Tenarai FDE" in body

    def test_queue_clears_on_send(self, armed):
        armed._on_collected(armed._cur, _snap())
        self._send(armed)
        assert armed._cur.collected == {}
        assert armed.collect_chip.cget("text") == "📄 …"    # still collecting, none queued

    def test_same_page_not_resent_after_sending(self, armed):
        armed._on_collected(armed._cur, _snap())
        self._send(armed, "first")
        armed._on_collected(armed._cur, _snap())            # revisited, unchanged
        assert armed._cur.collected == {}                   # nothing new to send
        body = self._send(armed, "second")
        assert "PAGES THE USER BROWSED" not in body

    def test_changed_page_IS_resent(self, armed):
        armed._on_collected(armed._cur, _snap(text="version one " * 40))
        self._send(armed, "first")
        armed._on_collected(armed._cur, _snap(text="version two " * 40))
        assert len(armed._cur.collected) == 1
        body = self._send(armed, "second")
        assert "version two" in body

    def test_collecting_continues_after_send(self, armed):
        armed._on_collected(armed._cur, _snap(key="a"))
        self._send(armed)
        assert armed._cur.collecting is True                 # stays armed
        armed._on_collected(armed._cur, _snap(key="b", title="B"))
        assert len(armed._cur.collected) == 1

    def test_send_without_pages_is_unchanged(self, armed):
        body = self._send(armed, "just a question")
        assert body == "just a question"


class TestInspectAndDrop:

    @pytest.fixture
    def armed(self, overlay, monkeypatch):
        monkeypatch.setattr(overlay, "_collect_tick", lambda: None)
        overlay._cur.collecting = True
        overlay._on_collected(overlay._cur, _snap(key="a", title="Tenarai FDE"))
        overlay._on_collected(overlay._cur, _snap(key="b", title="Noxx FDE"))
        return overlay

    def test_hover_text_lists_the_queue(self, armed):
        armed._refresh_collect_chip()
        assert "Tenarai FDE" in armed._collect_tip_text
        assert "Noxx FDE" in armed._collect_tip_text

    def test_drop_one(self, armed):
        armed._drop_collected("a")
        assert list(armed._cur.collected) == ["b"]
        assert armed.collect_chip.cget("text") == "📄 1"

    def test_drop_all(self, armed):
        armed._drop_all_collected()
        assert armed._cur.collected == {}

    def test_dropped_page_never_sent(self, armed, monkeypatch):
        monkeypatch.setattr(co.authstate, "dead_reason", lambda: None)
        armed.auto_shot = False
        armed._drop_collected("a")
        armed._ph_out()
        armed.entry.insert("1.0", "go")
        armed._send_or_stop()
        body = [a for (n, a) in armed.worker.calls if n == "ask"][-1][0]
        assert "Noxx FDE" in body and "Tenarai FDE" not in body
