from __future__ import annotations

import io
import multiprocessing as mp
import sys
import traceback

from dataclasses import dataclass
from typing import Any, Dict, List

from flask import Flask, jsonify, request

USER_FILENAME = "<user_code>"
MAX_STEPS = 2000
EXEC_TIMEOUT = 3.0

app = Flask(__name__, static_folder="static", static_url_path="")


class TraceLimitExceeded(Exception):
    """Raised when the trace exceeds MAX_STEPS."""


@dataclass
class TraceResult:
    stdout: str
    trace: List[Dict[str, Any]]
    error: str | None
    truncated: bool
    timed_out: bool


def format_value(value: Any, depth: int = 0) -> str:
    """Create a compact, JSON-serialisable string for display."""

    try:
        if depth > 2:
            return "..."
        if isinstance(value, (int, float, bool, type(None))):
            return repr(value)
        if isinstance(value, str):
            truncated = value[:57] + "..." if len(value) > 60 else value
            return repr(truncated)
        if isinstance(value, (list, tuple, set, frozenset)):
            opening, closing = {
                list: ("[", "]"),
                tuple: ("(", ")"),
                set: ("{", "}"),
                frozenset: ("{", "}"),
            }.get(type(value), ("(", ")"))
            items = list(value)
            preview_items = [format_value(item, depth + 1) for item in items[:6]]
            if len(items) > 6:
                preview_items.append("...")
            inner = ", ".join(preview_items)
            return f"{opening}{inner}{closing}"
        if isinstance(value, dict):
            items = list(value.items())
            preview_pairs = [
                f"{format_value(key, depth + 1)}: {format_value(val, depth + 1)}"
                for key, val in items[:6]
            ]
            if len(items) > 6:
                preview_pairs.append("...")
            inner = ", ".join(preview_pairs)
            return "{" + inner + "}"
        return repr(value)
    except Exception:  # pragma: no cover - best-effort formatting
        return f"<unrepr {type(value).__name__}>"


def sanitize_mapping(mapping: Dict[str, Any]) -> Dict[str, str]:
    result: Dict[str, str] = {}
    for key, value in mapping.items():
        key_str = str(key)
        if key_str == "__builtins__" or (key_str.startswith("__") and key_str.endswith("__")):
            continue
        result[key_str] = format_value(value)
    return result


def capture_stack(frame) -> List[Dict[str, Any]]:
    stack: List[Dict[str, Any]] = []
    seen = set()
    current = frame
    while current:
        if current.f_code.co_filename == USER_FILENAME:
            identifier = id(current)
            if identifier in seen:
                break
            seen.add(identifier)
            stack.append(
                {
                    "function": current.f_code.co_name,
                    "line": current.f_lineno,
                    "locals": sanitize_mapping(current.f_locals),
                }
            )
        current = current.f_back
    stack.reverse()
    return stack


def run_user_code(code: str, conn):
    stdout_buffer = io.StringIO()
    result: TraceResult | None = None

    def tracer(frame, event, arg):
        nonlocal steps
        if frame.f_code.co_filename != USER_FILENAME:
            return tracer
        if event not in {"call", "line", "return", "exception"}:
            return tracer
        if len(steps) >= MAX_STEPS:
            raise TraceLimitExceeded()

        step: Dict[str, Any] = {
            "event": event,
            "line": frame.f_lineno,
            "locals": sanitize_mapping(frame.f_locals),
            "globals": sanitize_mapping(frame.f_globals),
            "stack": capture_stack(frame),
        }
        if event == "return":
            step["return_value"] = format_value(arg)
        if event == "exception" and isinstance(arg, tuple) and len(arg) >= 2:
            exc_type, exc_value = arg[0], arg[1]
            step["exception"] = {
                "type": getattr(exc_type, "__name__", str(exc_type)),
                "value": format_value(exc_value),
            }
        steps.append(step)
        return tracer

    steps: List[Dict[str, Any]] = []
    error: str | None = None
    truncated = False

    original_stdout = sys.stdout
    original_stderr = sys.stderr
    try:
        sys.stdout = stdout_buffer
        sys.stderr = stdout_buffer
        compiled = compile(code, USER_FILENAME, "exec")
        user_globals: Dict[str, Any] = {"__name__": "__main__"}
        sys.settrace(tracer)
        try:
            exec(compiled, user_globals, user_globals)
        finally:
            sys.settrace(None)
    except TraceLimitExceeded:
        truncated = True
        error = f"Visualization limited to {MAX_STEPS} steps"
    except Exception:
        error = traceback.format_exc()
    finally:
        sys.stdout = original_stdout
        sys.stderr = original_stderr

    result = TraceResult(
        stdout=stdout_buffer.getvalue(),
        trace=steps,
        error=error,
        truncated=truncated,
        timed_out=False,
    )
    conn.send(result)
    conn.close()


def execute_code(code: str) -> TraceResult:
    parent_conn, child_conn = mp.Pipe()
    process = mp.Process(target=run_user_code, args=(code, child_conn))
    process.start()
    process.join(EXEC_TIMEOUT)

    if process.is_alive():
        process.kill()
        process.join()
        return TraceResult(stdout="", trace=[], error="Execution timed out", truncated=False, timed_out=True)

    if parent_conn.poll():
        result: TraceResult = parent_conn.recv()
    else:
        result = TraceResult(stdout="", trace=[], error="No result produced", truncated=False, timed_out=False)

    parent_conn.close()
    return result


@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.post("/api/run")
def api_run():
    payload = request.get_json(force=True, silent=True) or {}
    code = payload.get("code", "")
    if not isinstance(code, str):
        return jsonify({"error": "Invalid code payload", "trace": [], "stdout": "", "timedOut": False, "truncated": False}), 400

    result = execute_code(code)
    response = {
        "stdout": result.stdout,
        "trace": result.trace,
        "error": result.error,
        "truncated": result.truncated,
        "timedOut": result.timed_out,
    }
    return jsonify(response)


if __name__ == "__main__":  # pragma: no cover
    mp.freeze_support()
    app.run(debug=True, use_reloader=False)
