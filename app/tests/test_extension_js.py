# -*- coding: utf-8 -*-
"""Run the extension's JavaScript tests as part of the normal suite.

content.js is the piece that touches real job applications, and it had no versioned
coverage at all — every regression in it was found by the user, on a live form, after
a wrong value had already been typed. These run under Node with jsdom and skip
cleanly where neither is installed, so the Python suite stays runnable anywhere.
"""

import json
import os
import shutil
import subprocess

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
EXT_TESTS = os.path.normpath(os.path.join(HERE, "..", "..", "extension", "tests"))


def _js_tests():
    if not os.path.isdir(EXT_TESTS):
        return []
    return sorted(f for f in os.listdir(EXT_TESTS) if f.endswith(".test.js"))


def _jsdom_root():
    """Where jsdom is installed. It is a dev-only dependency and deliberately NOT
    vendored into the repo, so look in the usual places and skip if it's absent."""
    candidates = [EXT_TESTS, os.path.normpath(os.path.join(EXT_TESTS, "..", "..")),
                  os.environ.get("JARVIS_JS_MODULES", "")]
    for base in candidates:
        if base and os.path.isdir(os.path.join(base, "node_modules", "jsdom")):
            return base
    return None


@pytest.mark.parametrize("name", _js_tests() or ["<none>"])
def test_extension_javascript(name):
    if name == "<none>":
        pytest.skip("no extension JS tests present")
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    root = _jsdom_root()
    if not root:
        pytest.skip("jsdom is not installed (npm i -D jsdom in extension/tests)")

    env = dict(os.environ)
    # let Node resolve jsdom from wherever it actually lives
    env["NODE_PATH"] = os.path.join(root, "node_modules")
    proc = subprocess.run([node, os.path.join(EXT_TESTS, name)],
                          capture_output=True, text=True, env=env, timeout=120)
    out = (proc.stdout or "") + (proc.stderr or "")
    assert proc.returncode == 0, f"{name} failed:\n{out}"
    assert "RESULT: OK" in out, f"{name} did not report success:\n{out}"
