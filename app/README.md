# Jarvis app (phases 1–2)

This is the working Jarvis application: a fork of [claude-overlay](https://github.com/shengyanlin/claude-overlay) by shengyanlin (MIT — see [LICENSE](LICENSE)), extended with the Jarvis features:

- **Multiple parallel chats** (☰ top-left, Ctrl+N new, Ctrl+Tab cycle) — each chat is its own agent session with its own model, permission mode, context % and transcript; a busy chat keeps streaming in the background while you talk in another. The ☰ opens a full-panel conversation list sorted by recent activity, where each row carries two distinct actions: **✕ closes** (the conversation stays, resumable) and **🗑 deletes** it for good, with an Undo. Background replies light up the ☰ (and badge the collapsed orb) until you look.
- **Conversations survive a restart** — on launch the overlay restores your last conversation, transcript and all, and resumes it so you pick up where you left off (press Clear to start fresh instead). Recently-closed conversations reopen the same way from the 💬 menu.
- **Voice input** (mic in the status bar) — click to record (live level bar proves the mic is capturing), click again to transcribe; the text lands in the message box for review (never auto-sent), Esc cancels. Pick your microphone in ⚙ → Microphone (defaults to the Windows default device). Fully local (faster-whisper on your CPU — audio never leaves the machine) and bilingual-friendly (language auto-detected per utterance). Optional: `pip install -r requirements-voice.txt`; the speech model (~480 MB for the default `small`) downloads once on first use.
- **Page collector (📄)** — turn it on and every page you open in Chrome is remembered, then rides along with your next message. Read six job postings at your own pace and ask *"compare these"* — no copy-pasting, and no automation pointed at the site. Hover the counter to see what's queued, click to drop any of it. Arms itself when the browser extension connects.
- **Browser form filling** — with the [companion extension](../extension/) loaded, Jarvis reads the page (real field labels, not pixels) and proposes form values you approve field by field. Passwords, payment and hidden bot-trap fields are excluded structurally, and forms are never submitted.
- **Approve or reject actions** — file edits, commands and form fills pause and show you exactly what they'd do (the command, a −/+ diff preview) with Approve / Reject / Always allow. Reads never interrupt. A hijacked web page can propose an action, but it can't click the button.
- **Screenshot thumbnails** — every image that goes with a message shows as a clickable thumbnail under the bubble (see exactly what Claude saw); click for a full-size viewer (Esc / click / ✕ closes). The 📎 pending-attachment chip previews on click too, before anything is sent.
- **Claude 5 model options** (Fable/Opus/Sonnet/Haiku) in the status-line model switcher, per chat — your last pick is the default for new chats and the next launch
- **Context folders** — point the assistant at any folder(s) on your machine; contents are read on demand, like attaching context in a chat

Parallel chats default to at most 4 (`MAX_CHATS`) — each one is its own `claude` subprocess, and 2–4 concurrent sessions is the sweet spot on a subscription before rate limits bite.

Per the [blueprint](../docs/BLUEPRINT.md), this Tkinter app is the phase-1/2 vehicle; the shell migrates to Tauri in phase 4.

## Run

Prerequisites: Windows 10/11, Python 3.10+, the [Claude Code CLI](https://claude.com/claude-code) logged in with your subscription (`claude auth login`).

```
setup.cmd                     # one-time: installs Python deps, checks the CLI
Start Claude Overlay.cmd      # launch
```

Settings live in `config.py`, overridable per machine in `%LOCALAPPDATA%\claude-overlay\config.json` (see `_USER_CONFIG_KEYS` in config.py for what's overridable). Notable keys: `PERMISSION_MODE`, `WORKING_DIR`, `CONTEXT_DIRS`, `MODEL`, `MAX_CHATS`, `VOICE_MODEL`, `VOICE_DEVICE`, `WINDOW_ALPHA`, `AUTO_SCREENSHOT_DEFAULT`.

A note on `WORKING_DIR`: every chat starts *in* that folder — Claude treats it as the project it's working from and may mention it ("your X project") even in unrelated conversations. Point it at a neutral folder if you don't want that.
