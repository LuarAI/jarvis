# -*- coding: utf-8 -*-
"""Tests for the Jarvis phase-1 features layered onto the seed app:

  1. Fable in the model switcher (config.MODELS)          — covered in test_config.py
  2. Context folders (config.CONTEXT_DIRS → SDK add_dirs, ⚙ picker)

Follows the house conventions: config/worker tests are pure (no GUI, no network);
UI tests drive the real shared Overlay from conftest with the FakeWorker recording
calls.
"""

import json
import queue

import pytest

import config
import worker as worker_module
from worker import ClaudeWorker


# ---------------------------------------------------------------------------
# config: CONTEXT_DIRS default and validator
# ---------------------------------------------------------------------------

class TestContextDirsConfig:

    def test_default_is_empty_list(self):
        # A released build must not expose any directory the user didn't choose.
        assert config.CONTEXT_DIRS == []

    def test_overridable_with_dir_list_validator(self):
        assert config._USER_CONFIG_KEYS["CONTEXT_DIRS"] is config._v_dir_list

    def test_validator_accepts_empty_and_existing(self, tmp_path):
        assert config._v_dir_list([]) == []
        assert config._v_dir_list([str(tmp_path)]) == [str(tmp_path)]

    def test_validator_rejects_non_list_and_bad_entries(self, tmp_path):
        bad = config._BAD
        assert config._v_dir_list("not-a-list") is bad
        assert config._v_dir_list(123) is bad
        # ONE bad path rejects the WHOLE list (silently dropping just the bad one
        # would leave the user believing a folder is attached when it isn't).
        missing = str(tmp_path / "does-not-exist")
        assert config._v_dir_list([str(tmp_path), missing]) is bad
        assert config._v_dir_list([42]) is bad
        assert config._v_dir_list(["  "]) is bad


# ---------------------------------------------------------------------------
# worker: CONTEXT_DIRS → ClaudeAgentOptions.add_dirs
# ---------------------------------------------------------------------------

class TestAddDirsOptions:

    def test_no_add_dirs_by_default(self, monkeypatch):
        monkeypatch.setattr(worker_module, "CONTEXT_DIRS", [])
        opts = ClaudeWorker(queue.Queue())._make_options()
        assert not getattr(opts, "add_dirs", None), (
            "empty CONTEXT_DIRS must leave the options exactly as before the feature")

    def test_context_dirs_become_add_dirs(self, monkeypatch, tmp_path):
        monkeypatch.setattr(worker_module, "CONTEXT_DIRS", [str(tmp_path)])
        opts = ClaudeWorker(queue.Queue())._make_options()
        assert list(getattr(opts, "add_dirs") or []) == [str(tmp_path)]

    def test_reads_list_at_build_time(self, monkeypatch, tmp_path):
        # The ⚙ menu mutates the list IN PLACE; _make_options must see the mutation
        # on the next build (that's how "applies to the next session" works).
        live = []
        monkeypatch.setattr(worker_module, "CONTEXT_DIRS", live)
        w = ClaudeWorker(queue.Queue())
        assert not getattr(w._make_options(), "add_dirs", None)
        live.append(str(tmp_path))
        assert list(getattr(w._make_options(), "add_dirs") or []) == [str(tmp_path)]


# ---------------------------------------------------------------------------
# UI: gear rows + context-folder picker
# ---------------------------------------------------------------------------

def _gear_cmds(ov):
    return {lbl.strip("✓ …").strip(): cmd for lbl, cmd in ov._gear_items()}


class TestGearRows:

    def test_add_context_folder_row_wired(self, overlay):
        assert _gear_cmds(overlay)["Add context folder"] == overlay.add_context_dir

    def test_forget_row_only_when_dirs_attached(self, overlay, tmp_path):
        import claude_overlay as co
        labels = [lbl for lbl, _ in overlay._gear_items()]
        assert not any("Forget context folders" in l for l in labels)
        co.CONTEXT_DIRS.append(str(tmp_path))
        labels = [lbl for lbl, _ in overlay._gear_items()]
        assert any("Forget context folders (1)" in l for l in labels)


class TestContextDirPicker:

    def test_add_context_dir_appends_and_persists(self, overlay, monkeypatch, tmp_path):
        import claude_overlay as co
        cfg = tmp_path / "cfg" / "config.json"
        monkeypatch.setattr(co, "USER_CONFIG_FILE", cfg)
        import tkinter.filedialog as fd
        monkeypatch.setattr(fd, "askdirectory", lambda **k: str(tmp_path))
        overlay.add_context_dir()
        import os
        assert co.CONTEXT_DIRS == [os.path.normpath(str(tmp_path))]
        saved = json.loads(cfg.read_text("utf-8"))
        assert saved["CONTEXT_DIRS"] == [os.path.normpath(str(tmp_path))]

    def test_add_preserves_other_config_keys(self, overlay, monkeypatch, tmp_path):
        import claude_overlay as co
        cfg = tmp_path / "config.json"
        cfg.write_text(json.dumps({"THEME": "dark"}), "utf-8")
        monkeypatch.setattr(co, "USER_CONFIG_FILE", cfg)
        import tkinter.filedialog as fd
        monkeypatch.setattr(fd, "askdirectory", lambda **k: str(tmp_path))
        overlay.add_context_dir()
        saved = json.loads(cfg.read_text("utf-8"))
        assert saved["THEME"] == "dark"          # read-modify-write, not clobber
        assert saved["CONTEXT_DIRS"]

    def test_cancel_leaves_everything_alone(self, overlay, monkeypatch, tmp_path):
        import claude_overlay as co
        cfg = tmp_path / "config.json"
        monkeypatch.setattr(co, "USER_CONFIG_FILE", cfg)
        import tkinter.filedialog as fd
        monkeypatch.setattr(fd, "askdirectory", lambda **k: "")   # user hit Cancel
        overlay.add_context_dir()
        assert co.CONTEXT_DIRS == []
        assert not cfg.exists()

    def test_duplicate_not_added_twice(self, overlay, monkeypatch, tmp_path):
        import claude_overlay as co
        monkeypatch.setattr(co, "USER_CONFIG_FILE", tmp_path / "config.json")
        import tkinter.filedialog as fd
        monkeypatch.setattr(fd, "askdirectory", lambda **k: str(tmp_path))
        overlay.add_context_dir()
        overlay.add_context_dir()
        assert len(co.CONTEXT_DIRS) == 1

    def test_forget_clears_and_persists(self, overlay, monkeypatch, tmp_path):
        import claude_overlay as co
        cfg = tmp_path / "config.json"
        monkeypatch.setattr(co, "USER_CONFIG_FILE", cfg)
        co.CONTEXT_DIRS.append(str(tmp_path))
        overlay.forget_context_dirs()
        assert co.CONTEXT_DIRS == []
        assert json.loads(cfg.read_text("utf-8"))["CONTEXT_DIRS"] == []
