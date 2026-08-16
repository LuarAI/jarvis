# Jarvis

A floating, Messenger-style AI assistant bubble for Windows — powered by your own Claude subscription.

Jarvis sits on top of whatever you're doing as a small draggable orb. Click it and Claude can see your screen (when you allow it), hold multiple parallel conversations, read the context folders *you* point it at, and — with your explicit, per-action approval — act: fill web forms, drive native apps, and show you where things are on screen.

> **Status: phase 3 — usable today.** Parallel chats, local voice input, a page collector that remembers what you browse, and browser form filling with per-field approval.
> The working app lives in [app/](app/) (a fork of [claude-overlay](https://github.com/shengyanlin/claude-overlay), extended with the first Jarvis features: Messenger-style parallel chats — each its own agent session — conversations that restore transcript-and-all across restarts, local voice input (🎤, faster-whisper), Claude 5 models in the switcher, and user-chosen context folders). The architecture and roadmap below are the output of a deep best-practices research pass — six parallel tracks: shell architecture, agent sessions, browser form-filling, Windows UI Automation, real-time audio, and agent safety. See [docs/BLUEPRINT.md](docs/BLUEPRINT.md) for the full synthesis with sources.

## Quick start

Windows 10/11, Python 3.10+, and the [Claude Code CLI](https://claude.com/claude-code) logged in with your subscription. Then:

```
git clone https://github.com/LuarAI/jarvis.git
cd jarvis\app
setup.cmd                     # installs Python deps, checks the CLI
"Start Claude Overlay.cmd"    # launch the bubble
```

See [app/README.md](app/README.md) for settings (permission mode, context folders, transparency, model).

## Why

Assistants like Claude are brilliant, but using them alongside other apps means endless copy-paste: copy the job posting, paste into chat, copy the answer, paste into the form field, repeat. Meanwhile "invisible overlay" tools (Cluely and its clones) can see and hear, but they're read-only advisors with no memory of you and no hands.

Jarvis aims to be both halves:

- **Sees what you see** — screenshots, or (cheaper and more precise) the actual page content via a companion browser extension. Turn on the 📄 collector and everything you browse is remembered, so you can read six things and then ask about all of them at once.
- **Knows what you tell it** — point any chat at any folder on your machine (your notes, your CV, your project docs) and Claude reads what it needs, on demand.
- **Acts only with consent** — manual approval of every action by default, Claude-Code-style permission modes on top, and hard structural guardrails underneath (see [Safety](#safety)).
- **Runs on your subscription** — drives your logged-in Claude Code CLI via the official Agent SDK. No API key, no metered billing.

## Planned architecture

```
┌─────────────────────────────────────────────────────┐
│  Overlay UI — Tauri (Rust + WebView)                │
│  bubble · chat list · approvals panel · hidden      │
│  from screen share                                  │
├─────────────────────────────────────────────────────┤
│  Supervisor — Python asyncio                        │
│  chat registry (SQLite) · permission gate ·         │
│  capture control                                    │
├─────────────────────────────────────────────────────┤
│  Agent sessions — N × claude-agent-sdk clients      │
│  → local `claude` CLI → your Claude subscription    │
├─────────────────────────────────────────────────────┤
│  Perception & hands                                 │
│  screen capture · browser extension (native         │
│  messaging) · UI Automation + highlight overlay ·   │
│  audio sidecar (WASAPI)                             │
└─────────────────────────────────────────────────────┘
```

Key decisions (each argued with sources in the [blueprint](docs/BLUEPRINT.md)):

| Area | Decision |
|---|---|
| Shell | Tauri + Python agent sidecar (small, fast, native capture-exclusion, signed auto-update) |
| Multi-chat | One SDK session per chat; warm pool + resume-on-demand; sidebar from the SDK's session-browser APIs |
| Context | Per-chat **context folders** chosen by the user; read on demand via `add_dirs` — big folders cost nothing until read |
| Web forms | Chrome MV3 extension + native messaging; DOM-based filling with per-field user review |
| Native apps | UIA accessibility tree first, vision fallback (the Microsoft UFO2 pattern); app scripting APIs when they exist |
| "Show me where" | Element rectangle → click-through highlight pulse; numbered-grid (set-of-marks) fallback |
| Audio | Native WASAPI two-channel capture (mic = "me", loopback = "them") + local Whisper |

## Safety

Prompt injection through screen and page content is an unsolved problem — published benchmarks hijack browser agents at rates up to 100% on realistic pages. Jarvis therefore treats safety as architecture, not prompting:

- **Manual approval is the default.** Every action shows you what will be done before it happens. Auto-approve, accept-edits, and read-only modes are opt-in per chat.
- **Reader/actor separation.** The turn that reads untrusted screen content has no action tools; what it extracts is passed forward as data, never as instructions.
- **Browser-enforced scoping.** The extension physically cannot touch sites you haven't granted.
- **Credentials are untouchable.** Password and payment fields are never filled; screen capture pauses when they're focused (the pattern proven by OpenAI's Operator, learning from Microsoft Recall's failures).
- **Escalation only through the UI.** Permission modes can never be changed from inside a conversation — so nothing an attacker puts on screen can talk the agent into more power.

## Roadmap

1. ~~**Quality of life** — model picker (Claude 5 family), context-folder wiring~~ ✅
2. ~~**Multi-chat** — Messenger-style parallel chats, per-chat sessions, reopen-recent~~ ✅
3. ~~**Browser extension** — page context instead of screenshots, and job-application form filling with per-field review~~ ✅ (see [extension/](extension/))
4. **Tauri shell** — installer, auto-update, translucent-when-collapsed orb
5. **"Show me where" + native-app control** — highlight overlay, UIA actions, watch mode
6. **Meeting copilot** — live local transcription with visible-recording consent UX

## Credits

Jarvis is seeded by ideas and hard-won Win32 techniques from [claude-overlay](https://github.com/shengyanlin/claude-overlay) by shengyanlin (MIT) — a great single-chat Claude overlay you can use today. The multi-agent research phase also drew on the architectures of [Pluely](https://github.com/iamsrikanthnani/pluely), [Glass](https://github.com/pickle-com/glass), [nanobrowser](https://github.com/nanobrowser/nanobrowser), [Windows-MCP](https://github.com/CursorTouch/Windows-MCP), and Microsoft's [UFO2](https://github.com/microsoft/UFO).

## License

[AGPL-3.0](LICENSE). Use it, learn from it, build on it — but derivatives must stay open source.
