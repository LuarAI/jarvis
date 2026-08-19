# Codex as a second backend — feasibility notes

Verified on 2026-08-19 against `codex-cli 0.148.0` on this machine. Everything below
was run, not read: the schema was generated from the installed binary and the
handshake was performed against a live `codex app-server`.

## The short version

It is feasible. `codex app-server` is a bidirectional JSON-RPC 2.0 service with
streaming deltas, per-thread sessions, mid-turn interrupts and **server-initiated
approval requests** — the same shape Jarvis already needs from the Claude Agent SDK.
It authenticates off the existing ChatGPT login; no API key.

An earlier assessment in this project said Codex could not support the approval card.
That was wrong, and worth recording as wrong: it was based on `codex exec`, which is
one-shot by design. `exec` is not the integration surface — `app-server` is.

## What was verified

    codex --version          -> codex-cli 0.148.0
    codex login status       -> "Logged in using ChatGPT"   (no API key)
    codex exec "..."         -> real round trip, 4,122 tokens
    codex app-server         -> accepted a JSON-RPC `initialize`, replied with a
                                result, and pushed an unsolicited server
                                notification (remoteControl/status/changed)

The handshake reply names `codexHome` (`~/.codex`) and the platform, so the server is
fully initialised rather than merely started.

## Protocol source of truth

Do NOT rely on blog posts for this. The binary emits its own schema:

    codex app-server generate-json-schema --out <DIR>
    codex app-server generate-ts          --out <DIR>   # TypeScript bindings

That produced 249 files for protocol v2. The relevant ones:

| Jarvis needs                | Codex app-server                                    |
|-----------------------------|-----------------------------------------------------|
| streaming answer text       | `AgentMessageDeltaNotification`                      |
| per-chat sessions           | `thread/start`, `thread/resume`, `thread/fork`       |
| conversation list           | `thread/list`, `ThreadArchive*`, `ThreadDelete*`     |
| interrupt a running turn    | `turn/interrupt`                                     |
| steer mid-turn              | `turn/steer`                                         |
| the approval card           | `CommandExecutionRequestApprovalParams` and friends  |
| system prompt               | `thread/start` -> `baseInstructions`                 |
| permission mode             | `approvalPolicy` (on both thread/start and turn/start)|
| model picker                | `model` param + `model/list`                         |
| context/token accounting    | `AccountRateLimitsUpdatedNotification`               |

`TurnStartParams` carries: approvalPolicy, approvalsReviewer, clientUserMessageId,
cwd, effort, input, model, outputSchema, personality, sandboxPolicy, serviceTier,
summary, threadId.

## What it would actually cost

The protocol matches; the work is in the plumbing.

1. **No Python client exists.** It is raw JSON-RPC over stdio (or `--listen ws://`).
   Jarvis would need a hand-written client. This is not exotic — `browser_bridge.py`
   already does length-prefixed JSON over a socket with a request/response map — but
   it is a real module, not a config switch.

2. **`worker.py` assumes the Agent SDK.** `ClaudeSDKClient`, `can_use_tool`,
   `get_session_messages`, the in-process MCP server. A second backend means an
   interface both can satisfy, and the seams are the approval callback and session
   resume.

3. **The browser tools are an in-process MCP server.** Codex speaks MCP too
   (`codex mcp`), but Jarvis's server is in-process via the SDK; for Codex it would
   have to be exposed as a real MCP server the app-server connects to. That is the
   least obvious piece of work and the one most likely to be underestimated.

4. **`app-server` is marked experimental.** The protocol can move between releases.
   The generated schema is the defence: regenerate it after a Codex update and diff.

## Suggested first slice, if pursued

A read-only spike, no UI changes: a small `codex_client.py` that starts the
app-server, does `initialize`, `thread/start`, `turn/start`, and prints streamed
deltas to stdout. That answers "can Jarvis drive a whole turn" for a fraction of the
cost of wiring it into the overlay, and it is throwaway if the answer is no.

## Spike result (2026-08-19) — a full turn was driven end to end

`spikes/codex_turn.py` is a ~200-line client that does the whole loop. Verified:

    python spikes/codex_turn.py             -> initialize, thread, streamed answer
    python spikes/codex_turn.py --approve   -> approval asked AND answered
    python spikes/codex_turn.py --interrupt -> generation cut mid-sentence

The streamed reply to "what are you?" came back as *"I'm Jarvis, your floating
desktop AI assistant"* — so `baseInstructions` really does carry Jarvis's system
prompt, rather than being advisory.

The approval run received `item/commandExecution/requestApproval` as a
server-initiated JSON-RPC request, answered `{"decision": "accept"}`, and the turn
then completed with the command's real output. That is the same contract
`can_use_tool` provides today, so the approval card maps across directly.

### Things only running it revealed

* **The npm install ships two shims.** `shutil.which("codex")` finds the
  extensionless shell script first, and CreateProcess rejects it with "not a valid
  Win32 application". Prefer `codex.cmd` explicitly on Windows.
* **The default sandbox is `read-only`,** under which a shell command FAILS rather
  than prompting (Windows error 267). An approval test against the default never
  sees an approval at all. `sandbox: "workspace-write"` is what makes the server ask.
* **`turn/interrupt` needs `turnId`, not just `threadId`** — and `turn/start` returns
  `{"turn": {...}}`, so the id is nested, not top-level. Getting this wrong fails
  only later, at interrupt time.
* **Approval policy belongs on `thread/start`,** not only on `turn/start`.

### Still unproven

* Tool calling: Jarvis's browser tools are an in-process MCP server today. Codex
  would need them exposed as a real MCP server (`codex mcp`). Not attempted.
* Token/context accounting for the status bar
  (`account/rateLimits/updated` looks like the source, unverified).
* Behaviour across a Codex upgrade — `app-server` is experimental, so regenerate the
  schema and diff after each update.
