"""Focused contracts for the high-level Godot orientation/verification tools."""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone

from godot_ai.godot_client.client import GodotCommandError
from godot_ai.handlers import godot as godot_handlers
from godot_ai.protocol.timeouts import TEST_RUN_TIMEOUT_SEC
from godot_ai.runtime.direct import DirectRuntime
from godot_ai.sessions.registry import Session, SessionRegistry


class WorkflowClient:
    def __init__(
        self,
        *,
        readiness: str = "ready",
        is_playing: bool = False,
        editor_logs: list[dict] | None = None,
        game_logs: list[dict] | None = None,
        test_result: dict | None = None,
    ) -> None:
        self.readiness = readiness
        self.is_playing = is_playing
        self.editor_logs = editor_logs or []
        self.game_logs = game_logs or []
        self.test_result = test_result or {
            "passed": 2,
            "failed": 0,
            "skipped": 0,
            "total": 2,
            "duration_ms": 4,
            "suites_run": ["workflow"],
        }
        self.calls: list[dict] = []

    async def send(
        self,
        command: str,
        params: dict | None = None,
        session_id: str | None = None,
        timeout: float = 5.0,
        hint_policy=None,
    ) -> dict:
        params = params or {}
        self.calls.append(
            {
                "command": command,
                "params": params,
                "session_id": session_id,
                "timeout": timeout,
                "hint_policy": hint_policy,
            }
        )
        if command == "get_editor_state":
            return {
                "godot_version": "4.5.1",
                "project_name": "WorkflowGame",
                "current_scene": "res://main.tscn",
                "readiness": self.readiness,
                "is_playing": self.is_playing,
                "game_capture_ready": self.is_playing,
                "game_status": {
                    "status": "live" if self.is_playing else "stopped",
                    "helper_live": self.is_playing,
                    "session_active": self.is_playing,
                },
            }
        if command == "get_scene_tree":
            all_nodes = [
                {
                    "name": f"Node{index}",
                    "type": "Node3D",
                    "path": f"/Main/Node{index}",
                    "children_count": 0,
                }
                for index in range(55)
            ]
            offset = int(params.get("offset", 0))
            limit = int(params.get("limit", 100))
            return {
                "nodes": all_nodes[offset : offset + limit],
                "total_count": len(all_nodes),
                "offset": offset,
                "limit": limit,
                "has_more": offset + limit < len(all_nodes),
            }
        if command == "get_selection":
            paths = [f"/Main/Node{index}" for index in range(25)]
            return {"selected_paths": paths, "count": len(paths)}
        if command == "get_logs":
            source = str(params.get("source", "editor"))
            entries = self.editor_logs if source == "editor" else self.game_logs
            offset = int(params.get("offset", 0))
            count = int(params.get("count", 50))
            page = entries[offset : offset + count]
            return {
                "source": source,
                "lines": page,
                "total_count": len(entries),
                "returned_count": len(page),
                "offset": offset,
                "has_more": offset + count < len(entries),
                "run_id": "run-1" if source == "game" else "",
                "current_run_id": "run-1" if source == "game" else "",
                "is_running": self.is_playing,
                "dropped_count": 0,
                "next_cursor": len(entries),
            }
        if command == "run_tests":
            return dict(self.test_result)
        raise AssertionError(f"Unexpected command: {command}")


def _runtime(
    client: WorkflowClient,
    *,
    project_path: str = "C:/projects/workflow_game",
    cached_readiness: str | None = None,
    cached_scene: str = "res://main.tscn",
    cached_play_state: str | None = None,
) -> DirectRuntime:
    registry = SessionRegistry()
    session = Session(
        session_id="workflow@1234",
        godot_version="4.5.1",
        project_path=project_path,
        plugin_version="3.1.1",
        current_scene=cached_scene,
        play_state=cached_play_state or ("playing" if client.is_playing else "stopped"),
        readiness=cached_readiness or client.readiness,
        last_seen=datetime.now(timezone.utc),
    )
    registry.register(session)
    return DirectRuntime(registry=registry, client=client, session_id=session.session_id)


async def test_orient_without_session_is_bounded_actionable_and_does_not_call_editor():
    client = WorkflowClient()
    runtime = DirectRuntime(registry=SessionRegistry(), client=client)

    result = await godot_handlers.godot_orient(runtime, task="inspect player")

    assert result["status"] == "blocked"
    assert result["session"]["connected"] is False
    assert result["diagnostics"]["status"] == "unavailable"
    assert "Open Godot" in result["next_actions"][0]
    assert result["task"]["text"] == "inspect player"
    assert client.calls == []


async def test_verify_without_session_returns_blocked_verdict_and_skips_requested_tests():
    client = WorkflowClient()
    runtime = DirectRuntime(registry=SessionRegistry(), client=client)

    result = await godot_handlers.godot_verify(runtime, run_tests=True)

    assert result["verdict"] == "blocked"
    assert result["ok"] is False
    assert result["checks"]["tests"] == {
        "status": "blocked",
        "ran": False,
        "reason": "no_live_editor_session",
    }
    assert result["failures"][0]["check"] == "live_editor_probe"
    assert client.calls == []


async def test_orient_returns_bounded_snapshot_latest_diagnostics_and_pinned_routing(
    monkeypatch,
):
    editor_logs = [
        {"source": "editor", "level": "info", "text": f"line {index}"}
        for index in range(43)
    ] + [
        {
            "source": "editor",
            "level": "error",
            "text": "Parse error",
            "path": "res://broken.gd",
            "line": 9,
        },
        {"source": "editor", "level": "warn", "text": "Unused signal"},
    ]
    game_logs = [{"source": "game", "level": "warn", "text": "Low health"}]
    client = WorkflowClient(editor_logs=editor_logs, game_logs=game_logs)
    runtime = _runtime(client, cached_readiness="playing", cached_scene="")
    monkeypatch.setattr(
        godot_handlers,
        "_git_worktree_summary",
        lambda _path: {
            "status": "dirty",
            "change_count": 1,
            "changes": [{"status": " M", "path": "scripts/player.gd"}],
            "changes_truncated": False,
        },
    )

    result = await godot_handlers.godot_orient(runtime, task="x" * 2_000)

    assert result["status"] == "ok"
    assert len(result["task"]["text"]) == 1_000
    assert result["scene"]["returned_count"] == 40
    assert result["scene"]["truncated"] is True
    assert len(result["selection"]["paths"]) == 20
    assert result["selection"]["truncated"] is True
    assert result["diagnostics"]["errors_in_scanned_windows"] == 1
    assert result["diagnostics"]["warnings_in_scanned_windows"] == 2
    assert result["diagnostics"]["sources"]["editor"]["scanned_offset"] == 5
    assert result["readiness"]["staleness"]["cache_was_stale"] is True
    assert result["git"]["status"] == "dirty"
    assert all(call["session_id"] == "workflow@1234" for call in client.calls)


async def test_verify_clean_without_tests_passes_and_only_uses_read_commands():
    client = WorkflowClient(
        editor_logs=[{"source": "editor", "level": "info", "text": "ready"}],
        game_logs=[{"source": "game", "level": "info", "text": "idle"}],
    )
    runtime = _runtime(client)

    result = await godot_handlers.godot_verify(runtime)

    assert result["verdict"] == "passed"
    assert result["ok"] is True
    assert result["checks"]["tests"]["status"] == "not_requested"
    assert {call["command"] for call in client.calls} == {"get_editor_state", "get_logs"}
    assert result["scope"]["project_content_written_by_tool"] is False


async def test_verify_optional_tests_passes_filters_to_existing_runner():
    client = WorkflowClient()
    runtime = _runtime(client)

    result = await godot_handlers.godot_verify(
        runtime,
        run_tests=True,
        suite="player",
        test_name="jump",
        exclude_test_name="slow",
    )

    assert result["verdict"] == "passed"
    assert result["checks"]["tests"]["status"] == "passed"
    run_call = next(call for call in client.calls if call["command"] == "run_tests")
    assert run_call["params"] == {
        "suite": "player",
        "test_name": "jump",
        "exclude_test_name": "slow",
        "timeout_budget_sec": TEST_RUN_TIMEOUT_SEC,
    }
    assert run_call["session_id"] == "workflow@1234"


async def test_verify_fails_on_test_failures_and_fresh_diagnostics():
    client = WorkflowClient(
        editor_logs=[
            {
                "source": "editor",
                "level": "error",
                "text": "Invalid call",
                "path": "res://player.gd",
                "line": 12,
            }
        ],
        test_result={
            "passed": 1,
            "failed": 1,
            "skipped": 0,
            "total": 2,
            "duration_ms": 8,
            "failures": [
                {"suite": "player", "test": "test_jump", "message": "expected landing"}
            ],
        },
    )
    runtime = _runtime(client)

    result = await godot_handlers.godot_verify(runtime, run_tests=True)

    assert result["verdict"] == "failed"
    assert result["ok"] is False
    assert result["checks"]["tests"]["failed"] == 1
    assert result["checks"]["diagnostics"]["errors_in_scanned_windows"] == 1
    assert {failure["check"] for failure in result["failures"]} == {
        "tests",
        "diagnostics",
    }
    assert all(failure["action"] for failure in result["failures"])


async def test_verify_blocks_requested_tests_during_play_but_still_reads_logs():
    client = WorkflowClient(readiness="playing", is_playing=True)
    runtime = _runtime(client)

    result = await godot_handlers.godot_verify(runtime, run_tests=True)

    assert result["verdict"] == "blocked"
    assert result["checks"]["tests"]["ran"] is False
    assert "run_tests" not in {call["command"] for call in client.calls}
    assert "get_logs" in {call["command"] for call in client.calls}


def test_git_summary_is_bounded_and_parses_worktree_counts(monkeypatch, tmp_path):
    captured: dict = {}

    def fake_run(args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(
            args=args,
            returncode=0,
            stdout=(
                "## main...origin/main [ahead 2, behind 1]\n"
                " M scripts/player.gd\n"
                "A  scenes/new_scene.tscn\n"
                "?? art/icon.png\n"
                "UU scripts/conflict.gd\n"
            ),
            stderr="",
        )

    monkeypatch.setattr(godot_handlers.subprocess, "run", fake_run)

    result = godot_handlers._git_worktree_summary(str(tmp_path))

    assert result["status"] == "dirty"
    assert result["branch"] == "main"
    assert result["ahead"] == 2
    assert result["behind"] == 1
    assert result["change_count"] == 4
    assert result["staged_count"] == 2
    assert result["modified_count"] == 2
    assert result["untracked_count"] == 1
    assert result["conflict_count"] == 1
    assert "--no-optional-locks" in captured["args"]
    assert captured["kwargs"]["cwd"] == tmp_path


def test_workflow_error_payload_bounds_nested_plugin_data():
    error = GodotCommandError(
        "BROKEN" * 50,
        "message" * 200,
        {
            "items": ["value" * 200 for _ in range(100)],
            "nested": {f"key-{index}": {"more": [index] * 50} for index in range(100)},
        },
    )

    payload = godot_handlers._error_payload(error)

    assert len(payload["message"]) == 500
    assert len(payload["data"]["items"]) <= 21
    assert payload["data"]["items"][-1] == "<truncated>"
    assert payload["data"]["nested"]["_truncated"] is True
    assert len(json.dumps(payload)) < 50_000
