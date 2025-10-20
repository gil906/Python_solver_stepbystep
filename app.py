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


def serialize_value(value: Any, depth: int = 0) -> Dict[str, Any]:
    type_name = type(value).__name__
    serialized: Dict[str, Any] = {
        "type": type_name,
        "repr": format_value(value, depth),
    }

    if isinstance(value, bool):
        serialized["numeric"] = int(value)
    elif isinstance(value, (int, float)):
        serialized["numeric"] = float(value)

    if depth > 2:
        return serialized

    if isinstance(value, (list, tuple)):
        items = []
        for item in value[:6]:
            items.append(serialize_value(item, depth + 1))
        if len(value) > 6:
            items.append({"type": "...", "repr": "...", "truncated": True})
        serialized["items"] = items
        serialized["kind"] = "sequence"
    elif isinstance(value, dict):
        entries = []
        for key, val in list(value.items())[:6]:
            entries.append({
                "key": serialize_value(key, depth + 1),
                "value": serialize_value(val, depth + 1),
            })
        if len(value) > 6:
            entries.append({"truncated": True})
        serialized["items"] = entries
        serialized["kind"] = "mapping"
    elif isinstance(value, (set, frozenset)):
        items = []
        iterable = list(value)
        for item in iterable[:6]:
            items.append(serialize_value(item, depth + 1))
        if len(iterable) > 6:
            items.append({"type": "...", "repr": "...", "truncated": True})
        serialized["items"] = items
        serialized["kind"] = "set"

    return serialized


MAX_PREVIEW_ITEMS = 6
MAX_REFERENCE_DEPTH = 3


def serialize_scalar(value: Any) -> Dict[str, Any]:
    descriptor: Dict[str, Any] = {
        "type": type(value).__name__,
        "repr": format_value(value),
    }
    if isinstance(value, bool):
        descriptor["numeric"] = int(value)
    elif isinstance(value, (int, float)):
        descriptor["numeric"] = float(value)
    if isinstance(value, str):
        descriptor["length"] = len(value)
    return descriptor


def serialize_reference(value: Any, heap: Dict[str, Any], depth: int = 0) -> Dict[str, Any]:
    if isinstance(value, (int, float, bool, type(None), str)):
        return serialize_scalar(value)

    if depth >= MAX_REFERENCE_DEPTH:
        descriptor = serialize_scalar(value)
        descriptor["truncated"] = True
        return descriptor

    obj_id = id(value)
    ref = f"obj_{obj_id}"
    descriptor: Dict[str, Any] = {
        "type": type(value).__name__,
        "repr": format_value(value),
        "ref": ref,
    }

    if ref in heap:
        return descriptor

    heap_entry: Dict[str, Any] = {
        "type": descriptor["type"],
        "repr": descriptor["repr"],
        "id": ref,
    }
    heap[ref] = heap_entry

    if isinstance(value, (list, tuple)):
        heap_entry["kind"] = "sequence"
        heap_entry["length"] = len(value)
        items: List[Dict[str, Any]] = []
        for item in list(value)[:MAX_PREVIEW_ITEMS]:
            items.append(serialize_reference(item, heap, depth + 1))
        if len(value) > MAX_PREVIEW_ITEMS:
            items.append({"truncated": True})
        heap_entry["items"] = items
    elif isinstance(value, dict):
        heap_entry["kind"] = "mapping"
        heap_entry["length"] = len(value)
        entries: List[Dict[str, Any]] = []
        for key, val in list(value.items())[:MAX_PREVIEW_ITEMS]:
            entries.append(
                {
                    "key": serialize_reference(key, heap, depth + 1),
                    "value": serialize_reference(val, heap, depth + 1),
                }
            )
        if len(value) > MAX_PREVIEW_ITEMS:
            entries.append({"truncated": True})
        heap_entry["entries"] = entries
    elif isinstance(value, (set, frozenset)):
        heap_entry["kind"] = "set"
        iterable = list(value)
        iterable.sort(key=lambda item: format_value(item))
        items = [serialize_reference(item, heap, depth + 1) for item in iterable[:MAX_PREVIEW_ITEMS]]
        if len(iterable) > MAX_PREVIEW_ITEMS:
            items.append({"truncated": True})
        heap_entry["items"] = items
        heap_entry["length"] = len(iterable)
    elif hasattr(value, "__dict__"):
        heap_entry["kind"] = "object"
        attributes: Dict[str, Any] = {}
        try:
            attr_items = list(vars(value).items())
        except TypeError:
            attr_items = []
        for attr_name, attr_value in attr_items[:MAX_PREVIEW_ITEMS]:
            attributes[str(attr_name)] = serialize_reference(attr_value, heap, depth + 1)
        if len(attr_items) > MAX_PREVIEW_ITEMS:
            attributes["..."] = {"truncated": True}
        if attributes:
            heap_entry["attributes"] = attributes
    else:
        heap_entry["kind"] = "opaque"

    return descriptor


def sanitize_mapping(mapping: Dict[str, Any], heap: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    result: Dict[str, Dict[str, Any]] = {}
    try:
        items = list(mapping.items())
    except Exception:
        items = []
    items.sort(key=lambda pair: str(pair[0]))
    for key, value in items[: MAX_PREVIEW_ITEMS * 4]:
        key_str = str(key)
        if key_str == "__builtins__" or (key_str.startswith("__") and key_str.endswith("__")):
            continue
        try:
            result[key_str] = serialize_reference(value, heap)
        except Exception:
            result[key_str] = {
                "type": type(value).__name__,
                "repr": "<unserializable>",
            }
    return result


def capture_stack(frame, heap: Dict[str, Any]) -> List[Dict[str, Any]]:
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
                    "locals": sanitize_mapping(current.f_locals, heap),
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

        heap: Dict[str, Any] = {}
        step: Dict[str, Any] = {
            "event": event,
            "line": frame.f_lineno,
            "locals": sanitize_mapping(frame.f_locals, heap),
            "globals": sanitize_mapping(frame.f_globals, heap),
            "stack": capture_stack(frame, heap),
            "heap": heap,
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
