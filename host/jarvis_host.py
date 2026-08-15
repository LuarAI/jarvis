# -*- coding: utf-8 -*-
"""Jarvis native-messaging proxy.

Chrome spawns THIS per connection and kills it when the port closes — it cannot
talk to the long-running overlay directly. So this process is a dumb byte pump
between Chrome's stdio protocol and the overlay's loopback socket, exactly the
shape KeePassXC uses (keepassxc-proxy) for the same reason: the browser must never
own the app's lifetime.

Nothing but framed JSON may ever reach stdout — diagnostics go to stderr, which
Chrome captures into its own log.
"""

import json
import os
import struct
import socket
import sys
import threading
import time

IPC_FILE = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")),
                        "Jarvis", "ipc.json")


def _binary_stdio():
    """Windows opens stdio in text mode, which rewrites \\n to \\r\\n and corrupts
    the length-prefixed framing. Force binary."""
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)


def log(*a):
    print("[jarvis_host]", *a, file=sys.stderr, flush=True)


# ── Chrome stdio framing (uint32 native-order length + UTF-8 JSON) ──
def read_chrome():
    head = sys.stdin.buffer.read(4)
    if len(head) < 4:
        return None
    (n,) = struct.unpack("=I", head)
    body = sys.stdin.buffer.read(n)
    if len(body) < n:
        return None
    return json.loads(body.decode("utf-8"))


def write_chrome(obj):
    data = json.dumps(obj).encode("utf-8")
    # Chrome hard-fails a host→browser message over 1 MB; truncate defensively so a
    # huge page dump degrades into a usable message instead of killing the port.
    if len(data) > 1024 * 1024:
        obj = {"id": obj.get("id"), "ok": False,
               "error": "reply too large for the native messaging channel"}
        data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)) + data)
    sys.stdout.buffer.flush()


# ── overlay socket framing (same shape) ──
def send_app(sock, obj):
    data = json.dumps(obj).encode("utf-8")
    sock.sendall(struct.pack("=I", len(data)) + data)


def recv_exactly(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def recv_app(sock):
    head = recv_exactly(sock, 4)
    if not head:
        return None
    (n,) = struct.unpack("=I", head)
    body = recv_exactly(sock, n)
    return json.loads(body.decode("utf-8")) if body else None


def connect_overlay():
    """Connect + authenticate to the running overlay. Returns the socket or None
    (the overlay isn't running / the token file is stale)."""
    try:
        with open(IPC_FILE, "r", encoding="utf-8") as f:
            info = json.load(f)
        sock = socket.create_connection(("127.0.0.1", int(info["port"])), timeout=5)
        send_app(sock, {"token": info["token"]})
        hello = recv_app(sock)
        if not (isinstance(hello, dict) and hello.get("type") == "hello_ok"):
            sock.close()
            return None
        sock.settimeout(None)
        return sock
    except Exception as e:
        log("connect failed:", type(e).__name__, e)
        return None


def connect_overlay_retrying(stop, tries=20, delay=1.0):
    """Keep trying to reach the overlay. Chrome starts this proxy as soon as the
    browser launches, which is routinely BEFORE Jarvis is running (or while it is
    restarting) — giving up on the first refusal left a live extension permanently
    unable to reach a perfectly healthy overlay."""
    for _ in range(tries):
        if stop.is_set():
            return None
        s = connect_overlay()
        if s is not None:
            return s
        time.sleep(delay)
    return None


def main():
    _binary_stdio()
    stop = threading.Event()
    sock = connect_overlay_retrying(stop, tries=3, delay=0.5)

    # Guarded by this so the reader thread and the Chrome loop agree on the socket
    # when the overlay restarts underneath us.
    state = {"sock": sock}
    lock = threading.Lock()

    def pump_app_to_chrome(s):
        """Overlay → Chrome (requests like read_page/fill_fields, plus replies).
        When the overlay goes away we do NOT kill the proxy: Chrome would have to
        respawn it, and until it did the extension looked dead. We just drop the
        socket and let the reconnector pick the overlay back up."""
        try:
            while not stop.is_set():
                msg = recv_app(s)
                if msg is None:
                    break
                write_chrome(msg)
        except Exception as e:
            log("app pump ended:", type(e).__name__, e)
        finally:
            with lock:
                if state["sock"] is s:
                    state["sock"] = None
            try:
                s.close()
            except Exception:
                pass

    def reconnector():
        """Re-attach to the overlay after it restarts (new port every launch)."""
        while not stop.is_set():
            time.sleep(1.5)
            with lock:
                have = state["sock"] is not None
            if have:
                continue
            s = connect_overlay()
            if s is not None:
                with lock:
                    state["sock"] = s
                threading.Thread(target=pump_app_to_chrome, args=(s,), daemon=True).start()
                log("reconnected to the overlay")

    if sock is not None:
        threading.Thread(target=pump_app_to_chrome, args=(sock,), daemon=True).start()
    threading.Thread(target=reconnector, daemon=True).start()

    # Chrome → overlay (replies from the extension, and its hello)
    while not stop.is_set():
        msg = read_chrome()
        if msg is None:
            break
        with lock:
            s = state["sock"]
        if s is None:                          # overlay wasn't up (or restarted)
            s = connect_overlay_retrying(stop, tries=3, delay=0.4)
            if s is not None:
                with lock:
                    state["sock"] = s
                threading.Thread(target=pump_app_to_chrome, args=(s,), daemon=True).start()
            else:
                if msg.get("id") is not None:
                    write_chrome({"id": msg["id"], "ok": False,
                                  "error": "Jarvis isn't running (or is still starting)."})
                continue
        try:
            send_app(s, msg)
        except Exception as e:
            log("send to app failed:", type(e).__name__, e)
            with lock:
                if state["sock"] is s:
                    state["sock"] = None
            try:
                s.close()
            except Exception:
                pass
    stop.set()


if __name__ == "__main__":
    main()
