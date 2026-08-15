# -*- coding: utf-8 -*-
"""UI polish round (phase 2.2): scroll physics (pixel wheel + follow flag), the ☰
top-left conversation list panel, screenshot thumbnails + lightbox viewer, and the
⚙ microphone picker."""

import types

import pytest
from conftest import chat_text

import claude_overlay as co
import voice


def _wheel(delta):
    return types.SimpleNamespace(delta=delta)


# ── scroll: wheel scrolls by pixels (Tk's own Text formula) ──────────────────

class TestWheelPixels:

    def test_wheel_uses_pixel_scrolling(self, overlay, monkeypatch):
        calls = []
        monkeypatch.setattr(overlay.chat, "yview_scroll",
                            lambda n, what: calls.append((n, what)))
        overlay._on_wheel(_wheel(120))       # one notch up
        overlay._on_wheel(_wheel(-120))      # one notch down
        assert calls == [(-40, "pixels"), (40, "pixels")]   # tk8.6 text.tcl formula

    def test_small_touchpad_deltas_still_scroll(self, overlay, monkeypatch):
        calls = []
        monkeypatch.setattr(overlay.chat, "yview_scroll",
                            lambda n, what: calls.append((n, what)))
        overlay._on_wheel(_wheel(-30))       # precision-touchpad delta < 120
        assert calls and calls[0][0] != 0    # the old /120 units formula rounded to 0


class TestFollow:

    def _fill(self, overlay, lines=300):
        for i in range(lines):
            overlay.chat.insert("end", f"line {i}\n")
        overlay.root.update_idletasks()

    def test_content_never_moves_view_when_user_scrolled_up(self, overlay):
        self._fill(overlay)
        overlay.chat.yview_moveto(0.0)
        overlay._note_user_scroll()          # user is at the top → follow disengages
        assert overlay.follow is False
        overlay.add_sys("new content at the bottom")
        overlay.root.update_idletasks()
        assert overlay.chat.yview()[1] < 0.9   # view stayed up — no yank to the bottom

    def test_returning_to_bottom_reengages_follow(self, overlay):
        self._fill(overlay)
        overlay.chat.yview_moveto(0.0)
        overlay._note_user_scroll()
        overlay.chat.yview_moveto(1.0)
        overlay._note_user_scroll()          # user came back down
        assert overlay.follow is True

    def test_reset_restores_follow(self, overlay):
        overlay.follow = False
        overlay.reset()
        assert overlay.follow is True

    def test_follow_is_per_chat(self, overlay):
        overlay.follow = False
        v2 = overlay.new_chat()
        assert overlay.follow is True        # the new chat follows
        assert overlay._views[0].follow is False


# ── ☰ conversation list panel ────────────────────────────────────────────────

class TestChatListPanel:

    def test_open_shows_rows_from_chats_items(self, overlay):
        overlay.new_chat()
        overlay.toggle_chat_list()
        f = overlay._chat_list_frame
        assert f is not None
        # each row is a Frame holding the name Label (+ optional 🗑)
        texts = []
        for w in f.winfo_children():
            if isinstance(w, co.tk.Label):
                texts.append(w.cget("text"))
            else:
                texts.extend(k.cget("text") for k in w.winfo_children()
                             if isinstance(k, co.tk.Label))
        for lbl, _cmd, _del in overlay._chats_items():
            assert lbl in texts
        assert overlay.chats_btn.cget("fg") == co.T["accent"]   # lit while open

    def test_row_action_switches_and_closes_panel(self, overlay):
        v1 = overlay._views[0]
        overlay.new_chat()
        overlay.toggle_chat_list()
        overlay._chat_list_action(lambda: overlay.switch_chat(v1))
        assert overlay._chat_list_frame is None
        assert overlay._active is v1
        assert v1.wrap.winfo_manager()       # transcript is packed again

    def test_toggle_twice_restores_transcript(self, overlay):
        overlay.toggle_chat_list()
        overlay.toggle_chat_list()
        assert overlay._chat_list_frame is None
        assert overlay._active.wrap.winfo_manager()

    def test_row_click_opens_and_trash_deletes(self, overlay):
        """The panel renders one row per chat: the label opens, the 🗑 deletes."""
        overlay.new_chat()
        overlay.toggle_chat_list()
        rows = [w for w in overlay._chat_list_frame.winfo_children()
                if isinstance(w, co.tk.Frame)]
        assert rows, "expected a Frame per conversation row"
        kids = rows[0].winfo_children()
        assert any(isinstance(k, co.tk.Label) and k.cget("text") == "🗑" for k in kids)

    def test_switch_chat_closes_open_panel(self, overlay):
        v2 = overlay.new_chat()
        overlay.toggle_chat_list()
        overlay.switch_chat(overlay._views[0])
        assert overlay._chat_list_frame is None


# ── the placeholder must never swallow real typing ───────────────────────────

class TestPlaceholder:
    """Tk has no native placeholder, so the hint is REAL text in the entry. The
    failure mode the user hit: after switching chats the hint was re-inserted while
    the entry had focus, so their typing landed beside it, _ph_active stayed True,
    and _entry_text() returned "" — the message looked typed but could not be sent."""

    def test_typing_clears_the_hint(self, overlay):
        overlay._ph_in()
        assert overlay._ph_active is True
        overlay._ph_key(types.SimpleNamespace(keysym="h", state=0))
        assert overlay._ph_active is False
        overlay.entry.insert("insert", "hello")
        assert overlay._entry_text() == "hello"
        assert co.PLACEHOLDER not in overlay.entry.get("1.0", "end")

    def test_modifiers_do_not_clear_the_hint(self, overlay):
        overlay._ph_in()
        for k in ("Shift_L", "Control_L", "Alt_L"):
            overlay._ph_key(types.SimpleNamespace(keysym=k, state=0))
        assert overlay._ph_active is True          # still just a hint

    def test_hint_not_inserted_while_entry_has_focus(self, overlay):
        overlay.entry.focus_set()
        overlay.root.update_idletasks()
        overlay.entry.delete("1.0", "end")
        overlay._ph_active = False
        overlay._ph_in()                            # would have armed the trap
        if overlay.root.focus_get() is overlay.entry:
            assert overlay._ph_active is False
            assert co.PLACEHOLDER not in overlay.entry.get("1.0", "end")

    def test_switching_chats_leaves_a_typable_entry(self, overlay):
        v1 = overlay._views[0]
        overlay.new_chat()
        overlay.switch_chat(v1)
        # whatever the focus state, typing must produce sendable text
        overlay._ph_key(types.SimpleNamespace(keysym="a", state=0))
        overlay.entry.insert("insert", "can you see this")
        assert overlay._entry_text() == "can you see this"

    def test_draft_restore_is_never_greyed(self, overlay):
        v1 = overlay._views[0]
        overlay.new_chat()                     # switching away parks v1's draft…
        v1.draft = "half a thought"            # …so set it AFTER the switch
        overlay.switch_chat(v1)
        assert overlay._ph_active is False
        assert overlay._entry_text() == "half a thought"
        assert overlay.entry.cget("fg") == co.T["text"]      # not the faint hint colour


# ── screenshot thumbnails + lightbox ─────────────────────────────────────────

@pytest.fixture
def png(tmp_path):
    from PIL import Image
    p = tmp_path / "shot.png"
    Image.new("RGB", (640, 400), (200, 30, 30)).save(p)
    return str(p)


class TestThumbnails:

    def test_send_with_image_embeds_thumbnail(self, overlay, monkeypatch, png):
        monkeypatch.setattr(co.authstate, "dead_reason", lambda: None)
        overlay.auto_shot = False
        overlay.pending_images = [png]
        overlay._ph_out()
        overlay.entry.insert("1.0", "look at this")
        before = len(overlay.chat.window_names())
        overlay._send_or_stop()
        assert len(overlay.chat.window_names()) > before + 1   # bubble AND thumbnail

    def test_thumbnail_never_upscales(self, overlay, tmp_path):
        from PIL import Image
        tiny = tmp_path / "tiny.png"
        Image.new("RGB", (30, 20), (0, 0, 0)).save(tiny)
        overlay._add_shot_thumbs([str(tiny)])
        thumbs = [overlay.chat.nametowidget(n) for n in overlay.chat.window_names()]
        imgs = [w for w in thumbs if getattr(w, "_photo", None) is not None]
        assert imgs and imgs[-1]._photo.width() == 30          # not blown up

    def test_unreadable_path_is_skipped_quietly(self, overlay, tmp_path):
        overlay._add_shot_thumbs([str(tmp_path / "missing.png")])
        assert "⚠" not in chat_text(overlay)                   # no error spam


class TestLightbox:

    def test_open_and_escape_close(self, overlay, png):
        top = overlay._open_lightbox(png)
        assert top is not None and overlay._lightbox is top
        assert top.bind("<Escape>")          # Esc is wired (key events can't be
        top._close()                         # synthesized on a withdrawn window)
        overlay.root.update_idletasks()
        assert overlay._lightbox is None

    def test_click_closes(self, overlay, png):
        top = overlay._open_lightbox(png)
        top.event_generate("<Button-1>")
        overlay.root.update_idletasks()
        assert overlay._lightbox is None

    def test_missing_file_reports_not_crashes(self, overlay):
        assert overlay._open_lightbox(r"Z:\nope\gone.png") is None
        assert "Couldn't open the image" in chat_text(overlay)

    def test_only_one_lightbox_at_a_time(self, overlay, png):
        a = overlay._open_lightbox(png)
        b = overlay._open_lightbox(png)
        assert overlay._lightbox is b
        assert not a.winfo_exists()


# ── ⚙ microphone picker ──────────────────────────────────────────────────────

class TestMicPicker:

    def test_device_list_shape(self):
        rows = voice.list_input_devices()
        assert rows and rows[0][1] is None                     # "System default" first
        assert rows[0][0].startswith("System default")
        assert all(isinstance(l, str) for l, _v in rows)

    def test_set_device_persists_by_name(self, overlay, monkeypatch, tmp_path):
        cfg = tmp_path / "config.json"
        monkeypatch.setattr(co, "USER_CONFIG_FILE", cfg)
        overlay._set_voice_device("Microphone Array (Realtek(R) Audio)", "Realtek")
        assert overlay.voice_device == "Microphone Array (Realtek(R) Audio)"
        import json
        assert json.loads(cfg.read_text("utf-8"))["VOICE_DEVICE"] == \
            "Microphone Array (Realtek(R) Audio)"
        overlay._set_voice_device(None, "System default")      # back to following Windows
        assert json.loads(cfg.read_text("utf-8"))["VOICE_DEVICE"] is None

    def test_gear_menu_has_microphone_row(self, overlay):
        labels = [lbl for lbl, _ in overlay._gear_items()]
        assert any("Microphone" in l for l in labels)

    def test_recorder_receives_chosen_device(self, overlay, monkeypatch):
        seen = {}

        class Rec:
            peak = 0.0
            def start(self, device_name=None):
                seen["device"] = device_name
            def elapsed(self):
                return 0.0
            def stop(self):
                return None
        monkeypatch.setattr(co.voice, "missing_deps", lambda: [])
        monkeypatch.setattr(co.voice, "Recorder", Rec)
        overlay.voice_device = "Some Mic"
        overlay.toggle_voice()
        overlay._cancel_voice()
        assert seen["device"] == "Some Mic"
