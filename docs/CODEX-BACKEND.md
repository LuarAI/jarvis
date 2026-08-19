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
