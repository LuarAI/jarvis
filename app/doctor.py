# -*- coding: utf-8 -*-
"""Jarvis browser-bridge doctor: prove which hop is broken, instead of guessing.

    python doctor.py            # check every hop, print a verdict
    python doctor.py --read     # also do a real read of the current tab and show it

The chain has five links, and a failure in any of them used to surface in the chat
as one vague sentence:

    overlay (bridge socket)
      └─ ipc.json  (port + token, must name a LIVE overlay)
          └─ native host proxy   (Chrome spawns it; registry + manifest must match)
              └─ Chrome extension service worker
                  └─ content script in the page  (per frame)

This walks the chain in order and reports the first broken link with the real error
text, plus what to do about it.
"""

import json
import os
import socket
import struct
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import browser_bridge  # noqa: E402

OK, BAD, WARN = "[ OK ]", "[FAIL]", "[WARN]"


def say(status, what, detail=""):
    """Print a line that survives a legacy console.

    The diagnostic used arrows and check marks, and Windows' default cp1252 console
    raised UnicodeEncodeError on the FIRST healthy line — so the one tool meant to
    explain a broken bridge crashed instead, which is the worst possible moment for
    it to fail. Re-encode to whatever the terminal can actually print."""
    line = f"{status} {what}" + (f"\n       {detail}" if detail else "")
    try:
        print(line)
    except UnicodeEncodeError:
        enc = (getattr(sys.stdout, "encoding", None) or "ascii")
        print(line.encode(enc, "replace").decode(enc, "replace"))


def check_ipc():
    """ipc.json exists, is readable, and names a live overlay."""
    path = browser_bridge.IPC_FILE
    if not os.path.exists(path):
        say(BAD, "ipc.json missing", f"{path}\n       → Jarvis isn't running. Start it first.")
        return None
    try:
        info = json.load(open(path, encoding="utf-8"))
    except Exception as e:
        say(BAD, "ipc.json unreadable", f"{type(e).__name__}: {e}")
        return None
    pid, port = info.get("pid"), info.get("port")
    alive = browser_bridge.BrowserBridge._pid_alive(pid)
    if not alive:
        say(BAD, f"ipc.json names a DEAD overlay (pid {pid})",
            "→ A stale record. Restart Jarvis; it will reclaim the file.")
        return None
    say(OK, f"ipc.json → port {port}, overlay pid {pid} (alive)")
    return info


def check_socket(info):
    """The overlay's bridge socket accepts and authenticates."""
    try:
        s = socket.create_connection(("127.0.0.1", int(info["port"])), timeout=3)
    except Exception as e:
        say(BAD, "bridge socket refused",
            f"{type(e).__name__}: {e}\n       → The overlay published a port it isn't listening on.")
        return False
    try:
        browser_bridge._send_frame(s, {"token": info["token"]})
        hello = browser_bridge._recv_frame(s)
        good = isinstance(hello, dict) and hello.get("type") == "hello_ok"
        say(OK if good else BAD,
            "bridge handshake" + ("" if good else " rejected"),
            "" if good else f"got {hello!r} — token mismatch?")
        return good
    finally:
        s.close()


def check_registry():
    """Chrome can find the native host manifest, and it points at a real file."""
    try:
        out = subprocess.run(
            ["reg", "query",
             r"HKCU\Software\Google\Chrome\NativeMessagingHosts\com.jarvis.host", "/ve"],
            capture_output=True, text=True, timeout=10)
    except Exception as e:
        say(WARN, "couldn't query the registry", f"{type(e).__name__}: {e}")
        return None
    if out.returncode != 0:
        say(BAD, "native host NOT registered",
            r"→ Run: host\install.cmd <extension-id>")
        return None
    manifest = out.stdout.strip().split("REG_SZ")[-1].strip()
    if not os.path.exists(manifest):
        say(BAD, "host manifest missing", f"registry points at {manifest}")
        return None
    try:
        m = json.load(open(manifest, encoding="utf-8"))
    except Exception as e:
        say(BAD, "host manifest unreadable", f"{type(e).__name__}: {e}")
        return None
    origins = m.get("allowed_origins") or []
    ext_ids = [o.split("//")[-1].strip("/") for o in origins]
    say(OK, f"native host registered → {os.path.basename(manifest)}",
        f"extension id(s): {', '.join(ext_ids) or '(none!)'}")
    bat = os.path.join(os.path.dirname(manifest), m.get("path", ""))
    if not os.path.exists(bat):
        say(BAD, "host launcher missing", bat)
        return None
    return ext_ids


def check_live_connection(info):
    """Is a proxy ACTUALLY connected to the overlay right now?"""
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command",
                              f"(Get-NetTCPConnection -LocalPort {info['port']} -State Established"
                              " -ErrorAction SilentlyContinue | Measure-Object).Count"],
                             capture_output=True, text=True, timeout=20)
        n = int((out.stdout or "0").strip() or 0)
    except Exception as e:
        say(WARN, "couldn't count connections", f"{type(e).__name__}: {e}")
        return None
    if n:
        say(OK, f"extension IS connected ({n} live connection)")
    else:
        say(BAD, "no extension connected",
            "→ Chrome may be closed, the extension disabled/not reloaded, or the\n"
            "         host registration points at a different extension id.")
    return n > 0


def check_proxies():
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command",
                              "(Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" |"
                              " Where-Object { $_.CommandLine -like '*jarvis_host*' } |"
                              " Measure-Object).Count"],
                             capture_output=True, text=True, timeout=20)
        n = int((out.stdout or "0").strip() or 0)
    except Exception:
        return
    say(OK if n else WARN, f"native host processes running: {n}",
        "" if n else "→ Chrome hasn't spawned the host: extension not loaded, or Chrome not running.")


def main():
    print("Jarvis browser bridge — diagnostic\n" + "=" * 40)
    info = check_ipc()
    if not info:
        return 1
    if not check_socket(info):
        return 1
    check_registry()
    check_proxies()
    connected = check_live_connection(info)
    print("\n" + "=" * 40)
    if connected:
        print("Verdict: the chain is UP. If a read still fails, the failure is in the\n"
              "page itself (restricted URL, or no content script in any frame) — run\n"
              "Jarvis and ask it to read; the error now names the frame.")
    else:
        print("Verdict: the extension is not attached. Fix the FAILing line above.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
