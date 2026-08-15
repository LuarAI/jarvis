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


def main():
    _binary_stdio()
    sock = connect_overlay()
    stop = threading.Event()

    def pump_app_to_chrome(s):
        """Overlay → Chrome (requests like read_page/fill_fields, plus replies)."""
        try:
            while not stop.is_set():
                msg = recv_app(s)
                if msg is None:
                    break
                write_chrome(msg)
        except Exception as e:
            log("app pump ended:", type(e).__name__, e)
        finally:
            stop.set()

    if sock is not None:
        threading.Thread(target=pump_app_to_chrome, args=(sock,), daemon=True).start()

    # Chrome → overlay (replies from the extension, and its hello)
    while not stop.is_set():
        msg = read_chrome()
        if msg is None:
            break
        if sock is None:                       # overlay wasn't up when we started
            sock = connect_overlay()
            if sock is not None:
                threading.Thread(target=pump_app_to_chrome, args=(sock,), daemon=True).start()
            else:
                if msg.get("id") is not None:
                    write_chrome({"id": msg["id"], "ok": False,
                                  "error": "Jarvis isn't running."})
                continue
        try:
            send_app(sock, msg)
        except Exception as e:
            log("send to app failed:", type(e).__name__, e)
            try:
                sock.close()
            except Exception:
                pass
            sock = None
    stop.set()


if __name__ == "__main__":
    main()
