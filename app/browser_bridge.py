# -*- coding: utf-8 -*-
"""Jarvis browser bridge: the overlay's end of the Chrome-extension link.

Chrome owns the lifetime of a native-messaging host — it spawns one per port and
kills it when the port closes — so it can never talk to this long-running overlay
directly. The proven shape (KeePassXC, 1Password) is a thin PROXY: Chrome spawns
`host/jarvis_host.py`, which pumps stdio frames to an IPC endpoint the running app
owns. This module is that endpoint.

    extension → service worker → native host proxy → [this] → Tk overlay

Transport: loopback TCP on an ephemeral port + a 256-bit token, both published to
%LOCALAPPDATA%\\Jarvis\\ipc.json (user-profile ACL). Loopback binds raise no firewall
prompt and need no third-party deps; the token stops any other local process from
driving the browser through us. Frames are the same uint32-length + UTF-8 JSON the
native-messaging protocol uses, so the proxy stays a dumb byte pump.

Threading: the socket server runs on a daemon thread. Requests FROM the browser are
handed to the Tk thread through a queue; requests TO the browser (read the page, fill
these fields) are futures the Tk side awaits with a timeout — never blocking the UI,
because the SDK tool that calls them runs on the worker thread.
"""

import json
import os
import queue
import secrets
import socket
import struct
import threading
import time

IPC_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "Jarvis")
IPC_FILE = os.path.join(IPC_DIR, "ipc.json")

# One browser request should never hang a turn: the SDK tool waits this long for the
# extension to answer, then reports a clean error the model can explain to the user.
REQUEST_TIMEOUT = 20.0
MAX_FRAME = 64 * 1024 * 1024      # extension→host may legitimately be large (page dumps)


def _send_frame(sock, obj):
    data = json.dumps(obj).encode("utf-8")
    sock.sendall(struct.pack("=I", len(data)) + data)


def _recv_exactly(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def _recv_frame(sock):
    head = _recv_exactly(sock, 4)
    if not head:
        return None
    (length,) = struct.unpack("=I", head)
    if length <= 0 or length > MAX_FRAME:
        return None
    body = _recv_exactly(sock, length)
    if body is None:
        return None
    return json.loads(body.decode("utf-8"))


class _Reply:
    """A one-shot slot: the socket thread fills it, the caller waits on it."""

    def __init__(self):
        self._ev = threading.Event()
        self.value = None

    def set(self, value):
        self.value = value
        self._ev.set()

    def wait(self, timeout):
        return self._ev.wait(timeout)


class BrowserBridge:
    """Owns the listening socket, the connected proxy (at most one), and the
    request/response correlation. Everything here is thread-safe; nothing here
    touches Tk."""

    def __init__(self, on_event=None):
        self.token = secrets.token_hex(32)
        self.port = None
        self._sock = None
        self._conn = None            # the connected proxy, or None
        self._conn_lock = threading.Lock()
        self._pending = {}           # request id → (Event, [result])
        self._pending_lock = threading.Lock()
        self._seq = 0
        self._running = False
        self._on_event = on_event    # called (kind, payload) for unsolicited messages
        self.last_error = None

    # ── lifecycle ──
    def start(self):
        """Bind, publish ipc.json, and accept proxy connections on a daemon thread.
        Best-effort: a bridge that can't start must never stop the overlay."""
        try:
            self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self._sock.bind(("127.0.0.1", 0))
            self._sock.listen(4)
            self.port = self._sock.getsockname()[1]
            self.owns_publication = self._guard_publication()
            self._running = True
            threading.Thread(target=self._accept_loop, daemon=True).start()
            threading.Thread(target=self._watch_publication, daemon=True).start()
            return True
        except Exception as e:
            self.last_error = f"{type(e).__name__}: {e}"
            return False

    def _publish(self):
        os.makedirs(IPC_DIR, exist_ok=True)
        tmp = IPC_FILE + ".%d.tmp" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"port": self.port, "token": self.token, "pid": os.getpid()}, f)
        os.replace(tmp, IPC_FILE)

    @staticmethod
    def _published_pid():
        """The pid currently advertised in ipc.json, or None."""
        try:
            with open(IPC_FILE, "r", encoding="utf-8") as f:
                return json.load(f).get("pid")
        except Exception:
            return None

    @staticmethod
    def _pid_alive(pid):
        if not isinstance(pid, int) or pid <= 0:
            return False
        if pid == os.getpid():
            return True
        try:                            # Windows: OpenProcess via ctypes, no psutil dep
            import ctypes
            h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED
            if not h:
                return False
            ctypes.windll.kernel32.CloseHandle(h)
            return True
        except Exception:
            try:
                os.kill(pid, 0)
                return True
            except Exception:
                return False

    def _guard_publication(self):
        """Keep ipc.json pointing at THIS overlay while we're the only live one.

        Two overlays used to fight over the file: whichever started last won, and
        when it exited the proxies were left dialling a dead port forever — the
        "extension isn't connected" that no console showed, because nothing was
        wrong in the browser at all. Now: we refuse to steal the file from a LIVE
        overlay at startup, and we re-publish if a dead one's record replaced ours."""
        pid = self._published_pid()
        if pid == os.getpid():
            return True
        if self._pid_alive(pid):
            return False                # another overlay owns the bridge; leave it be
        self._publish()                 # stale record (crashed/exited) → reclaim
        return True

    def _watch_publication(self):
        """Re-check every few seconds: if the overlay that owned ipc.json exited (or
        never existed), take over so the extension can find us. Cheap — one small
        read plus, rarely, an OpenProcess."""
        while self._running:
            time.sleep(5.0)
            try:
                if not self.connected:
                    self.owns_publication = self._guard_publication()
            except Exception:
                pass

    def stop(self):
        self._running = False
        with self._conn_lock:
            conn, self._conn = self._conn, None
        for s in (conn, self._sock):
            try:
                if s is not None:
                    s.close()
            except Exception:
                pass
        try:
            # Remove the pointer only if it's OURS — deleting another live overlay's
            # record would cut its browser link when this instance happens to exit.
            if self._published_pid() == os.getpid():
                os.remove(IPC_FILE)
        except Exception:
            pass

    @property
    def connected(self):
        with self._conn_lock:
            return self._conn is not None

    # ── socket side ──
    def _accept_loop(self):
        while self._running:
            try:
                conn, _addr = self._sock.accept()
            except Exception:
                if self._running:
                    time.sleep(0.2)
                continue
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn):
        """One proxy connection: authenticate, then pump frames until it closes."""
        try:
            hello = _recv_frame(conn)
            if not (isinstance(hello, dict) and hello.get("token") == self.token):
                conn.close()         # anything unauthenticated is dropped silently
                return
            _send_frame(conn, {"type": "hello_ok"})
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            return
        with self._conn_lock:
            old, self._conn = self._conn, conn
        if old is not None:
            try:
                old.close()          # newest browser session wins
            except Exception:
                pass
        if self._on_event:
            self._on_event("browser_connected", None)
        try:
            while self._running:
                msg = _recv_frame(conn)
                if msg is None:
                    break
                self._dispatch(msg)
        except Exception:
            pass
        finally:
            with self._conn_lock:
                if self._conn is conn:
                    self._conn = None
            try:
                conn.close()
            except Exception:
                pass
            self._fail_pending("The browser extension disconnected.")
            if self._on_event:
                self._on_event("browser_disconnected", None)

    def _dispatch(self, msg):
        rid = msg.get("id")
        if rid is not None:                      # a reply to something we asked
            with self._pending_lock:
                slot = self._pending.pop(rid, None)
            if slot is not None:
                slot.set(msg)
            return
        if self._on_event:                       # unsolicited (page changed, etc.)
            self._on_event("browser_event", msg)

    def _fail_pending(self, reason):
        with self._pending_lock:
            pending, self._pending = self._pending, {}
        for slot in pending.values():
            slot.set({"error": reason})

    # ── request/response (called from the worker thread by the SDK tools) ──
    def request(self, action, params=None, timeout=REQUEST_TIMEOUT):
        """Ask the extension to do something and wait for its reply. Returns the
        reply dict, or {"error": ...} — never raises, so a tool call degrades into a
        message the model can relay instead of killing the turn."""
        with self._conn_lock:
            conn = self._conn
        if conn is None:
            return {"error": "Chrome extension isn't connected. Open Chrome with the "
                             "Jarvis extension installed and loaded."}
        with self._pending_lock:
            self._seq += 1
            rid = self._seq
            slot = _Reply()
            self._pending[rid] = slot
        try:
            _send_frame(conn, {"id": rid, "action": action, "params": params or {}})
        except Exception as e:
            with self._pending_lock:
                self._pending.pop(rid, None)
            return {"error": f"Couldn't reach the browser: {type(e).__name__}: {e}"}
        if not slot.wait(timeout):
            with self._pending_lock:
                self._pending.pop(rid, None)
            return {"error": f"The browser didn't answer within {timeout:.0f}s."}
        return slot.value if isinstance(slot.value, dict) else {"error": "malformed reply"}
