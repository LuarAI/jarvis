# Jarvis Blueprint

**Research synthesis · pre-code · 2026-08**

A floating, Messenger-style AI assistant for Windows that sees your screen, reads the context folders you point it at, and — with your permission — acts. Powered by the user's own Claude subscription. This document condenses six parallel research tracks into the decisions that shape the build. Every claim carries its sources inline.

---

## Decisions at a glance

| Area | Decision | Why |
|---|---|---|
| Shell | Tauri (Rust + WebView) with the agent as a Python sidecar | ~10 MB installer, ~45 MB RAM, native hide-from-capture, signed auto-updater. Electron is 4–6× heavier with documented capture bugs |
| Agent core | Python `claude-agent-sdk` driving the logged-in `claude` CLI | Subscription auth, no API key — verified working; SDK feature parity with TypeScript |
| Multi-chat | One session per chat; warm pool of 2–4 clients + resume-on-demand; sidebar from `list_sessions()` | Officially sanctioned pattern; Anthropic ships session-browser APIs and a cookbook for exactly this UI |
| Context folders | User picks any folder(s) per chat; tiny always-loaded index + full contents read on demand via `add_dirs` | Fixed small token cost per session; bulk knowledge free until actually read |
| Web forms | Chrome MV3 extension + native messaging to the local app; per-site opt-in; user approves every consequential action | DOM access beats vision for accuracy and tokens; Chrome 136 blocked external automation of real profiles — extensions are the only remaining route |
| Native apps | UIA accessibility tree first, vision fallback (Microsoft UFO2 pattern); app APIs when they exist | Some pro apps are UIA-dark (e.g. DaVinci Resolve) but ship scripting APIs; Windows-MCP / Windows-Use offer adoptable building blocks |
| "Show me where" | UIA rectangle → click-through highlight overlay; numbered-grid (set-of-marks) fallback | Research shows mark-selection beats raw coordinates; the overlay is standard Win32 layered-window work |
| Audio | Native WASAPI loopback (Rust sidecar; PyAudioWPatch for MVP); two channels = Me/Them; Silero VAD + faster-whisper | Every Electron-loopback clone has a "no audio on Windows" bug cluster; the native-capture clones don't |
| Safety | Manual approval by default + permission modes; reader/actor separation; capture pauses on password fields; escalation only via UI | Prompt injection is unsolved — benchmarks show up to 100% hijack rates on browser agents; defenses must be architectural |

## System shape

```
Overlay UI          Tauri WebView · bubble + chat list + approvals panel · hidden from screen share
      ▲ ▼
Supervisor          Python asyncio · chat registry (SQLite) · permission gate · capture control
      ▲ ▼
Agent sessions      N × ClaudeSDKClient → `claude` CLI → user's subscription
      ▲ feeds
Perception & hands  screen capture · Chrome extension (native messaging) · UIA + highlight overlay · audio sidecar
```

---

## 01 · Shell architecture

**Verdict: Tauri shell with a Python agent sidecar. Keep the seed project's Win32 and worker code — it's the hard-won part.**

- **Tauri is what Pluely proves works**: ~10 MB signed installers, ~45 MB idle RAM, built-in auto-updater, capture exclusion, never steals focus. Electron equivalents run 150–300 MB with documented regressions where content-protected windows go black after hide/show.
- **The seed project ([claude-overlay](https://github.com/shengyanlin/claude-overlay)) is more sophisticated than it looks**: per-monitor DPI awareness, `WDA_EXCLUDEFROMCAPTURE`, taskbar identity on a frameless window, multi-monitor recovery — all already solved in its `win32utils.py`, plus battle-tested reconnect/resume logic in `worker.py`. Port, don't rewrite.
- **Gaps to add in the Rust layer**: global hotkeys, tray icon, optional click-through, per-state transparency (translucent collapsed orb, opaque open chat).
- **License lesson**: Pluely went open-source → proprietary after clones resold its code. Jarvis chose AGPL-3.0 deliberately.

Sources: [Pluely](https://github.com/iamsrikanthnani/pluely) · [Tauri v2 overlay write-up](https://blog.manasight.gg/why-i-chose-tauri-v2-for-a-desktop-overlay/) · [Electron content-protection regression](https://github.com/electron/electron/issues/45990) · [cheating-daddy stealth docs](https://deepwiki.com/sohzm/cheating-daddy/3.5-stealth-and-security-features)

## 02 · Multi-chat on the Agent SDK

**Verdict: Messenger-style chats are assembly, not invention — the SDK ships the parts.**

- **Session-browser APIs exist** (`list_sessions()`, `get_session_messages()`, `rename_session()`, `fork_session()`): render the sidebar and history from disk without spawning any agent process. Anthropic has an official cookbook building exactly this.
- **Concurrency is sanctioned**: one CLI subprocess per chat. Keep the 2–4 most recent chats warm (instant replies, interruptible); resume colder chats by session id — a few seconds of spin-up. Idle warm chats cost RAM, never tokens.
- **Context folders, tiered**: (1) per-chat `CLAUDE.md` with persona + an `@import` of a <100-line index of the user's chosen folder — the only always-paid cost; (2) `add_dirs` for on-demand reads of the full folder; (3) repeatable workflows as skills, whose descriptions cost one line each.
- **Free feature**: session forking = "branch this conversation."
- Long chats: rely on auto-compaction, surface the `compact_boundary` divider, recycle very old subprocesses (documented memory growth). Auto-title chats with a one-turn Haiku call.

Sources: [Sessions guide](https://code.claude.com/docs/en/agent-sdk/sessions) · [Session-browser cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser) · [Hosting guide](https://code.claude.com/docs/en/agent-sdk/hosting) · [opcode (Tauri precedent)](https://github.com/winfunc/opcode)

## 03 · Web form filling

**Verdict: MV3 extension + native messaging. The extension route is now *strictly* superior — Chrome 136 closed the alternatives.**

- **Why not external automation**: Chrome deliberately blocks DevTools attachment to the user's real profile (anti-cookie-theft). An extension still gets live logged-in tabs — and with the `debugger` permission, full CDP power for hostile widgets.
- **Every hard problem has a documented fix**: React inputs need the native-setter + `input`-event trick; Greenhouse embeds need `all_frames: true` (cross-origin iframes); resume uploads work via synthetic `DataTransfer`; Workday's fake dropdowns and multi-step pages have working per-field strategies in the open-source *job_app_filler*.
- **Field understanding, layered**: cheap heuristics (`autocomplete`, labels, aria) → small per-ATS adapters (Greenhouse/Lever/Workday cover most traffic) → Claude classifies only the long tail. Cache mappings per ATS.
- **Human-in-the-loop flow**: extension reads form → Jarvis composes from the user's context folder → user approves/edits per field in a side panel → fill → the *user* clicks Submit.
- **Practical caps**: 1 MB native-messaging message limit (chunk file payloads); stray stdout in the host corrupts framing; unpacked personal install needs no store review.

Sources: [Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) · [Chrome 136 change](https://developer.chrome.com/blog/remote-debugging-port) · [nanobrowser](https://github.com/nanobrowser/nanobrowser) · [job_app_filler](https://github.com/berellevy/job_app_filler) · [Bitwarden shadow-DOM deep-dive](https://contributing.bitwarden.com/architecture/deep-dives/autofill/shadow-dom/)

## 04 · Native apps & "show me where"

**Verdict: UIA-first, vision-fallback — the Microsoft UFO2 pattern. Highlights are a solved Win32 problem.**

- **Perception chain**: app-native API if one exists → UIA tree (flat indexed list, one line per interactive element — raw JSON wastes ~44% of tokens on syntax) → OmniParser-style vision merge for custom controls → pure screenshot grounding as last resort.
- **Act via UIA patterns, not synthetic clicks** (`Invoke`, `SetValue`, `Toggle`): DPI- and occlusion-independent; fall back to a click at the element's center when no pattern exists.
- **UIA-dark pro apps** (e.g. DaVinci Resolve's custom Qt widgets): vision for pointing, the app's own scripting API for doing.
- **Adoptable building blocks**: [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) (~6.7k★, MIT) and its embeddable sibling Windows-Use — strip to minimum tools rather than building from zero.
- **Highlight overlay**: layered click-through window (`WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE`), pulse and auto-dismiss; numbered-grid is the validated set-of-marks fallback — research shows mark selection beats raw coordinate emission.
- **Gotchas**: re-snapshot before highlight/click (rects go stale); Electron apps need a wake-up retry (lazy accessibility tree); unelevated Jarvis can't touch elevated windows — keep that as a safety feature.

Sources: [UFO2 paper](https://arxiv.org/abs/2504.14603) · [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) · [Set-of-Marks](https://arxiv.org/pdf/2310.11441) · [Resolve scripting API](https://deric.github.io/DaVinciResolve-API-Docs/) · [OmniParser](https://github.com/microsoft/omniparser)

## 05 · Meeting copilot (audio)

**Verdict: Native WASAPI capture + local Whisper. The Cluely clones already ran this experiment — copy the winners, avoid the losers.**

- **Capture natively, not via Electron web APIs**: Glass and cheating-daddy (browser-API loopback) share a cluster of "no audio on Windows" issues; Pluely and Natively (Rust/WASAPI) don't. MVP path in pure Python: PyAudioWPatch (loopback) + sounddevice (mic). Production: small Rust sidecar using the process-loopback API excluding Jarvis's own PID — its own sounds never enter the transcript.
- **Two channels = free diarization**: mic = "Me", loopback = "Them". Skip ML diarization entirely.
- **STT**: faster-whisper large-v3-turbo int8 (~2 GB VRAM, both streams faster than real time) on GPU laptops; small.en/base int8 or Parakeet-ONNX on CPU. RealtimeSTT provides the VAD/buffering plumbing and accepts external audio feeds.
- **Hygiene**: Silero VAD gating — never feed silence to Whisper (it hallucinates); timestamp-based silence injection; handle mid-call device switches (`AUDCLNT_E_DEVICE_INVALIDATED`); headphones or AEC against echo double-transcription.
- **Differentiator**: every clone leads with stealth; none has consent UX. A visible recording indicator and per-session deliberate switch is both the ethical and the product-safe position.

Sources: [WASAPI loopback](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording) · [Process-loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/) · [faster-whisper](https://github.com/SYSTRAN/faster-whisper) · [RealtimeSTT](https://github.com/KoljaB/RealtimeSTT) · [Pluely audio backend](https://deepwiki.com/iamsrikanthnani/pluely/5.2.3-audio-capture-backend-(rust))

## 06 · Safety model

**The core fact: prompt injection through screen and page content is unsolved.** Benchmarks hijack browser agents at up to 100% on realistic pages; "ignore instructions on the page" prompts do not work. Defenses must be architectural.

**Permission modes (per chat, Claude-Code-style):**

| Mode | Behavior |
|---|---|
| **Manual approve** (default) | Every action shows a dialog: what will be done, where, with what data |
| Auto | Classifier-vetted actions run; risky ones still prompt |
| Accept edits | Auto-approves file edits only |
| Read-only | Can look and answer; action tools not even registered |

**Structural guardrails (active in every mode):**

- **Capture hygiene**: capture auto-pauses on password fields, credential UIs, and denylisted apps/sites; screenshots stay ephemeral (the Microsoft Recall lesson: structural exclusion, not detect-and-redact).
- **Scoped web actions**: form filling only on origins the user granted via `optional_host_permissions` — browser-enforced, the model can't override it. Credentials and payment fields are never filled; capture pauses and the user takes over (the Operator pattern).
- **Native actuation = watch mode**: visible indicator, kill hotkey, per-action streaming. Process always unelevated — UAC prompts stay physically unreachable.
- **Reader/actor separation**: the turn that reads untrusted screen content has no action tools; extracted content passes forward as quoted data, never instructions. Plans derive from the user's words before the page is read.
- **Escalation is a user act**: permission-mode changes only through the Jarvis UI, never through chat.
- **Context-folder hygiene**: user context folders are read-only to the agent and should contain no credentials; agent-written memory is reviewable (memory poisoning is a documented attack).
- **Circuit breaker**: repeated blocked actions drop the session to fully manual.

Sources: [VPI-Bench](https://arxiv.org/abs/2506.02456) · [Claude Code auto-mode design](https://www.anthropic.com/engineering/claude-code-auto-mode) · [CaMeL](https://arxiv.org/abs/2503.18813) · [The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) · [Operator system card](https://openai.com/index/operator-system-card/) · [OWASP agent cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)

---

## Build phases

1. **Quality of life** (in the seed app while the real codebase starts) — Claude 5 model picker · clipboard/text attach (cheaper than screenshots) · context-folder wiring
2. **Multi-chat supervisor** — session-per-chat with warm pool · sidebar from `list_sessions()` · per-chat profiles — built shell-agnostic so it survives the Tauri move
3. **Chrome extension for job forms** — native messaging bridge · per-ATS adapters (Greenhouse, Lever, Workday) · approval side panel
4. **Tauri shell migration** — Rust shell + WebView UI + Python sidecar · port the proven Win32 techniques · installer + signed auto-update · per-state orb transparency
5. **"Show me where" + native-app control** — UIA snapshot tools · highlight overlay · set-of-marks fallback · watch mode
6. **Meeting copilot** — WASAPI two-channel capture · local Whisper via RealtimeSTT · rolling transcript context · consent indicator

---

*Synthesized 2026-08 from six parallel research reports (architecture · SDK sessions · form filling · UIA · audio · safety). Jarvis is seeded by [claude-overlay](https://github.com/shengyanlin/claude-overlay) (MIT) by shengyanlin.*
