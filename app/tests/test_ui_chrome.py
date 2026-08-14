"""UI feature tests for window-chrome / interaction features of the Overlay.

Drives the REAL methods on the `overlay` fixture (session-wide, hidden Tk root,
FakeWorker that records calls) and asserts on widget state / instance attributes /
the FakeWorker call log.
"""
import pytest
import tkinter as tk

from conftest import chat_text


# ── helpers ──────────────────────────────────────────────────────────────────

def _type_in_entry(ov, text):
    """Put literal text in the entry widget, bypassing the placeholder."""
    ov._ph_out()
    ov.entry.delete("1.0", "end")
    ov.entry.insert("1.0", text)
    ov._ph_active = False


# ── collapse / expand ─────────────────────────────────────────────────────────

def test_toggle_collapse_flips_expanded(overlay):
    """toggle_collapse() flips `expanded` from True to False."""
    assert overlay.expanded is True
    overlay.toggle_collapse()
    assert overlay.expanded is False


def test_toggle_collapse_twice_returns_to_expanded(overlay):
    """Two toggles bring `expanded` back to True without raising."""
    overlay.toggle_collapse()   # True → False
    overlay.toggle_collapse()   # False → True
    assert overlay.expanded is True


def test_collapse_does_not_raise(overlay):
    """Collapsing a fully-expanded overlay raises no exception."""
    try:
        overlay.toggle_collapse()
    except Exception as exc:
        pytest.fail(f"toggle_collapse() raised: {exc}")


# ── zoom ──────────────────────────────────────────────────────────────────────

def test_set_zoom_increases_font_magnitude(overlay):
    """_set_zoom(1.4) makes the body-font size magnitude larger (more negative px)."""
    baseline = overlay.f_body.cget("size")          # negative pixel value at zoom 1.0
    overlay._set_zoom(1.4)
    zoomed = overlay.f_body.cget("size")
    # sizes are negative (pixel) — larger font ⇒ more negative ⇒ zoomed < baseline
    assert zoomed < baseline, f"Expected a larger (more negative) size; got {baseline} → {zoomed}"


def test_set_zoom_decreases_font_magnitude(overlay):
    """_set_zoom(0.8) makes the body-font size magnitude smaller (less negative px)."""
    baseline = overlay.f_body.cget("size")
    overlay._set_zoom(0.8)
    zoomed = overlay.f_body.cget("size")
    assert zoomed > baseline, f"Expected a smaller (less negative) size; got {baseline} → {zoomed}"


def test_set_zoom_stores_zoom_attribute(overlay):
    """_set_zoom(z) stores the clamped value in overlay.zoom."""
    overlay._set_zoom(1.3)
    assert abs(overlay.zoom - 1.3) < 0.05


def test_zoom_evt_positive_increases_zoom(overlay):
    """_zoom_evt(+1) increases overlay.zoom by ~10 %."""
    before = overlay.zoom
    overlay._zoom_evt(1)
    assert overlay.zoom > before


def test_zoom_evt_negative_decreases_zoom(overlay):
    """_zoom_evt(-1) decreases overlay.zoom by ~10 %."""
    before = overlay.zoom
    overlay._zoom_evt(-1)
    assert overlay.zoom < before


def test_set_zoom_reset(overlay):
    """_set_zoom(1.0) resets zoom near the 1.0 baseline."""
    overlay._set_zoom(1.6)   # push it up first
    overlay._set_zoom(1.0)
    assert abs(overlay.zoom - 1.0) < 0.05


# ── placeholder ───────────────────────────────────────────────────────────────

def test_ph_in_sets_ph_active(overlay):
    """_ph_in() puts the placeholder in the entry and sets _ph_active=True."""
    # First clear so there is nothing in the box
    overlay.entry.delete("1.0", "end")
    overlay._ph_active = False
    overlay._ph_in()
    assert overlay._ph_active is True


def test_ph_in_inserts_placeholder_text(overlay):
    """After _ph_in() the entry contains the placeholder string."""
    from claude_overlay import PLACEHOLDER
    overlay.entry.delete("1.0", "end")
    overlay._ph_active = False
    overlay._ph_in()
    raw = overlay.entry.get("1.0", "end").strip()
    assert raw == PLACEHOLDER


def test_ph_out_clears_ph_active(overlay):
    """_ph_out() clears the entry and sets _ph_active=False."""
    overlay.entry.delete("1.0", "end")
    overlay._ph_active = False
    overlay._ph_in()            # put placeholder in
    overlay._ph_out()           # clear it
    assert overlay._ph_active is False


def test_entry_text_returns_empty_when_ph_active(overlay):
    """_entry_text() returns '' when the placeholder is active."""
    overlay.entry.delete("1.0", "end")
    overlay._ph_active = False
    overlay._ph_in()
    assert overlay._entry_text() == ""


def test_entry_text_returns_text_when_not_ph_active(overlay):
    """_entry_text() returns the real text when the placeholder is not active."""
    _type_in_entry(overlay, "hello world")
    assert overlay._entry_text() == "hello world"


# ── send routing ──────────────────────────────────────────────────────────────

def test_send_or_stop_calls_ask_when_idle(overlay):
    """_send_or_stop() with text and busy=False records an 'ask' call on the worker."""
    overlay.busy = False
    overlay.auto_shot = False          # disable screenshot so we control all branches
    _type_in_entry(overlay, "what is 2+2?")
    overlay._send_or_stop()
    names = [name for name, _ in overlay.worker.calls]
    assert "ask" in names, f"Expected 'ask' in calls; got {overlay.worker.calls}"


def test_send_or_stop_calls_interrupt_when_busy(overlay):
    """_send_or_stop() with busy=True records an 'interrupt' call instead of 'ask'."""
    overlay.busy = True
    overlay._send_or_stop()
    names = [name for name, _ in overlay.worker.calls]
    assert "interrupt" in names, f"Expected 'interrupt' in calls; got {overlay.worker.calls}"
    assert "ask" not in names


def test_send_state_contains_busy_when_busy(overlay):
    """_send_state() includes 'busy' when overlay.busy is True."""
    overlay.busy = True
    assert "busy" in overlay._send_state()


def test_send_state_contains_idle_when_not_busy(overlay):
    """_send_state() includes 'idle' when overlay.busy is False."""
    overlay.busy = False
    assert "idle" in overlay._send_state()


# ── copy button ───────────────────────────────────────────────────────────────

def test_finish_turn_copy_adds_copy_button(overlay):
    """_finish_turn_copy() inserts one Copy button into the chat for a non-empty turn."""
    before = len(overlay.chat.window_names())
    overlay._turn_raw = "**hi** there"
    overlay._turn_copy_added = False
    overlay._finish_turn_copy()
    overlay.root.update_idletasks()
    after = len(overlay.chat.window_names())
    assert after > before, "Expected at least one new embedded widget (Copy button) after _finish_turn_copy()"


def test_finish_turn_copy_is_idempotent(overlay):
    """Calling _finish_turn_copy() twice adds exactly one Copy button."""
    overlay._turn_raw = "**hi** there"
    overlay._turn_copy_added = False
    overlay._finish_turn_copy()
    overlay.root.update_idletasks()
    count_after_first = len(overlay.chat.window_names())
    overlay._finish_turn_copy()   # second call should be a no-op (_turn_copy_added=True)
    overlay.root.update_idletasks()
    count_after_second = len(overlay.chat.window_names())
    assert count_after_second == count_after_first, (
        "Second _finish_turn_copy() must not add another Copy button"
    )


def test_copy_btn_puts_text_on_clipboard(overlay, monkeypatch):
    """Clicking the Copy button replaces the clipboard with that message's raw markdown.

    Two things this deliberately does NOT do, both learned the hard way:

    It does not synthesise a <Button-1>. Tk discards a synthesised button event aimed at a
    withdrawn widget, and this whole suite runs withdrawn on purpose -- so the handler
    never ran, and the old assertion compared the expected string against whatever was on
    the MACHINE's clipboard. It passed because an earlier run of this same test had left
    that exact string there, and went red the moment somebody copied something else: it
    reported on the developer's clipboard and never on the Copy button.

    It also does not write to the real clipboard. Tk hands the Windows clipboard out by
    delayed rendering, so everything it owns is dropped when the interpreter exits -- a
    suite that copies for real ends by wiping whatever the developer had copied, and no
    amount of save/restore inside the test can put it back. Recording the calls tests the
    same contract (clear, then append THIS message's snapshot) and costs the developer
    nothing.
    """
    raw = "**hi** there"
    calls = []
    monkeypatch.setattr(overlay.root, "clipboard_clear",
                        lambda *a, **k: calls.append(("clear",)))
    monkeypatch.setattr(overlay.root, "clipboard_append",
                        lambda t, *a, **k: calls.append(("append", t)))

    btn = overlay._copy_btn(raw)
    overlay.root.update_idletasks()
    btn._on_click(None)

    # No root.update() here, deliberately. on_click schedules after(1200, restore), which
    # sets _copied back to False so the button stops saying "Copied" -- and pumping the
    # event loop lets that fire if the call happens to take longer than 1.2 s, which it
    # occasionally does. Both assertions are on plain Python state, so there is nothing to
    # pump for, and not pumping removes the race rather than widening the window.
    assert btn._copied is True, "the Copy handler did not run"
    assert calls == [("clear",), ("append", raw)], (
        f"expected the clipboard to be replaced with {raw!r}, got {calls!r}")


# ── rename ────────────────────────────────────────────────────────────────────

def test_apply_name_sets_overlay_name(overlay):
    """_apply_name('Winbond FPM') stores the name in overlay.overlay_name."""
    overlay._apply_name("Winbond FPM")
    assert overlay.overlay_name == "Winbond FPM"


def test_apply_name_updates_title_label(overlay):
    """_apply_name() updates the title label text to the new name."""
    overlay._apply_name("Winbond FPM")
    assert overlay.title_lbl.cget("text") == "Winbond FPM"


def test_apply_name_empty_restores_default(overlay):
    """_apply_name('') resets overlay_name to '' and title falls back to 'Claude'."""
    overlay._apply_name("Winbond FPM")
    overlay._apply_name("")
    assert overlay.overlay_name == ""
    assert overlay.title_lbl.cget("text") == "Claude"


def test_cancel_rename_leaves_name_unchanged(overlay):
    """_begin_rename() then _cancel_rename() leaves overlay_name unchanged."""
    overlay._apply_name("Keep Me")
    overlay._begin_rename()
    overlay._cancel_rename()
    assert overlay.overlay_name == "Keep Me"


def test_begin_commit_rename_applies_name(overlay):
    """_begin_rename() → edit entry → _commit_rename() applies the new name."""
    overlay._apply_name("")
    overlay._begin_rename()
    ent = overlay._rename_entry
    ent.delete(0, "end")
    ent.insert(0, "New Name")
    overlay._commit_rename()
    assert overlay.overlay_name == "New Name"


# ── model switch ──────────────────────────────────────────────────────────────

def test_switch_model_records_set_model_call(overlay):
    """_switch_model('sonnet') records a set_model call with 'sonnet' on the worker."""
    overlay.busy = False
    overlay._switch_model("sonnet")
    model_calls = [(n, a) for n, a in overlay.worker.calls if n == "set_model"]
    assert model_calls, f"Expected a 'set_model' call; got {overlay.worker.calls}"
    assert model_calls[0][1][0] == "sonnet"


# ── context gauge / _handle ───────────────────────────────────────────────────

def test_handle_ctx_sets_ctx_pct(overlay):
    """_handle('ctx', 42) stores 42 in overlay._ctx_pct."""
    overlay._handle("ctx", 42)
    assert overlay._ctx_pct == 42


def test_handle_model_sets_model(overlay):
    """_handle('model', 'claude-opus-4-8') stores the model string."""
    overlay._handle("model", "claude-opus-4-8")
    assert overlay._model == "claude-opus-4-8"


def test_refresh_statusline_does_not_raise(overlay):
    """_refresh_statusline() runs without raising regardless of _ctx_pct / _model state."""
    overlay._ctx_pct = 55
    overlay._model = "claude-sonnet-4-6"
    try:
        overlay._refresh_statusline()
    except Exception as exc:
        pytest.fail(f"_refresh_statusline() raised: {exc}")


def test_refresh_statusline_with_none_values(overlay):
    """_refresh_statusline() also survives None _ctx_pct and _model."""
    overlay._ctx_pct = None
    overlay._model = None
    try:
        overlay._refresh_statusline()
    except Exception as exc:
        pytest.fail(f"_refresh_statusline() raised with None values: {exc}")


# ── busy state ────────────────────────────────────────────────────────────────

def test_set_busy_true_sets_busy(overlay):
    """_set_busy(True) sets overlay.busy to True."""
    overlay._set_busy(True)
    assert overlay.busy is True


def test_set_busy_false_clears_busy(overlay):
    """_set_busy(False) clears overlay.busy back to False."""
    overlay._set_busy(True)
    overlay._set_busy(False)
    assert overlay.busy is False


# ── _ensure_on_screen: recover from a window stranded off an unplugged monitor ──────────

def test_ensure_on_screen_noop_when_visible(overlay, monkeypatch):
    """When the window sits on a connected monitor, _ensure_on_screen is a no-op (returns
    None) — it must never yank a window that's already reachable."""
    import claude_overlay as co
    huge = [{"rect": (-10000, -10000, 10000, 10000),
             "work": (-10000, -10000, 10000, 10000), "primary": True}]
    monkeypatch.setattr(co, "enumerate_monitors", lambda: huge)
    assert overlay._ensure_on_screen() is None


def test_ensure_on_screen_relocates_stranded_window(overlay, monkeypatch):
    """With only a far-away monitor connected (simulating the one the window was on being
    unplugged), _ensure_on_screen moves the window onto that monitor's work area."""
    import claude_overlay as co
    before = overlay.root.geometry()
    try:
        far = [{"rect": (5000, 5000, 7000, 7000),
                "work": (5000, 5000, 7000, 6960), "primary": True}]
        monkeypatch.setattr(co, "enumerate_monitors", lambda: far)
        moved = overlay._ensure_on_screen()
        assert moved is not None                 # it decided to relocate
        nx, ny = moved
        assert 5000 <= nx <= 7000 and 5000 <= ny <= 6960
    finally:
        overlay.root.geometry(before)            # don't leave the shared window off-screen
