# Jarvis app (phases 1–2)

This is the working Jarvis application: a fork of [claude-overlay](https://github.com/shengyanlin/claude-overlay) by shengyanlin (MIT — see [LICENSE](LICENSE)), extended with the Jarvis features:

- **Multiple parallel chats** (💬 in the status bar, Ctrl+N new, Ctrl+Tab cycle) — each chat is its own agent session with its own model, permission mode, context % and transcript; a busy chat keeps streaming in the background while you talk in another. Background replies mark the 💬 button (and the collapsed orb) until you look. Recently-closed conversations can be reopened from the 💬 menu (Claude remembers them; the transcript isn't replayed).
- **Claude 5 model options** (Fable/Opus/Sonnet/Haiku) in the status-line model switcher, per chat
- **Context folders** — point the assistant at any folder(s) on your machine; contents are read on demand, like attaching context in a chat

Parallel chats default to at most 4 (`MAX_CHATS`) — each one is its own `claude` subprocess, and 2–4 concurrent sessions is the sweet spot on a subscription before rate limits bite.

Per the [blueprint](../docs/BLUEPRINT.md), this Tkinter app is the phase-1/2 vehicle; the shell migrates to Tauri in phase 4.

## Run

Prerequisites: Windows 10/11, Python 3.10+, the [Claude Code CLI](https://claude.com/claude-code) logged in with your subscription (`claude auth login`).

```
setup.cmd                     # one-time: installs Python deps, checks the CLI
Start Claude Overlay.cmd      # launch
```

Settings live in `config.py`, overridable per machine in `%LOCALAPPDATA%\claude-overlay\config.json` (see `_USER_CONFIG_KEYS` in config.py for what's overridable). Notable keys: `PERMISSION_MODE`, `WORKING_DIR`, `CONTEXT_DIRS`, `MODEL`, `MAX_CHATS`, `WINDOW_ALPHA`, `AUTO_SCREENSHOT_DEFAULT`.
