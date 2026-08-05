"""High-level, read-like workflow handlers for Godot projects."""

from __future__ import annotations

import asyncio
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from godot_ai.godot_client.client import GodotCommandError
from godot_ai.handlers import editor as editor_handlers
from godot_ai.handlers import scene as scene_handlers
from godot_ai.handlers import testing as testing_handlers
from godot_ai.runtime.direct import DirectRuntime

_SCENE_DEPTH = 4
_SCENE_NODE_LIMIT = 40
_SELECTION_LIMIT = 20
_LOG_WINDOW_LIMIT = 40
_DIAGNOSTIC_ENTRY_LIMIT = 20
_TEST_FAILURE_LIMIT = 20
_GIT_CHANGE_LIMIT = 40
_GIT_TIMEOUT_SECONDS = 2.0
_STALE_SESSION_SECONDS = 30.0
_TASK_LIMIT = 1_000
_TEXT_LIMIT = 500
_PATH_LIMIT = 300
_COLLECTION_LIMIT = 20
_VALUE_DEPTH_LIMIT = 3
_VALUE_NODE_LIMIT = 80


def _clip(value: object, limit: int = _TEXT_LIMIT) -> str:
    text = str(value)
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"


def _safe_int(value: object, default: int = 0) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError):
        return default


def _bounded_value(
    value: object, depth: int = 0, budget: list[int] | None = None
) -> Any:
    if budget is None:
        budget = [_VALUE_NODE_LIMIT]
    if budget[0] <= 0:
        return "<truncated>"
    budget[0] -= 1
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _clip(value)
    if depth >= _VALUE_DEPTH_LIMIT:
        return f"<{type(value).__name__} truncated>"
    if isinstance(value, dict):
        items = list(value.items())
        result: dict[str, Any] = {}
        for key, item in items[:_COLLECTION_LIMIT]:
            if budget[0] <= 0:
                break
            result[_clip(key, 100)] = _bounded_value(item, depth + 1, budget)
        if len(items) > len(result):
            result["_truncated"] = True
        return result
    if isinstance(value, (list, tuple)):
        result = []
        for item in value[:_COLLECTION_LIMIT]:
            if budget[0] <= 0:
                break
            result.append(_bounded_value(item, depth + 1, budget))
        if len(value) > len(result):
            result.append("<truncated>")
        return result
    return _clip(value)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_now() -> str:
    return _utc_now().isoformat()


def _age_ms(value: datetime | None) -> int | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return max(0, int((_utc_now() - value).total_seconds() * 1000))


def _error_payload(exc: BaseException) -> dict[str, Any]:
    if isinstance(exc, GodotCommandError):
        payload = exc.to_payload()
        payload["message"] = _clip(payload.get("message", ""))
        payload["data"] = _bounded_value(payload.get("data", {}))
        return payload
    if isinstance(exc, TimeoutError):
        return {
            "code": "TIMEOUT",
            "message": "The editor did not answer before the bounded timeout.",
        }
    if isinstance(exc, ConnectionError):
        return {"code": "PLUGIN_DISCONNECTED", "message": _clip(exc)}
    return {"code": type(exc).__name__, "message": _clip(exc)}


def _session_snapshot(session: Any) -> dict[str, Any]:
    if session is None:
        return {"connected": False}
    return {
        "connected": True,
        "session_id": _clip(session.session_id, 128),
        "name": _clip(session.name, 128),
        "godot_version": _clip(session.godot_version, 64),
        "plugin_version": _clip(session.plugin_version, 64),
        "protocol_version": session.protocol_version,
        "project_path": _clip(session.project_path, _PATH_LIMIT),
        "editor_pid": session.editor_pid,
        "server_launch_mode": _clip(session.server_launch_mode, 64),
        "connected_at": session.connected_at.isoformat(),
        "last_seen": session.last_seen.isoformat(),
    }


def _available_sessions(runtime: DirectRuntime) -> dict[str, Any]:
    sessions = runtime.list_sessions()
    entries = [
        {
            "session_id": _clip(session.session_id, 128),
            "name": _clip(session.name, 128),
            "project_path": _clip(session.project_path, _PATH_LIMIT),
        }
        for session in sessions[:10]
    ]
    return {
        "sessions": entries,
        "count": len(sessions),
        "truncated": len(sessions) > len(entries),
    }


def _unavailable_diagnostics(error: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "unavailable",
        "captured_at": _iso_now(),
        "errors_in_scanned_windows": 0,
        "warnings_in_scanned_windows": 0,
        "cross_scope_editor_errors": 0,
        "new_since_last_call": {"errors": 0, "warnings": 0},
        "entries": [],
        "entries_truncated": False,
        "sources": {
            "editor": {"status": "unavailable", "error": error},
            "game": {"status": "unavailable", "error": error},
        },
        "unavailable_sources": ["editor", "game"],
    }


def _connection_error(session: Any, exc: BaseException | None = None) -> dict[str, Any]:
    if exc is not None:
        return _error_payload(exc)
    if session is None:
        return {
            "code": "PLUGIN_DISCONNECTED",
            "message": "No active Godot editor session is connected.",
        }
    return {
        "code": "PLUGIN_DISCONNECTED",
        "message": "The selected Godot editor session is not reachable.",
    }


def _blocked_orient(
    runtime: DirectRuntime,
    *,
    task: str,
    session: Any,
    error: dict[str, Any],
) -> dict[str, Any]:
    if session is not None:
        action = (
            "Retry once; if the live probe still fails, reconnect the plugin or "
            "activate another listed editor session."
        )
    elif runtime.list_sessions():
        action = (
            'Select a listed editor with session_activate(session_id="..."), '
            "then call godot_orient again."
        )
    else:
        action = "Open Godot with the plugin enabled, then call godot_orient again."
    return {
        "snapshot_version": 1,
        "status": "blocked",
        "captured_at": _iso_now(),
        "task": {"provided": bool(task), "text": _clip(task, _TASK_LIMIT) if task else ""},
        "session": {**_session_snapshot(session), "error": error},
        "available_sessions": _available_sessions(runtime),
        "project": {"name": "", "path": "", "current_scene": ""},
        "editor": {"available": False, "error": error},
        "readiness": {
            "state": "disconnected",
            "writable": False,
            "has_open_scene": False,
            "staleness": {"live_probe": "blocked", "error": error},
        },
        "play": {"is_playing": False, "game_capture_ready": False, "game_status": {}},
        "scene": {"available": False, "error": error},
        "selection": {"available": False, "error": error},
        "diagnostics": _unavailable_diagnostics(error),
        "git": {"status": "unavailable", "reason": "no_live_project_session"},
        "next_actions": [action],
    }


def _blocked_verify(
    runtime: DirectRuntime,
    *,
    run_tests: bool,
    session: Any,
    error: dict[str, Any],
) -> dict[str, Any]:
    if session is not None:
        action = (
            "Retry once; if the live probe still fails, reconnect the plugin or "
            "activate another listed editor session."
        )
    elif runtime.list_sessions():
        action = (
            'Select a listed editor with session_activate(session_id="..."), '
            "then rerun godot_verify."
        )
    else:
        action = "Open Godot with the plugin enabled, then rerun godot_verify."
    failure = {
        "severity": "blocked",
        "check": "live_editor_probe",
        "message": _clip(error.get("message", "No live editor response was available.")),
        "action": action,
    }
    return {
        "verification_version": 1,
        "verdict": "blocked",
        "ok": False,
        "captured_at": _iso_now(),
        "scope": {
            "live_editor_probe": False,
            "readiness": False,
            "staleness": False,
            "fresh_editor_and_game_logs": False,
            "tests_requested": run_tests,
            "project_content_written_by_tool": False,
        },
        "session": {**_session_snapshot(session), "error": error},
        "available_sessions": _available_sessions(runtime),
        "editor": {"available": False, "error": error},
        "checks": {
            "readiness": {"status": "blocked", "observed": "disconnected"},
            "staleness": {"status": "blocked", "live_probe": "blocked", "error": error},
            "diagnostics": _unavailable_diagnostics(error),
            "tests": {
                "status": "blocked" if run_tests else "not_requested",
                "ran": False,
                "reason": "no_live_editor_session" if run_tests else "not_requested",
            },
        },
        "failures": [failure],
        "warnings": [],
    }


def _game_status_snapshot(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, Any] = {}
    for key in (
        "status",
        "active",
        "ready",
        "helper_expected",
        "helper_live",
        "session_active",
        "run_id",
        "run_token",
    ):
        if key in value:
            item = value[key]
            result[key] = _clip(item, 128) if isinstance(item, str) else item
    break_info = value.get("break")
    if isinstance(break_info, dict):
        result["break"] = {
            key: (_clip(break_info[key]) if isinstance(break_info[key], str) else break_info[key])
            for key in ("reason", "can_debug", "pre_live")
            if key in break_info
        }
    return result


def _editor_snapshot(state: dict[str, Any]) -> dict[str, Any]:
    result = {
        "godot_version": _clip(state.get("godot_version", ""), 64),
        "project_name": _clip(state.get("project_name", ""), 200),
        "current_scene": _clip(state.get("current_scene", ""), _PATH_LIMIT),
        "readiness": _clip(state.get("readiness", "unknown"), 64),
        "is_playing": bool(state.get("is_playing", False)),
        "game_capture_ready": bool(state.get("game_capture_ready", False)),
        "game_status": _game_status_snapshot(state.get("game_status")),
    }
    if state.get("mixed_state"):
        result["mixed_state_detected"] = True
    return result


def _cached_session_fields(session: Any) -> dict[str, Any] | None:
    if session is None:
        return None
    return {
        "readiness": session.readiness,
        "current_scene": session.current_scene,
        "play_state": session.play_state,
    }


def _cache_staleness(
    cached: dict[str, Any] | None,
    state: dict[str, Any],
    age_before_ms: int | None,
) -> dict:
    mismatches: list[dict[str, Any]] = []
    if cached is not None:
        comparisons = (
            ("readiness", cached["readiness"], state.get("readiness", "unknown")),
            ("current_scene", cached["current_scene"], state.get("current_scene", "")),
            (
                "play_state",
                cached["play_state"],
                "playing" if state.get("is_playing", False) else "stopped",
            ),
        )
        for field, cached, live in comparisons:
            if cached != live:
                mismatches.append(
                    {
                        "field": field,
                        "cached": _clip(cached, _PATH_LIMIT),
                        "live": _clip(live, _PATH_LIMIT),
                    }
                )
    old_heartbeat = age_before_ms is not None and age_before_ms > _STALE_SESSION_SECONDS * 1000
    return {
        "live_probe": "passed",
        "heartbeat_age_before_probe_ms": age_before_ms,
        "stale_threshold_ms": int(_STALE_SESSION_SECONDS * 1000),
        "heartbeat_was_old": old_heartbeat,
        "cache_mismatches": mismatches,
        "cache_was_stale": old_heartbeat or bool(mismatches),
        "note": (
            "The successful editor-state round trip is authoritative for this response; "
            "cache differences describe state before that probe."
        ),
    }


def _compact_scene(result: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    raw_nodes = result.get("nodes", [])
    nodes: list[dict[str, Any]] = []
    if isinstance(raw_nodes, list):
        for raw in raw_nodes[:_SCENE_NODE_LIMIT]:
            if not isinstance(raw, dict):
                continue
            nodes.append(
                {
                    "name": _clip(raw.get("name", ""), 128),
                    "type": _clip(raw.get("type", ""), 128),
                    "path": _clip(raw.get("path", ""), _PATH_LIMIT),
                    "children_count": _safe_int(raw.get("children_count", 0)),
                }
            )
    fallback_total = len(raw_nodes) if isinstance(raw_nodes, list) else 0
    total = _safe_int(result.get("total_count", fallback_total))
    return {
        "available": True,
        "path": _clip(state.get("current_scene", ""), _PATH_LIMIT),
        "depth": _SCENE_DEPTH,
        "nodes": nodes,
        "returned_count": len(nodes),
        "node_count_at_depth": total,
        "truncated": bool(result.get("has_more", total > len(nodes))),
        "message": _clip(result.get("message", ""), 200) if result.get("message") else "",
    }


def _compact_selection(result: dict[str, Any]) -> dict[str, Any]:
    raw_paths = result.get("selected_paths", result.get("selected", []))
    paths = raw_paths if isinstance(raw_paths, list) else []
    total = _safe_int(result.get("count", len(paths)), len(paths))
    return {
        "available": True,
        "paths": [_clip(path, _PATH_LIMIT) for path in paths[:_SELECTION_LIMIT]],
        "count": total,
        "truncated": total > _SELECTION_LIMIT,
    }


def _diagnostic_stamps(responses: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "errors": sum(
            max(0, _safe_int(response.get("new_errors_since_last_call", 0)))
            for response in responses
        ),
        "warnings": sum(
            max(0, _safe_int(response.get("new_warnings_since_last_call", 0)))
            for response in responses
        ),
    }


def _compact_log_entry(entry: dict[str, Any]) -> dict[str, Any]:
    details = entry.get("details") if isinstance(entry.get("details"), dict) else {}
    resolved = details.get("resolved") if isinstance(details.get("resolved"), dict) else {}
    path = entry.get("path") or resolved.get("path") or ""
    line = entry.get("line") or resolved.get("line") or 0
    function = entry.get("function") or resolved.get("function") or ""
    return {
        "source": _clip(entry.get("source", "unknown"), 32),
        "level": _clip(entry.get("level", "unknown"), 16),
        "text": _clip(entry.get("text", "")),
        "path": _clip(path, _PATH_LIMIT),
        "line": _safe_int(line),
        "function": _clip(function, 128),
    }


async def _recent_log_source(
    runtime: DirectRuntime, source: str
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    responses: list[dict[str, Any]] = []
    try:
        first = await editor_handlers.logs_read(
            runtime,
            count=_LOG_WINDOW_LIMIT,
            offset=0,
            source=source,
            include_details=True,
        )
        responses.append(first)
        total = max(0, _safe_int(first.get("total_count", 0)))
        page = first
        if total > _LOG_WINDOW_LIMIT:
            page = await editor_handlers.logs_read(
                runtime,
                count=_LOG_WINDOW_LIMIT,
                offset=max(0, total - _LOG_WINDOW_LIMIT),
                source=source,
                include_details=True,
            )
            responses.append(page)
        raw_lines = page.get("lines", [])
        lines = (
            [entry for entry in raw_lines if isinstance(entry, dict)]
            if isinstance(raw_lines, list)
            else []
        )
        offset = max(0, _safe_int(page.get("offset", 0)))
        page_total = max(total, _safe_int(page.get("total_count", total)))
        tail_complete = offset + len(lines) >= page_total and not bool(page.get("has_more", False))
        source_summary = {
            "status": "available",
            "total_retained": page_total,
            "scanned_count": len(lines),
            "scanned_offset": offset,
            "tail_complete": tail_complete,
            "retained_history_complete": (
                page_total <= _LOG_WINDOW_LIMIT
                and _safe_int(page.get("dropped_count", 0)) == 0
            ),
            "dropped_count": max(0, _safe_int(page.get("dropped_count", 0))),
        }
        for key in ("run_id", "current_run_id", "next_cursor"):
            if key in page:
                source_summary[key] = (
                    _clip(page[key], 128) if isinstance(page[key], str) else page[key]
                )
        if source == "game" and page.get("editor_errors_count"):
            source_summary["cross_scope_editor_errors"] = max(
                0, _safe_int(page.get("editor_errors_count", 0))
            )
        return source_summary, lines, responses
    except (GodotCommandError, ConnectionError, TimeoutError) as exc:
        return {"status": "unavailable", "error": _error_payload(exc)}, [], responses


async def _diagnostics_snapshot(
    runtime: DirectRuntime, prior_responses: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    responses = list(prior_responses or [])
    sources: dict[str, Any] = {}
    raw_entries: list[dict[str, Any]] = []
    for source in ("editor", "game"):
        source_summary, entries, source_responses = await _recent_log_source(runtime, source)
        sources[source] = source_summary
        raw_entries.extend(entries)
        responses.extend(source_responses)

    errors = [
        entry for entry in raw_entries if str(entry.get("level", "")).lower() == "error"
    ]
    warnings = [
        entry
        for entry in raw_entries
        if str(entry.get("level", "")).lower() in {"warn", "warning"}
    ]
    issue_entries = errors + warnings
    cross_scope_errors = max(
        0, _safe_int(sources.get("game", {}).get("cross_scope_editor_errors", 0))
    )
    unavailable = [name for name, value in sources.items() if value["status"] != "available"]
    stamps = _diagnostic_stamps(responses)
    has_issues = bool(
        issue_entries or cross_scope_errors or stamps["errors"] or stamps["warnings"]
    )
    return {
        "status": "partial" if unavailable else ("issues_found" if has_issues else "clean"),
        "captured_at": _iso_now(),
        "errors_in_scanned_windows": len(errors),
        "warnings_in_scanned_windows": len(warnings),
        "cross_scope_editor_errors": cross_scope_errors,
        "new_since_last_call": stamps,
        "entries": [
            _compact_log_entry(entry) for entry in issue_entries[:_DIAGNOSTIC_ENTRY_LIMIT]
        ],
        "entries_truncated": len(issue_entries) > _DIAGNOSTIC_ENTRY_LIMIT,
        "sources": sources,
        "unavailable_sources": unavailable,
    }


def _git_worktree_summary(project_path: str) -> dict[str, Any]:
    if not project_path:
        return {"status": "unavailable", "reason": "project_path_missing"}
    path = Path(project_path)
    if not path.is_dir():
        return {
            "status": "unavailable",
            "reason": "project_path_not_found",
            "project_path": _clip(project_path, _PATH_LIMIT),
        }
    kwargs: dict[str, Any] = {}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    try:
        completed = subprocess.run(
            [
                "git",
                "--no-optional-locks",
                "-c",
                "core.quotepath=false",
                "status",
                "--porcelain=v1",
                "--branch",
                "--untracked-files=normal",
            ],
            cwd=path,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_GIT_TIMEOUT_SECONDS,
            check=False,
            **kwargs,
        )
    except FileNotFoundError:
        return {"status": "unavailable", "reason": "git_not_installed"}
    except subprocess.TimeoutExpired:
        return {
            "status": "unavailable",
            "reason": "git_status_timeout",
            "timeout_seconds": _GIT_TIMEOUT_SECONDS,
        }
    except OSError as exc:
        return {"status": "unavailable", "reason": "git_status_error", "detail": _clip(exc)}

    if completed.returncode != 0:
        detail = _clip(completed.stderr.strip() or completed.stdout.strip())
        reason = (
            "not_a_git_repository"
            if "not a git repository" in detail.lower()
            else "git_status_failed"
        )
        return {"status": "unavailable", "reason": reason, "detail": detail}

    lines = completed.stdout.splitlines()
    branch_line = lines[0][3:] if lines and lines[0].startswith("## ") else ""
    changes = [line for line in lines if not line.startswith("## ") and len(line) >= 3]
    staged = modified = untracked = conflicts = 0
    conflict_codes = {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}
    compact_changes: list[dict[str, str]] = []
    for line in changes:
        code = line[:2]
        if code == "??":
            untracked += 1
        else:
            if code[0] != " ":
                staged += 1
            if code[1] != " ":
                modified += 1
            if code in conflict_codes:
                conflicts += 1
        if len(compact_changes) < _GIT_CHANGE_LIMIT:
            compact_changes.append({"status": code, "path": _clip(line[3:], _PATH_LIMIT)})

    ahead_match = re.search(r"ahead (\d+)", branch_line)
    behind_match = re.search(r"behind (\d+)", branch_line)
    branch = branch_line.split("...", 1)[0]
    if branch.startswith("No commits yet on "):
        branch = branch.removeprefix("No commits yet on ")
    return {
        "status": "clean" if not changes else "dirty",
        "branch": _clip(branch, 200),
        "upstream_summary": _clip(branch_line, 300),
        "ahead": _safe_int(ahead_match.group(1)) if ahead_match else 0,
        "behind": _safe_int(behind_match.group(1)) if behind_match else 0,
        "change_count": len(changes),
        "staged_count": staged,
        "modified_count": modified,
        "untracked_count": untracked,
        "conflict_count": conflicts,
        "changes": compact_changes,
        "changes_truncated": len(changes) > _GIT_CHANGE_LIMIT,
    }


def _compact_test_failure(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {"message": _clip(value)}
    result: dict[str, Any] = {}
    for key in (
        "suite",
        "test",
        "name",
        "message",
        "error",
        "path",
        "line",
        "expected",
        "actual",
        "duration_ms",
    ):
        if key not in value:
            continue
        item = value[key]
        result[key] = item if isinstance(item, (bool, int, float)) else _clip(item)
    return result


def _compact_test_result(result: dict[str, Any]) -> dict[str, Any]:
    failures = result.get("failures", [])
    raw_failures = failures if isinstance(failures, list) else []
    load_errors = result.get("load_errors", [])
    raw_load_errors = load_errors if isinstance(load_errors, list) else []
    summary: dict[str, Any] = {
        "passed": max(0, _safe_int(result.get("passed", 0))),
        "failed": max(0, _safe_int(result.get("failed", 0))),
        "skipped": max(0, _safe_int(result.get("skipped", 0))),
        "total": max(0, _safe_int(result.get("total", 0))),
        "duration_ms": max(0, _safe_int(result.get("duration_ms", 0))),
        "failures": [
            _compact_test_failure(item) for item in raw_failures[:_TEST_FAILURE_LIMIT]
        ],
        "failures_truncated": len(raw_failures) > _TEST_FAILURE_LIMIT,
        "load_errors": [_clip(item) for item in raw_load_errors[:_TEST_FAILURE_LIMIT]],
        "load_errors_truncated": len(raw_load_errors) > _TEST_FAILURE_LIMIT,
    }
    suites = result.get("suites_run", [])
    if isinstance(suites, list):
        summary["suites_run"] = [_clip(item, 128) for item in suites[:50]]
        summary["suites_truncated"] = len(suites) > 50
    for key in ("edited_scene", "scene_warning", "outcome", "phase", "tests_not_run"):
        if key in result:
            item = result[key]
            summary[key] = item if isinstance(item, (bool, int, float)) else _clip(item)
    if result.get("error"):
        summary["error"] = _clip(result["error"])
    return summary


async def godot_orient(
    runtime: DirectRuntime,
    *,
    task: str = "",
) -> dict[str, Any]:
    """Return a bounded live snapshot for starting or resuming Godot work."""
    session_before = runtime.get_active_session()
    if session_before is None:
        return _blocked_orient(
            runtime,
            task=task,
            session=None,
            error=_connection_error(None),
        )
    age_before_ms = _age_ms(session_before.last_seen) if session_before is not None else None
    cached_session = session_before
    cached_fields = _cached_session_fields(session_before)
    try:
        state = await editor_handlers.editor_state(runtime)
    except (GodotCommandError, ConnectionError, TimeoutError) as exc:
        return _blocked_orient(
            runtime,
            task=task,
            session=session_before,
            error=_connection_error(session_before, exc),
        )
    observed_responses = [state]
    git_task = (
        asyncio.create_task(asyncio.to_thread(_git_worktree_summary, session_before.project_path))
        if session_before.project_path
        else None
    )

    try:
        raw_scene = await scene_handlers.scene_get_hierarchy(
            runtime, depth=_SCENE_DEPTH, offset=0, limit=_SCENE_NODE_LIMIT
        )
        observed_responses.append(raw_scene)
        scene = _compact_scene(raw_scene, state)
    except (GodotCommandError, ConnectionError, TimeoutError) as exc:
        scene = {"available": False, "error": _error_payload(exc)}

    try:
        raw_selection = await editor_handlers.editor_selection_get(runtime)
        observed_responses.append(raw_selection)
        selection = _compact_selection(raw_selection)
    except (GodotCommandError, ConnectionError, TimeoutError) as exc:
        selection = {"available": False, "error": _error_payload(exc)}

    diagnostics = await _diagnostics_snapshot(runtime, observed_responses)
    if git_task is not None:
        git = await git_task
    else:
        git = {"status": "unavailable", "reason": "project_path_missing"}

    session = runtime.get_active_session() or cached_session
    staleness = _cache_staleness(cached_fields, state, age_before_ms)
    readiness = str(state.get("readiness", "unknown"))
    current_scene = str(state.get("current_scene", ""))
    next_actions: list[str] = []
    if readiness == "importing":
        next_actions.append("Wait for Godot's resource scan to finish before editing.")
    elif readiness == "playing":
        next_actions.append(
            'Stop play mode with project_manage(op="stop") before project-content writes.'
        )
    elif readiness == "no_scene":
        next_actions.append("Open or create the intended scene before scene-node edits.")
    if diagnostics["errors_in_scanned_windows"] or diagnostics["cross_scope_editor_errors"]:
        next_actions.append(
            "Inspect the reported diagnostic entries and fix errors before building on them."
        )
    elif diagnostics["warnings_in_scanned_windows"]:
        next_actions.append("Review the reported warnings before deciding they are harmless.")
    if scene.get("truncated"):
        next_actions.append(
            "Page scene_get_hierarchy for nodes beyond this orientation window if needed."
        )
    if git.get("status") == "dirty":
        next_actions.append("Preserve or account for the listed pre-existing Git changes.")
    if diagnostics["unavailable_sources"]:
        next_actions.append("Retry unavailable log sources before treating diagnostics as clean.")

    return {
        "snapshot_version": 1,
        "status": (
            "partial"
            if not scene.get("available", True)
            or not selection.get("available", True)
            or diagnostics["unavailable_sources"]
            else "ok"
        ),
        "captured_at": _iso_now(),
        "task": {"provided": bool(task), "text": _clip(task, _TASK_LIMIT) if task else ""},
        "session": _session_snapshot(session),
        "project": {
            "name": _clip(state.get("project_name", ""), 200),
            "path": _clip(session.project_path, _PATH_LIMIT) if session is not None else "",
            "current_scene": _clip(current_scene, _PATH_LIMIT),
        },
        "editor": _editor_snapshot(state),
        "readiness": {
            "state": readiness,
            "writable": readiness in {"ready", "no_scene"},
            "has_open_scene": bool(current_scene),
            "staleness": staleness,
        },
        "play": {
            "is_playing": bool(state.get("is_playing", False)),
            "game_capture_ready": bool(state.get("game_capture_ready", False)),
            "game_status": _game_status_snapshot(state.get("game_status")),
        },
        "scene": scene,
        "selection": selection,
        "diagnostics": diagnostics,
        "git": git,
        "next_actions": next_actions[:8],
    }


async def godot_verify(
    runtime: DirectRuntime,
    *,
    run_tests: bool = False,
    suite: str = "",
    test_name: str = "",
    exclude_test_name: str = "",
) -> dict[str, Any]:
    """Run bounded live verification without authoring or saving project content."""
    session_before = runtime.get_active_session()
    if session_before is None:
        return _blocked_verify(
            runtime,
            run_tests=run_tests,
            session=None,
            error=_connection_error(None),
        )
    age_before_ms = _age_ms(session_before.last_seen) if session_before is not None else None
    cached_fields = _cached_session_fields(session_before)
    try:
        state = await editor_handlers.editor_state(runtime)
    except (GodotCommandError, ConnectionError, TimeoutError) as exc:
        return _blocked_verify(
            runtime,
            run_tests=run_tests,
            session=session_before,
            error=_connection_error(session_before, exc),
        )
    observed_responses = [state]
    readiness = str(state.get("readiness", "unknown"))
    staleness = _cache_staleness(cached_fields, state, age_before_ms)
    failures: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []

    readiness_status = "passed"
    if readiness == "importing":
        readiness_status = "blocked"
        failures.append(
            {
                "severity": "blocked",
                "check": "readiness",
                "message": "Godot is importing resources, so verification is not stable yet.",
                "action": "Wait for importing to finish, then rerun godot_verify.",
            }
        )
    elif readiness == "playing" and run_tests:
        readiness_status = "blocked"
        failures.append(
            {
                "severity": "blocked",
                "check": "readiness",
                "message": "In-editor tests were requested while the project is playing.",
                "action": 'Call project_manage(op="stop"), then rerun godot_verify.',
            }
        )
    elif readiness == "playing":
        readiness_status = "warning"
        warnings.append(
            {
                "check": "readiness",
                "message": (
                    "The project is playing; runtime diagnostics were checked, "
                    "but writes are blocked."
                ),
                "action": 'Use project_manage(op="stop") before further editor writes.',
            }
        )
    elif readiness == "no_scene":
        readiness_status = "warning"
        warnings.append(
            {
                "check": "readiness",
                "message": "No edited scene is open.",
                "action": "Open the intended scene if scene-dependent behavior must be verified.",
            }
        )
    elif readiness != "ready":
        readiness_status = "blocked"
        failures.append(
            {
                "severity": "blocked",
                "check": "readiness",
                "message": f"Godot reported unknown readiness state {_clip(readiness, 64)!r}.",
                "action": (
                    "Inspect editor_state and update the plugin/server if their "
                    "protocols differ."
                ),
            }
        )

    if staleness["cache_was_stale"]:
        warnings.append(
            {
                "check": "staleness",
                "message": (
                    "The pre-probe session cache was old or disagreed with live "
                    "editor state."
                ),
                "action": (
                    "Use the live values in this response; rerun if state is "
                    "changing concurrently."
                ),
            }
        )

    tests: dict[str, Any] = {"status": "not_requested", "ran": False}
    if run_tests and readiness_status != "blocked":
        try:
            raw_tests = await testing_handlers.test_run(
                runtime,
                suite=suite,
                test_name=test_name,
                exclude_test_name=exclude_test_name,
                verbose=False,
            )
            observed_responses.append(raw_tests)
            summary = _compact_test_result(raw_tests)
            test_failed = bool(
                summary["failed"] or summary["load_errors"] or summary.get("error")
            )
            tests = {"status": "failed" if test_failed else "passed", "ran": True, **summary}
            if test_failed:
                failures.append(
                    {
                        "severity": "failed",
                        "check": "tests",
                        "message": (
                            f"In-editor tests reported {summary['failed']} failure(s) and "
                            f"{len(summary['load_errors'])} load error(s)."
                        ),
                        "action": "Fix the reported test/load failures, then rerun godot_verify.",
                    }
                )
            elif summary["total"] == 0:
                tests["status"] = "failed"
                failures.append(
                    {
                        "severity": "failed",
                        "check": "tests",
                        "message": "Tests were requested, but no tests ran.",
                        "action": (
                            "Check the suite/filter and res://tests/test_*.gd "
                            "discovery, then retry."
                        ),
                    }
                )
            elif summary["passed"] == 0 and summary["skipped"]:
                warnings.append(
                    {
                        "check": "tests",
                        "message": "Every discovered test was skipped.",
                        "action": (
                            "Run at least one applicable test before claiming "
                            "behavioral coverage."
                        ),
                    }
                )
        except (GodotCommandError, ConnectionError, TimeoutError) as exc:
            error = _error_payload(exc)
            partial = _compact_test_result(exc.data) if isinstance(exc, GodotCommandError) else None
            tests = {"status": "blocked", "ran": True, "error": error}
            if partial is not None:
                tests["partial_results"] = partial
            failures.append(
                {
                    "severity": "blocked",
                    "check": "tests",
                    "message": _clip(
                        error.get("message", "The in-editor test run did not complete.")
                    ),
                    "action": (
                        'Inspect test_manage(op="results_get") for partials, narrow the suite, '
                        "and rerun godot_verify."
                    ),
                }
            )
    elif run_tests:
        tests = {
            "status": "blocked",
            "ran": False,
            "reason": "readiness_check_blocked_test_run",
        }

    diagnostics = await _diagnostics_snapshot(runtime, observed_responses)
    if diagnostics["unavailable_sources"]:
        failures.append(
            {
                "severity": "blocked",
                "check": "diagnostics",
                "message": (
                    "Fresh diagnostics were unavailable from: "
                    + ", ".join(diagnostics["unavailable_sources"])
                    + "."
                ),
                "action": (
                    "Check the editor session and rerun godot_verify before "
                    "claiming success."
                ),
            }
        )
    diagnostic_error_count = (
        diagnostics["errors_in_scanned_windows"]
        + diagnostics["cross_scope_editor_errors"]
        + diagnostics["new_since_last_call"]["errors"]
    )
    if diagnostic_error_count:
        failures.append(
            {
                "severity": "failed",
                "check": "diagnostics",
                "message": (
                    f"Fresh diagnostic evidence includes {diagnostic_error_count} error signal(s)."
                ),
                "action": (
                    "Inspect the returned entries or logs_read(source='editor' or 'game', "
                    "include_details=true), fix the errors, then rerun godot_verify."
                ),
            }
        )
    diagnostic_warning_count = (
        diagnostics["warnings_in_scanned_windows"]
        + diagnostics["new_since_last_call"]["warnings"]
    )
    if diagnostic_warning_count:
        warnings.append(
            {
                "check": "diagnostics",
                "message": (
                    "Fresh diagnostic evidence includes "
                    f"{diagnostic_warning_count} warning signal(s)."
                ),
                "action": "Review the returned warnings and decide whether each is acceptable.",
            }
        )

    severities = {item["severity"] for item in failures}
    if "failed" in severities:
        verdict = "failed"
    elif "blocked" in severities:
        verdict = "blocked"
    elif warnings:
        verdict = "passed_with_warnings"
    else:
        verdict = "passed"

    return {
        "verification_version": 1,
        "verdict": verdict,
        "ok": verdict in {"passed", "passed_with_warnings"},
        "captured_at": _iso_now(),
        "scope": {
            "live_editor_probe": True,
            "readiness": True,
            "staleness": True,
            "fresh_editor_and_game_logs": True,
            "tests_requested": run_tests,
            "project_content_written_by_tool": False,
        },
        "session": _session_snapshot(runtime.get_active_session() or session_before),
        "editor": _editor_snapshot(state),
        "checks": {
            "readiness": {"status": readiness_status, "observed": readiness},
            "staleness": {
                "status": "warning" if staleness["cache_was_stale"] else "passed",
                **staleness,
            },
            "diagnostics": diagnostics,
            "tests": tests,
        },
        "failures": failures,
        "warnings": warnings,
    }
