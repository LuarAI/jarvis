# -*- coding: utf-8 -*-
"""Throwaway spike: can Jarvis drive a whole Codex turn?

Answers one question — whether `codex app-server` can do what the Claude Agent SDK
does for Jarvis today — for a fraction of the cost of wiring it into the overlay:

    1. start the server and complete the JSON-RPC handshake
    2. open a thread, with our own system prompt (Jarvis's baseInstructions)
    3. run a turn and STREAM the answer as it is generated
    4. answer a server-initiated approval request (the approval card's contract)
    5. interrupt a running turn

Nothing here is imported by the app. If the answer turns out to be no, delete it.

Run:
    python spikes/codex_turn.py            # 1-3, the basic turn
    python spikes/codex_turn.py --approve  # 4, force an approval round trip
    python spikes/codex_turn.py --interrupt

Requires `codex` on PATH (npm i -g @openai/codex) and `codex login status` saying
you are logged in. No API key: it uses the ChatGPT session.
"""

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time

def _find_codex():
    """The Windows launcher, specifically.

    npm installs BOTH a `codex.cmd` and an extensionless `codex` shell script. Under
    Git Bash shutil.which() finds the latter first, and CreateProcess rejects it with
    "not a valid Win32 application" — so prefer the .cmd explicitly rather than
    trusting which()."""
    if os.name == "nt":
        cand = os.path.join(os.environ.get("APPDATA", ""), "npm", "codex.cmd")
        if os.path.exists(cand):
            return cand
        found = shutil.which("codex.cmd")
        if found:
            return found
    return shutil.which("codex")


CODEX = _find_codex()

# Jarvis's own framing, so the spike proves the system prompt actually lands.
BASE_INSTRUCTIONS = (
    "You are Jarvis, a floating assistant on the user's Windows desktop. "
    "Keep replies short and concrete."
)


class CodexClient:
    """A minimal JSON-RPC client for `codex app-server`.

    Deliberately small: line-delimited JSON on stdio, one reader thread, a map of
    pending request ids, and a queue of everything the server sends unprompted. That
    is the whole protocol surface — the same shape browser_bridge.py already uses for
    the extension, which is why this is a plausible thing for Jarvis to own."""

    def __init__(self, cwd=None, on_event=None):
        if not CODEX or not os.path.exists(CODEX):
            raise RuntimeError("codex not found on PATH — npm i -g @openai/codex")
        self.proc = subprocess.Popen(
            [CODEX, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1,
            cwd=cwd or os.getcwd())
        self._next_id = 0
        self._pending = {}                  # id -> queue for its reply
        self._lock = threading.Lock()
        self.events = queue.Queue()         # notifications + server-initiated requests
        self.on_event = on_event
        self.stderr_tail = []
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    # ── plumbing ────────────────────────────────────────────────────────────
    def _read_stdout(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            mid = msg.get("id")
            if mid is not None and ("result" in msg or "error" in msg):
                with self._lock:
                    q = self._pending.pop(mid, None)
                if q:
                    q.put(msg)
                continue
            # Anything else is the server talking to US: a notification, or a
            # request we are expected to answer (that is how approvals arrive).
            self.events.put(msg)
            if self.on_event:
                try:
                    self.on_event(msg)
                except Exception:
                    pass

    def _read_stderr(self):
        for line in self.proc.stderr:
            self.stderr_tail.append(line.rstrip())
            del self.stderr_tail[:-40]

    def _send(self, obj):
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def call(self, method, params=None, timeout=120):
        with self._lock:
            self._next_id += 1
            mid = self._next_id
            q = queue.Queue()
            self._pending[mid] = q
        self._send({"jsonrpc": "2.0", "id": mid, "method": method,
                    "params": params or {}})
        try:
            msg = q.get(timeout=timeout)
        except queue.Empty:
            raise TimeoutError(f"{method} timed out after {timeout}s")
        if "error" in msg:
            raise RuntimeError(f"{method} failed: {msg['error']}")
        return msg.get("result")

    def respond(self, request_id, result):
        """Answer a server-initiated request — this is the approval contract."""
        self._send({"jsonrpc": "2.0", "id": request_id, "result": result})

    def notify(self, method, params=None):
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def close(self):
        try:
            self.proc.kill()
        except Exception:
            pass


# ── the spike ───────────────────────────────────────────────────────────────

def main():
    approve = "--approve" in sys.argv
    interrupt = "--interrupt" in sys.argv
    c = CodexClient()
    ok = {}

    try:
        # 1. handshake
        init = c.call("initialize", {
            "clientInfo": {"name": "jarvis-spike", "title": "Jarvis",
                           "version": "0.1.0"}})
        print(f"[1] initialize      OK  codexHome={init.get('codexHome')}")
        ok["initialize"] = True
        c.notify("initialized")

        # 2. a thread, carrying Jarvis's own system prompt.
        #
        # The sandbox defaults to read-only, under which a shell command fails
        # OUTRIGHT rather than prompting — so an approval test against the default
        # never sees an approval at all. workspace-write is what makes the server ask.
        start = {"baseInstructions": BASE_INSTRUCTIONS,
                 "cwd": os.path.abspath(os.getcwd())}
        if approve:
            start["sandbox"] = "workspace-write"
            start["approvalPolicy"] = "untrusted"
        th = c.call("thread/start", start)
        thread_id = th.get("threadId") or th.get("thread", {}).get("id")
        print(f"[2] thread/start    OK  threadId={thread_id}")
        ok["thread"] = bool(thread_id)

        if interrupt:
            # Long enough that the interrupt lands mid-generation. A short answer
            # completes before the trigger fires and proves nothing.
            prompt = ("Write a 600-word essay about the history of the typewriter. "
                      "Start immediately, no preamble.")
        elif approve:
            # Something that needs a command, so the server has to ask permission.
            prompt = "Run the shell command `echo JARVIS_APPROVAL_TEST` and tell me its output."
        else:
            prompt = "In one sentence: what are you and who are you talking to?"

        # 3. run the turn and stream it
        params = {"threadId": thread_id,
                  "input": [{"type": "text", "text": prompt}]}
        if approve:
            params["approvalPolicy"] = "untrusted"     # force the ask
        started_turn = c.call("turn/start", params)
        # turn/interrupt needs the TURN id, not just the thread's — the server rejects
        # a thread-only call outright, which is fair: a thread can have more than one
        # turn in flight.
        # The reply is {"turn": {...}} — the id lives INSIDE that object, not at the
        # top level, which is easy to miss and fails only later at interrupt time.
        turn_obj = (started_turn or {}).get("turn") or {}
        turn_id = turn_obj.get("id") or turn_obj.get("turnId")
        print(f"[3] turn/start      OK  turnId={turn_id}  streaming…\n")

        deltas, saw_approval, answered = [], False, False
        started = time.time()
        while time.time() - started < 180:
            try:
                msg = c.events.get(timeout=1.0)
            except queue.Empty:
                continue
            method = msg.get("method", "")
            mid = msg.get("id")

            # a server-initiated REQUEST: the approval card's contract
            if mid is not None and "requestApproval" in method:
                saw_approval = True
                cmd = json.dumps(msg.get("params", {}))[:120]
                print(f"\n[4] approval asked  {method}\n    {cmd}")
                c.respond(mid, {"decision": "accept"})
                answered = True
                print("    -> answered: accept")
                continue

            if method == "item/agentMessage/delta":
                d = (msg.get("params") or {}).get("delta") or ""
                deltas.append(d)
                sys.stdout.write(d)
                sys.stdout.flush()
            elif method == "turn/completed":
                print("\n\n[3] turn/completed  OK")
                break
            elif method == "error":
                print("\n[!] server error:", json.dumps(msg.get("params"))[:300])
                break

            if interrupt and len("".join(deltas)) > 40:
                c.call("turn/interrupt", {"threadId": thread_id, "turnId": turn_id})
                print("\n\n[5] turn/interrupt  sent after 40 chars")
                ok["interrupt"] = True
                break

        text = "".join(deltas)
        ok["streamed"] = bool(text.strip())
        if approve:
            ok["approval_asked"] = saw_approval
            ok["approval_answered"] = answered

        print("\n" + "=" * 60)
        for k, v in ok.items():
            print(f"  {'PASS' if v else 'FAIL'}  {k}")
        print("=" * 60)
        if not text.strip() and c.stderr_tail:
            print("stderr tail:")
            for l in c.stderr_tail[-8:]:
                print("   ", l[:160])
        return 0 if all(ok.values()) else 1
    finally:
        c.close()


if __name__ == "__main__":
    sys.exit(main())
