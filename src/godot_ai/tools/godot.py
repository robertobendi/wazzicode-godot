"""High-level Godot workflow tools.

``godot_orient`` is an always-loaded read-only entry point.
``godot_verify`` is deferred and optionally invokes the existing test runner.
"""

from __future__ import annotations

from fastmcp import Context, FastMCP

from godot_ai.handlers import godot as godot_handlers
from godot_ai.runtime.direct import DirectRuntime
from godot_ai.tools import DEFER_META


def register_godot_tools(mcp: FastMCP, *, include_non_core: bool = True) -> None:
    @mcp.tool()
    async def godot_orient(
        ctx: Context,
        task: str = "",
        session_id: str = "",
    ) -> dict:
        """Orient before Godot work with one bounded, read-only live snapshot.

        Returns the pinned session and project, authoritative editor readiness
        and play/liveness state, a depth-limited current-scene hierarchy,
        current selection, newest bounded editor/game error and warning
        windows, and a bounded Git working-tree summary when the project path
        is available. Partial component failures are labeled instead of being
        mistaken for clean state.

        Args:
            task: Optional task text to echo into the snapshot for context.
                It does not change editor state or drive hidden actions.
            session_id: Optional Godot session to target. Empty = active session.
        """
        runtime = DirectRuntime.from_context(ctx, session_id=session_id or None)
        return await godot_handlers.godot_orient(runtime, task=task)

    if not include_non_core:
        return

    @mcp.tool(meta=DEFER_META)
    async def godot_verify(
        ctx: Context,
        run_tests: bool = False,
        suite: str = "",
        test_name: str = "",
        exclude_test_name: str = "",
        session_id: str = "",
    ) -> dict:
        """Verify live Godot health with an explicit, evidence-based verdict.

        Always performs a fresh editor/readiness probe, reports stale cached
        state, and reads the newest bounded editor and current-game diagnostic
        windows. Set run_tests=True to also invoke the existing in-editor
        res://tests/test_*.gd runner with optional filters. This orchestration
        does not author, save, or write project content; project-owned test
        scripts remain arbitrary code and are responsible for their own side
        effects.

        Verdicts are ``passed``, ``passed_with_warnings``, ``failed``, or
        ``blocked``. The response states whether tests ran, which evidence was
        bounded or unavailable, and gives an action for every failure.

        Args:
            run_tests: Explicitly run in-editor tests. Default False.
            suite: Optional exact suite filter when run_tests is True.
            test_name: Optional test-name substring filter.
            exclude_test_name: Optional test-name substring to skip.
            session_id: Optional Godot session to target. Empty = active session.
        """
        runtime = DirectRuntime.from_context(ctx, session_id=session_id or None)
        return await godot_handlers.godot_verify(
            runtime,
            run_tests=run_tests,
            suite=suite,
            test_name=test_name,
            exclude_test_name=exclude_test_name,
        )
