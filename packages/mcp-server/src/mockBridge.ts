import { BridgeMethod, BridgeResponse } from "@uvibe/core";
import { BridgeClient } from "@uvibe/bridge-client";
import { makeMockPng } from "./mockPng.js";

export function createMockBridgeClient(): BridgeClient {
  const meta = {
    unityVersion: "2022.3.42f1 (mock)",
    projectPath: "/mock/project",
    durationMs: 3,
  };

  const responders: Partial<Record<BridgeMethod, () => unknown>> = {
    "system.health": () => ({ status: "ok", uptime: 12345 }),

    "system.summary": () => ({
      unityVersion: "2022.3.42f1",
      projectPath: "/mock/project",
      productName: "MockGame",
      companyName: "MockStudio",
      bundleIdentifier: "com.mockstudio.mockgame",
      renderPipeline: "Universal",
      inputSystem: "InputSystem",
      scriptingBackend: "Mono",
      buildTarget: "StandaloneOSX",
      packages: [
        { name: "com.unity.render-pipelines.universal", version: "14.0.11" },
        { name: "com.unity.inputsystem", version: "1.7.0" },
        { name: "com.unity.textmeshpro", version: "3.0.6" },
      ],
    }),

    "build.getSettings": () => ({
      valid: true,
      activeBuildTarget: "StandaloneOSX",
      buildTargetGroup: "Standalone",
      targetSupported: true,
      developmentBuild: true,
      enabledSceneCount: 1,
      scenes: [
        { path: "Assets/Scenes/Sample.unity", enabled: true, guid: "scene123", exists: true },
      ],
      issues: [],
    }),

    "scene.getOpenScenes": () => ({
      scenes: [
        {
          path: "Assets/Scenes/Sample.unity",
          name: "Sample",
          isLoaded: true,
          isDirty: false,
          rootCount: 4,
          buildIndex: 0,
        },
      ],
      activeScene: "Assets/Scenes/Sample.unity",
    }),

    "scene.getHierarchy": () => ({
      scene: "Assets/Scenes/Sample.unity",
      totalObjects: 6,
      roots: [
        {
          name: "Main Camera",
          path: "/Main Camera",
          active: true,
          childCount: 0,
          components: ["Transform", "Camera", "AudioListener"],
        },
        {
          name: "Directional Light",
          path: "/Directional Light",
          active: true,
          childCount: 0,
          components: ["Transform", "Light"],
        },
        {
          name: "Gameplay",
          path: "/Gameplay",
          active: true,
          childCount: 1,
          components: ["Transform"],
          children: [
            {
              name: "Player",
              path: "/Gameplay/Player",
              active: true,
              childCount: 1,
              components: ["Transform", "PlayerController", "Rigidbody"],
              children: [
                {
                  name: "WeaponSocket",
                  path: "/Gameplay/Player/WeaponSocket",
                  active: true,
                  childCount: 0,
                  components: ["Transform"],
                },
              ],
            },
          ],
        },
        {
          name: "EventSystem",
          path: "/EventSystem",
          active: true,
          childCount: 0,
          components: ["Transform", "EventSystem", "StandaloneInputModule"],
        },
      ],
    }),

    "selection.inspect": () => ({
      hasSelection: true,
      selected: {
        name: "Player",
        path: "/Gameplay/Player",
        instanceId: 1234,
        activeSelf: true,
        activeInHierarchy: true,
        tag: "Player",
        layer: "Default",
        scene: "Assets/Scenes/Sample.unity",
        prefab: {
          isPrefabInstance: true,
          sourcePath: "Assets/Prefabs/Player.prefab",
          hasOverrides: true,
        },
        transform: {
          position: { x: 0, y: 1, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          localScale: { x: 1, y: 1, z: 1 },
        },
        components: [
          {
            type: "Transform",
            assembly: "UnityEngine.CoreModule",
            fields: {
              localPosition: { x: 0, y: 1, z: 0 },
              localEulerAngles: { x: 0, y: 0, z: 0 },
              localScale: { x: 1, y: 1, z: 1 },
            },
          },
          {
            type: "PlayerController",
            assembly: "Assembly-CSharp",
            enabled: true,
            fields: {
              moveSpeed: 7.5,
              dashForce: 18,
              weaponController: {
                referenceType: "GameObject",
                path: "/Gameplay/Player/WeaponSocket",
                name: "WeaponSocket",
              },
              currentWeapon: {
                referenceType: "Missing",
                name: null,
              },
            },
          },
          {
            type: "Rigidbody",
            assembly: "UnityEngine.PhysicsModule",
            fields: {
              mass: 1,
              drag: 0,
              useGravity: true,
              isKinematic: false,
            },
          },
        ],
        warnings: ["currentWeapon is null"],
      },
    }),

    "console.getLogs": () => ({
      logs: [
        {
          type: "Log",
          message: "Mock log emitted at startup",
          timestamp: Date.now() - 5000,
        },
        {
          type: "Warning",
          message: "Mock warning: missing reference detected on Player.currentWeapon",
          timestamp: Date.now() - 2000,
        },
      ],
      truncated: false,
      bufferSize: 2,
    }),

    "compile.status": () => ({
      isCompiling: false,
      hasErrors: false,
      errorCount: 0,
      warningCount: 0,
      errors: [],
    }),
    "asset.refresh": () => ({
      isCompiling: false,
      hasErrors: false,
      errorCount: 0,
      warningCount: 0,
      errors: [],
    }),
    // Long-poll await: mock settles immediately with the idle status.
    "compile.await": () => ({
      isCompiling: false,
      hasErrors: false,
      errorCount: 0,
      warningCount: 0,
      errors: [],
      settled: true,
    }),

    "screenshot.gameView": () => {
      const img = makeMockPng(512, 288, [40, 100, 180], "MOCK GAME VIEW");
      return {
        source: "game_view",
        width: img.width,
        height: img.height,
        mimeType: "image/png",
        pngBase64: img.pngBase64,
        cameraName: "Main Camera (mock)",
        subject: "Camera.main",
      };
    },
    "screenshot.sceneView": () => {
      const img = makeMockPng(512, 288, [70, 150, 90], "MOCK SCENE VIEW");
      return {
        source: "scene_view",
        width: img.width,
        height: img.height,
        mimeType: "image/png",
        pngBase64: img.pngBase64,
        cameraName: "SceneView (mock)",
        subject: "SceneView.lastActiveSceneView",
      };
    },
    "screenshot.selected": () => {
      const img = makeMockPng(384, 384, [180, 100, 40], "MOCK SELECTED");
      return {
        source: "selected_object",
        width: img.width,
        height: img.height,
        mimeType: "image/png",
        pngBase64: img.pngBase64,
        cameraName: "TempCamera",
        subject: "/Gameplay/Player",
      };
    },
    "screenshot.editorWindow": () => {
      const img = makeMockPng(640, 400, [50, 55, 65], "MOCK EDITOR WINDOW");
      return {
        source: "editor_window",
        width: img.width,
        height: img.height,
        mimeType: "image/png",
        pngBase64: img.pngBase64,
        cameraName: "EditorWindow",
        subject: "Unity Editor main window",
      };
    },

    "perf.sample": () => ({
      isPlaying: true,
      warmingUp: false,
      mainThreadMs: 6.4,
      estimatedFps: 156.25,
      counters: [
        { name: "Main Thread", category: "Internal", average: 6_400_000, last: 6_300_000, min: 5_900_000, max: 7_100_000, unit: "ns", sampleCount: 90 },
        { name: "Draw Calls Count", category: "Render", average: 142, last: 140, min: 130, max: 160, unit: "count", sampleCount: 90 },
        { name: "Batches Count", category: "Render", average: 98, last: 97, min: 90, max: 110, unit: "count", sampleCount: 90 },
        { name: "SetPass Calls Count", category: "Render", average: 61, last: 60, min: 55, max: 70, unit: "count", sampleCount: 90 },
        { name: "Triangles Count", category: "Render", average: 254_000, last: 251_000, min: 240_000, max: 270_000, unit: "count", sampleCount: 90 },
        { name: "GC Allocated In Frame", category: "Memory", average: 2048, last: 1024, min: 0, max: 8192, unit: "bytes", sampleCount: 90 },
        { name: "System Used Memory", category: "Memory", average: 412_000_000, last: 412_000_000, min: 410_000_000, max: 415_000_000, unit: "bytes", sampleCount: 90 },
      ],
    }),

    "test.run": () => ({ runId: "mockrun", state: "running", mode: "EditMode" }),
    "test.status": () => ({
      runId: "mockrun",
      state: "completed",
      mode: "EditMode",
      total: 3,
      passed: 2,
      failed: 1,
      skipped: 0,
      durationSec: 0.42,
      results: [
        { name: "Adds_TwoNumbers", fullName: "Calc.Adds_TwoNumbers", status: "Passed", durationSec: 0.01 },
        { name: "Handles_Zero", fullName: "Calc.Handles_Zero", status: "Passed", durationSec: 0.01 },
        {
          name: "Divides_ByZero",
          fullName: "Calc.Divides_ByZero",
          status: "Failed",
          durationSec: 0.02,
          message: "Expected: throws DivideByZeroException But was: 0",
          stackTrace: "at Calc.Divide (Calc.cs:14)",
        },
      ],
    }),
    "test.cancel": () => ({ runId: "mockrun", state: "cancelled" }),
    "test.await": () => ({
      runId: "mockrun",
      state: "completed",
      mode: "EditMode",
      total: 3,
      passed: 2,
      failed: 1,
      skipped: 0,
      durationSec: 0.42,
      results: [],
      settled: true,
    }),

    "playmode.enter": () => ({ isPlaying: true, isPaused: false, isTransitioning: false, frameCount: 1, timeScale: 1 }),
    "playmode.exit": () => ({ isPlaying: false, isPaused: false, isTransitioning: false, timeScale: 1 }),
    "playmode.step": () => ({ isPlaying: true, isPaused: true, frameCount: 2, framesStepped: 1, stepping: false, settled: true, timeScale: 1 }),
    "playmode.status": () => ({ isPlaying: true, isPaused: false, isTransitioning: false, frameCount: 42, timeSinceLevelLoad: 0.7, timeScale: 1 }),
    "playmode.configure": () => ({ isPlaying: true, isPaused: true, isTransitioning: false, frameCount: 42, timeSinceLevelLoad: 0.7, timeScale: 0.5 }),
    "playmode.await": () => ({ isPlaying: true, isPaused: false, isTransitioning: false, frameCount: 42, settled: true, timeScale: 1 }),

    "runtime.findObjects": () => ({
      isPlaying: true,
      query: "",
      matchCount: 2,
      objects: [
        { name: "Player", path: "/Gameplay/Player", instanceId: 1234, activeInHierarchy: true, components: ["Transform", "PlayerController", "Rigidbody"] },
        { name: "Enemy(Clone)", path: "/Enemy(Clone)", instanceId: 5678, activeInHierarchy: true, components: ["Transform", "EnemyAI"] },
      ],
      truncated: false,
    }),
    "runtime.inspect": () => ({
      isPlaying: true,
      selected: {
        name: "Player",
        path: "/Gameplay/Player",
        instanceId: 1234,
        activeSelf: true,
        activeInHierarchy: true,
        tag: "Player",
        layer: "Default",
        scene: "Assets/Scenes/Sample.unity",
        transform: {
          position: { x: 3.2, y: 0, z: -1.5 },
          rotation: { x: 0, y: 90, z: 0 },
          localScale: { x: 1, y: 1, z: 1 },
        },
        components: [
          { type: "PlayerController", assembly: "Assembly-CSharp", enabled: true, fields: { health: 72, moveSpeed: 7.5 } },
        ],
      },
    }),
    "runtime.setField": () => ({
      applied: true,
      changed: true,
      summary: "Set runtime-only PlayerController.moveSpeed on /Gameplay/Player",
      target: "/Gameplay/Player",
      runtimeOnly: true,
      undoable: false,
    }),

    "asset.findMissingScripts": () => ({
      scanned: 12,
      hits: [{ assetPath: "Assets/Prefabs/Enemy.prefab", objectPath: "/Enemy/AI", missingCount: 1 }],
      truncated: false,
    }),
    "asset.findMissingReferences": () => ({
      scanned: 12,
      hits: [{ assetPath: "Assets/Scenes/Sample.unity", objectPath: "/Gameplay/Player", component: "PlayerController", field: "currentWeapon" }],
      truncated: false,
    }),
    "asset.findReferences": () => ({
      asset: { path: "Assets/Prefabs/Player.prefab", guid: "abc123", type: "GameObject" },
      direction: "references",
      count: 1,
      assets: [{ path: "Assets/Scenes/Sample.unity", guid: "def456", type: "SceneAsset" }],
      truncated: false,
    }),
    "asset.findDependencies": () => ({
      asset: { path: "Assets/Prefabs/Player.prefab", guid: "abc123", type: "GameObject" },
      direction: "dependencies",
      recursive: true,
      count: 2,
      assets: [
        { path: "Assets/Scripts/PlayerController.cs", guid: "ghi789", type: "MonoScript" },
        { path: "Assets/Materials/Player.mat", guid: "jkl012", type: "Material" },
      ],
      truncated: false,
    }),

    "edit.setSerializedField": () => ({
      applied: true,
      summary: "Set PlayerController.moveSpeed on /Gameplay/Player",
      target: "/Gameplay/Player",
      sceneDirtied: "Assets/Scenes/Sample.unity",
      undoable: true,
    }),
    "edit.addComponent": () => ({
      applied: true,
      summary: "Added Rigidbody to /Gameplay/Player",
      target: "/Gameplay/Player",
      sceneDirtied: "Assets/Scenes/Sample.unity",
      undoable: true,
    }),
    "edit.createGameObject": () => ({
      applied: true,
      summary: "Created GameObject 'NewObject'",
      createdPath: "/NewObject",
      sceneDirtied: "Assets/Scenes/Sample.unity",
      undoable: true,
    }),
    "edit.saveScene": () => ({
      applied: true,
      summary: "Saved scene Assets/Scenes/Sample.unity",
      target: "Assets/Scenes/Sample.unity",
    }),
    "edit.assignReference": () => ({
      applied: true,
      summary: "Assigned PlayerController.currentWeapon = Sword on /Gameplay/Player",
      target: "/Gameplay/Player",
      sceneDirtied: "Assets/Scenes/Sample.unity",
      undoable: true,
    }),
    "edit.wireUiButton": () => ({
      applied: true,
      summary: "Wired /Canvas/PlayButton Button.onClick -> GameManager.StartGame()",
      target: "/Canvas/PlayButton",
      sceneDirtied: "Assets/Scenes/Sample.unity",
      undoable: true,
    }),
    "edit.instantiatePrefab": () => ({
      applied: true,
      summary: "Instantiated prefab 'Enemy' into the scene",
      createdPath: "/Enemy",
      sceneDirtied: "Assets/Scenes/Sample.unity",
      undoable: true,
    }),
    "edit.createScriptableObject": () => ({
      applied: true,
      summary: "Created WeaponData asset at Assets/Data/NewWeapon.asset",
      createdPath: "Assets/Data/NewWeapon.asset",
      undoable: false,
    }),
    "edit.createMaterial": () => ({
      applied: true,
      summary: "Created material with shader 'Universal Render Pipeline/Lit' at Assets/Materials/New.mat",
      createdPath: "Assets/Materials/New.mat",
      undoable: false,
    }),
    "edit.createPrefabVariant": () => ({
      applied: true,
      summary: "Created prefab variant of 'Enemy' at Assets/Prefabs/EliteEnemy.prefab",
      createdPath: "Assets/Prefabs/EliteEnemy.prefab",
      undoable: false,
    }),
    "edit.deleteGameObject": () => ({
      applied: true,
      summary: "Deleted GameObject '/Gameplay/Enemy'",
      target: "/Gameplay/Enemy",
      sceneDirtied: "Assets/Scenes/Sample.unity",
      undoable: true,
    }),
    "edit.removeComponent": () => ({
      applied: true,
      summary: "Removed Rigidbody from /Gameplay/Player",
      target: "/Gameplay/Player",
      sceneDirtied: "Assets/Scenes/Sample.unity",
      undoable: true,
    }),
    "edit.deleteAsset": () => ({
      applied: true,
      summary: "Deleted asset Assets/Prefabs/Enemy.prefab (moved to OS trash)",
      target: "Assets/Prefabs/Enemy.prefab",
      undoable: false,
    }),
    "console.clear": () => ({
      applied: true,
      summary: "Cleared 7 buffered log(s) and the Unity console",
    }),

    "scene.open": () => ({
      opened: "Assets/Scenes/Level1.unity",
      scenes: [
        { path: "Assets/Scenes/Level1.unity", name: "Level1", isLoaded: true, isDirty: false, rootCount: 5, buildIndex: 1 },
      ],
      activeScene: "Assets/Scenes/Level1.unity",
    }),
    "scene.loadAdditive": () => ({
      opened: "Assets/Scenes/UI.unity",
      scenes: [
        { path: "Assets/Scenes/Sample.unity", name: "Sample", isLoaded: true, isDirty: false, rootCount: 4, buildIndex: 0 },
        { path: "Assets/Scenes/UI.unity", name: "UI", isLoaded: true, isDirty: false, rootCount: 2, buildIndex: 2 },
      ],
      activeScene: "Assets/Scenes/Sample.unity",
    }),

    "prefab.open": () => ({
      opened: true,
      assetPath: "Assets/Prefabs/Player.prefab",
      rootName: "Player",
      inPrefabMode: true,
    }),
    "prefab.save": () => ({
      applied: true,
      summary: "Saved prefab Assets/Prefabs/Player.prefab",
      target: "Assets/Prefabs/Player.prefab",
      undoable: false,
    }),
    "prefab.applyInstance": () => ({
      applied: true,
      summary: "Applied overrides on /Gameplay/Player to Assets/Prefabs/Player.prefab",
      target: "Assets/Prefabs/Player.prefab",
      undoable: false,
    }),

    "input.simulate": () => ({
      simulated: true,
      control: "<Keyboard>/space",
      action: "press",
      backend: "InputSystem",
      isPlaying: true,
    }),
    "animator.getState": () => ({
      isPlaying: true,
      animator: "/Gameplay/Player",
      layers: [
        { index: 0, name: "Base Layer", currentState: "Run", normalizedTime: 0.42, speed: 1, clips: ["Run"] },
      ],
      parameters: [
        { name: "Speed", type: "Float", value: 5.2 },
        { name: "Jump", type: "Trigger", value: false },
      ],
    }),
    "animator.setParameter": () => ({
      applied: true,
      summary: "Set Animator parameter 'Speed' = 5.2 on /Gameplay/Player",
      target: "/Gameplay/Player",
    }),
    "animator.editTransition": () => ({
      applied: true,
      summary: "Updated transition Run -> Idle on Assets/Animation/Crow.controller",
      target: "Assets/Animation/Crow.controller",
      undoable: false,
    }),

    "editor.executeMenuItem": () => ({
      applied: true,
      executed: true,
      summary: "Executed menu item 'Assets/Refresh'",
      menuItem: "Assets/Refresh",
    }),

    "script.read": () => ({
      path: "Assets/Scripts/PlayerController.cs",
      contents: "using UnityEngine;\n\npublic class PlayerController : MonoBehaviour\n{\n    public float moveSpeed = 7.5f;\n\n    void Update()\n    {\n        // mock body\n    }\n}\n",
      sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      lineCount: 11,
      sizeBytes: 160,
      truncated: false,
    }),
    "script.getSha": () => ({
      path: "Assets/Scripts/PlayerController.cs",
      exists: true,
      sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      sizeBytes: 160,
      lineCount: 11,
    }),
    "script.findInFile": () => ({
      path: "Assets/Scripts/PlayerController.cs",
      pattern: "moveSpeed",
      matchCount: 1,
      matches: [{ line: 5, column: 18, match: "moveSpeed", lineText: "    public float moveSpeed = 7.5f;" }],
      truncated: false,
    }),
    "script.create": () => ({
      applied: true,
      summary: "Created script Assets/Scripts/Enemy.cs (12 lines)",
      path: "Assets/Scripts/Enemy.cs",
      createdPath: "Assets/Scripts/Enemy.cs",
      sha256After: "1111111111111111111111111111111111111111111111111111111111111111",
      changed: true,
      undoable: false,
    }),
    "script.applyEdits": () => ({
      applied: true,
      summary: "Applied 1 text edit(s) to Assets/Scripts/PlayerController.cs",
      path: "Assets/Scripts/PlayerController.cs",
      sha256Before: "0000000000000000000000000000000000000000000000000000000000000000",
      sha256After: "2222222222222222222222222222222222222222222222222222222222222222",
      changed: true,
      editCount: 1,
      undoable: false,
    }),
    "script.applyStructuredEdits": () => ({
      applied: true,
      summary: "Applied 1 structured edit(s) to Assets/Scripts/PlayerController.cs",
      path: "Assets/Scripts/PlayerController.cs",
      sha256Before: "0000000000000000000000000000000000000000000000000000000000000000",
      sha256After: "3333333333333333333333333333333333333333333333333333333333333333",
      changed: true,
      editCount: 1,
      undoable: false,
    }),

    "code.execute": () => ({
      compiled: true,
      executed: true,
      errorCount: 0,
      warnings: [],
      returnType: "Int32",
      returnValue: "42",
      logs: [{ type: "Log", message: "mock snippet ran" }],
      summary: "Compiled and executed; returned Int32.",
    }),

    "reflect.query": () => ({
      query: "Rigidbody",
      scope: "all",
      matchCount: 1,
      types: [
        { name: "Rigidbody", fullName: "UnityEngine.Rigidbody", namespace: "UnityEngine", kind: "class", assembly: "UnityEngine.PhysicsModule" },
      ],
      truncated: false,
    }),

    "asset.import": () => ({
      applied: true,
      summary: "Imported Assets/Art/hero.png",
      createdPath: "Assets/Art/hero.png",
      target: "Assets/Art/hero.png",
      undoable: false,
    }),
    "asset.sliceSprite": () => ({
      applied: true,
      summary: "Sliced Assets/Art/tiles.png into 16 sprites (4x4 grid)",
      target: "Assets/Art/tiles.png",
      spriteCount: 16,
      undoable: false,
    }),

    "edit.setTransform": () => ({
      applied: true,
      summary: "Set transform on /Gameplay/Player (position)",
      target: "/Gameplay/Player",
      sceneDirtied: "Assets/Scenes/Sample.unity",
      undoable: true,
    }),
    "edit.reparent": () => ({
      applied: true,
      summary: "Reparented /Gameplay/Player under /Gameplay/Container",
      target: "/Gameplay/Container/Player",
      sceneDirtied: "Assets/Scenes/Sample.unity",
      undoable: true,
    }),
    "edit.paintTilemap": () => ({
      applied: true,
      summary: "Painted 9 cell(s) on /Grid/Tilemap with Grass",
      target: "/Grid/Tilemap",
      cellsAffected: 9,
      sceneDirtied: "Assets/Scenes/Sample.unity",
      undoable: true,
    }),
  };

  async function call<T>(
    method: BridgeMethod,
    _params: Record<string, unknown> = {}
  ): Promise<BridgeResponse<T>> {
    const responder = responders[method];
    if (!responder) {
      return {
        id: "mock",
        ok: false,
        result: null,
        error: {
          code: "TOOL_NOT_IMPLEMENTED",
          message: `Mock bridge has no responder for ${method}`,
        },
        meta: {},
      };
    }
    return {
      id: "mock",
      ok: true,
      result: responder() as T,
      error: null,
      meta,
    };
  }

  async function isConnected(): Promise<boolean> {
    return true;
  }

  async function health() {
    return {
      status: "ok",
      unityVersion: meta.unityVersion,
      projectPath: meta.projectPath,
      uptimeMs: 12345,
      editorTickAgeMs: 16,
      keepAwakeEnabled: true,
      wasFocused: true,
      isCompiling: false,
      isPlaying: false,
    };
  }

  return { source: "mock", call, isConnected, health };
}
