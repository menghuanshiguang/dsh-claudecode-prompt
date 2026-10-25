#!/usr/bin/env python3
"""Capture the real Claude Code system prompt by running the real binary against a
local mock Anthropic API.

Why not just grep the binary: `claude.exe` is a ~296 MB Bun single-file bundle. The
prompt text is there, but split into string-table fragments with the formatting
in between, and reassembling it by hand is guesswork. Running the binary and
reading the request it sends is authoritative, and it also captures the *shape*
(system[] blocks, tool schemas, dynamic tails).

Usage
-----
    python tools/capture_cc_prompt.py                # claude -p / SDK entrypoint
    CAPTURE_MODE=vscode python tools/capture_cc_prompt.py   # VSCode extension entrypoint

Environment
-----------
    CAPTURE_MODE   "print" (default) or "vscode"
                   print  : claude.exe -p hi --output-format stream-json --verbose
                   vscode : claude.exe --output-format stream-json --verbose
                            --input-format stream-json, first turn fed on stdin,
                            with CLAUDE_CODE_ENTRYPOINT=claude-vscode — the exact
                            args/env the VSCode extension spawns.
    CLAUDE_CODE_BIN  path to claude.exe / claude (default: auto-discover)
    CAPTURE_DIR      output directory (default: ./captures next to this script)

Output
------
    captures/<n>-<path-slug>.json   one file per HTTP request the client made
    a summary on stdout: system[] block sizes, tool names, model.

Notes
-----
* The mock answers every /v1/messages with a canned SSE stream and every
  /v1/messages/count_tokens with a fixed count, so the run terminates on its own.
* CLAUDE_CONFIG_DIR is pointed inside the repo so the run cannot touch your real
  ~/.claude config, and telemetry/autoupdate are disabled.
* Captured bodies contain machine-specific absolute paths (e.g. the memory
  directory) — everything under captures/ is gitignored for that reason.
"""
import json
import os
import re
import socket
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
CAP = Path(os.environ.get("CAPTURE_DIR") or HERE / "captures")
CAP.mkdir(parents=True, exist_ok=True)

# --- locate the Claude Code native binary -------------------------------------

def find_cc_bin() -> Path:
    override = os.environ.get("CLAUDE_CODE_BIN")
    if override:
        return Path(override)
    home = Path.home()
    roots = [
        home / ".vscode" / "extensions",
        home / ".vscode-insiders" / "extensions",
        home / ".cursor" / "extensions",
        home / ".windsurf" / "extensions",
    ]
    for root in roots:
        if not root.is_dir():
            continue
        for ext in sorted(root.glob("anthropic.claude-code-*"), reverse=True):
            for name in ("claude.exe", "claude"):
                candidate = ext / "resources" / "native-binary" / name
                if candidate.is_file():
                    return candidate
    sys.exit(
        "cannot find the Claude Code binary — set CLAUDE_CODE_BIN to the "
        "resources/native-binary/claude(.exe) path inside your VSCode extension"
    )


CC_EXE = find_cc_bin()

counter = {"n": 0}
seen: list[str] = []

# --- mock Anthropic API -------------------------------------------------------


def free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def sse(payload_text: str, model: str) -> bytes:
    events = [
        ("message_start", {
            "type": "message_start",
            "message": {
                "id": "msg_mock_1", "type": "message", "role": "assistant",
                "model": model, "content": [], "stop_reason": None, "stop_sequence": None,
                "usage": {"input_tokens": 10, "output_tokens": 1},
            },
        }),
        ("content_block_start", {
            "type": "content_block_start", "index": 0,
            "content_block": {"type": "text", "text": ""},
        }),
        ("content_block_delta", {
            "type": "content_block_delta", "index": 0,
            "delta": {"type": "text_delta", "text": payload_text},
        }),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ("message_delta", {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": 1},
        }),
        ("message_stop", {"type": "message_stop"}),
    ]
    return "".join(
        f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events
    ).encode()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # keep stdout readable
        pass

    def _body(self) -> bytes:
        size = int(self.headers.get("content-length") or 0)
        return self.rfile.read(size) if size else b""

    def _save(self, path: str, body: bytes) -> None:
        counter["n"] += 1
        # windows: "?" and friends are illegal in filenames, and the client asks
        # for /v1/messages?beta=true
        slug = re.sub(r"[^A-Za-z0-9._-]+", "_", path.strip("/")) or "root"
        name = f"{counter['n']:03d}-{slug}.json"
        target = CAP / name
        try:
            payload = json.loads(body.decode("utf-8", "replace"))
            target.write_text(
                json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8"
            )
        except Exception:
            target.write_bytes(body)
        seen.append(name)

    def _json(self, code: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = self._body()
        self._save(self.path, body)
        try:
            request = json.loads(body.decode("utf-8", "replace"))
        except Exception:
            request = {}
        model = request.get("model") or "claude-sonnet-4-5"
        if self.path.endswith("/count_tokens"):
            return self._json(200, {"input_tokens": 1234})
        if request.get("stream"):
            data = sse("mock", model)
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return self._json(200, {
            "id": "msg_mock_1", "type": "message", "role": "assistant", "model": model,
            "content": [{"type": "text", "text": "mock"}],
            "stop_reason": "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 10, "output_tokens": 1},
        })

    def do_GET(self):
        self._save(self.path, b"<GET>")
        return self._json(200, {"data": [], "has_more": False})

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("content-length", "0")
        self.end_headers()


class QuietServer(ThreadingHTTPServer):
    """The client hangs up as soon as it has its answer; that is not an error."""

    daemon_threads = True

    def handle_error(self, request, client_address):
        pass


# --- run ----------------------------------------------------------------------


def summarize() -> None:
    """Print what the captures actually contain (system blocks, tools, model)."""
    for name in seen:
        path = CAP / name
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(payload, dict) or "system" not in payload:
            continue
        print(f"\n=== {name} ===")
        print("model:", payload.get("model"))
        system = payload.get("system")
        blocks = system if isinstance(system, list) else [system]
        for index, block in enumerate(blocks):
            text = block if isinstance(block, str) else (block or {}).get("text", "")
            first = text.strip().splitlines()[0][:70] if text.strip() else ""
            print(f"  system[{index}] {len(text):>7} chars  {first}")
        tools = payload.get("tools") or []
        names = [tool.get("name") for tool in tools if isinstance(tool, dict)]
        print(f"  tools[{len(names)}]: {', '.join(str(n) for n in names)}")
        for message in payload.get("messages") or []:
            if message.get("role") == "system":
                content = message.get("content")
                text = content if isinstance(content, str) else json.dumps(content)
                print(f"  + role=system message: {len(text)} chars")


def main() -> None:
    port = free_port()
    server = QuietServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"

    config_dir = HERE / ".cc-cfg"
    config_dir.mkdir(exist_ok=True)
    fake_key = "sk-ant-api03-" + "x" * 60
    env = dict(os.environ)
    env.update({
        "ANTHROPIC_BASE_URL": base,
        "ANTHROPIC_API_KEY": fake_key,
        "ANTHROPIC_AUTH_TOKEN": fake_key,
        "CLAUDE_CONFIG_DIR": str(config_dir),
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_TELEMETRY": "1",
        "DISABLE_ERROR_REPORTING": "1",
        "DISABLE_AUTOUPDATER": "1",
        "CLAUDE_CODE_ENTRYPOINT": "cli",
        "TERM": "xterm-256color",
    })
    for key in ("ANTHROPIC_MODEL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
                "AWS_ACCESS_KEY_ID", "GOOGLE_APPLICATION_CREDENTIALS",
                "CLAUDE_CODE_OAUTH_TOKEN"):
        env.pop(key, None)

    mode = os.environ.get("CAPTURE_MODE", "print").lower()
    extra = sys.argv[1:]
    if mode == "vscode":
        args = [str(CC_EXE), "--output-format", "stream-json", "--verbose",
                "--input-format", "stream-json"] + extra
        stdin_data = json.dumps({
            "type": "user",
            "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]},
        }) + "\n"
        env["CLAUDE_CODE_ENTRYPOINT"] = "claude-vscode"
    else:
        args = [str(CC_EXE), "-p", "hi", "--output-format", "stream-json", "--verbose",
                "--model", "claude-sonnet-4-5-20250929"] + extra
        stdin_data = None

    print("[binary]", CC_EXE)
    print("[mode]", mode)
    print("[run]", " ".join(args))
    process = subprocess.Popen(
        args, env=env,
        stdin=subprocess.PIPE if stdin_data else subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=str(HERE), text=True, encoding="utf-8", errors="replace",
    )
    try:
        out, err = process.communicate(input=stdin_data, timeout=180)
    except subprocess.TimeoutExpired:
        process.kill()
        out, err = process.communicate()
        print("[warn] timeout — killing the client")
    server.shutdown()
    print("[exit]", process.returncode)
    print("[stdout]\n" + (out or "")[:3000])
    print("[stderr]\n" + (err or "")[:3000])
    print("[captured]", len(seen), "requests ->", CAP)
    for name in seen:
        print("  ", name, (CAP / name).stat().st_size, "bytes")
    summarize()


if __name__ == "__main__":
    main()
