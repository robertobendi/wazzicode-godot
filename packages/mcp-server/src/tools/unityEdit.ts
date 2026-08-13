import { z } from "zod";
import { ToolDef } from "../registry.js";
import { BRIDGE_METHODS, bridgeCall } from "./_helpers.js";
import { EditResult } from "@uvibe/core";

/**
 * Write tools. Each is marked `write: true` so the MCP server gates it behind
 * `.unity-vibe/config.json#safetyMode` and records it to the action log. The Unity side wraps
 * every mutation in the Editor Undo system, so the user can Ctrl+Z anything Claude does.
 */

const SetFieldShape = {
  component: z.string().describe("Component type name on the target, e.g. 'Rigidbody'."),
  field: z.string().describe("Serialized property path, e.g. 'm_Mass' or 'moveSpeed'."),
  value: z
    .unknown()
    .describe(
      "New value, shaped to the field type. Primitives for int/float/bool/string; enum name or index for enums; " +
        "{x,y,z}/{r,g,b,a}/{x,y,z,w} (or positional arrays) for vectors/colors; {x,y,z} euler or {x,y,z,w} for quaternions; " +
        "{x,y} / {x,y,z} for int-vectors; {x,y,width,height} for Rect/RectInt; {center,size} for Bounds, {position,size} for BoundsInt; " +
        "a layer name, array of layer names, or bitmask for LayerMask; {path|guid} for object references. " +
        "Custom serializable structs take a nested object keyed by sub-field names; arrays/lists take a JSON array (recursively)."
    ),
  instanceId: z.number().int().optional().describe("Target by instanceId (preferred)."),
  path: z.string().optional().describe("Target by hierarchy path; falls back to current selection if neither given."),
};

export const unitySetSerializedField: ToolDef<typeof SetFieldShape, EditResult> = {
  name: "unity_set_serialized_field",
  description:
    "Sets a serialized field on a component of a scene GameObject (via SerializedObject), recorded as an Undo step. Gated by safetyMode (requires confirm/autopilot + allowSceneWrites). Marks the scene dirty; call unity_save_scene to persist.",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: SetFieldShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.editSetSerializedField, {
      component: args.component,
      field: args.field,
      value: args.value,
      instanceId: args.instanceId ?? 0,
      path: args.path,
    });
  },
};

const AddComponentShape = {
  component: z.string().describe("Component type name to add, e.g. 'Rigidbody' or full type name."),
  instanceId: z.number().int().optional(),
  path: z.string().optional(),
};

export const unityAddComponent: ToolDef<typeof AddComponentShape, EditResult> = {
  name: "unity_add_component",
  description:
    "Adds a component to a scene GameObject (Undo.AddComponent). Gated by safetyMode (confirm/autopilot + allowSceneWrites). Marks the scene dirty.",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: AddComponentShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.editAddComponent, {
      component: args.component,
      instanceId: args.instanceId ?? 0,
      path: args.path,
    });
  },
};

const CreateGoShape = {
  name: z.string().optional(),
  primitive: z
    .enum(["Cube", "Sphere", "Capsule", "Cylinder", "Plane", "Quad"])
    .optional()
    .describe("Create a primitive instead of an empty GameObject."),
  parentPath: z.string().optional().describe("Hierarchy path of the parent to nest under."),
};

export const unityCreateGameObject: ToolDef<typeof CreateGoShape, EditResult> = {
  name: "unity_create_gameobject",
  description:
    "Creates a new GameObject (empty or a primitive) in the active scene, optionally parented, recorded as an Undo step. Gated by safetyMode (confirm/autopilot + allowSceneWrites).",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: CreateGoShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.editCreateGameObject, {
      name: args.name,
      primitive: args.primitive,
      parentPath: args.parentPath,
    });
  },
};

const DeleteGoShape = {
  instanceId: z.number().int().optional().describe("Target GameObject by instanceId (preferred)."),
  path: z.string().optional().describe("Target GameObject by hierarchy path; falls back to current selection if neither given."),
};

export const unityDeleteGameObject: ToolDef<typeof DeleteGoShape, EditResult> = {
  name: "unity_delete_gameobject",
  description:
    "Deletes a GameObject (and its children) from the active scene, recorded as an Undo step (Ctrl+Z restores it). Target by instanceId, hierarchy path, or current selection. Gated by safetyMode (confirm/autopilot + allowSceneWrites). Marks the scene dirty.",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: DeleteGoShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.editDeleteGameObject, {
      instanceId: args.instanceId ?? 0,
      path: args.path,
    });
  },
};

const RemoveComponentShape = {
  component: z.string().describe("Component type name to remove, e.g. 'Rigidbody'."),
  instanceId: z.number().int().optional(),
  path: z.string().optional(),
};

export const unityRemoveComponent: ToolDef<typeof RemoveComponentShape, EditResult> = {
  name: "unity_remove_component",
  description:
    "Removes a component from a scene GameObject (Undo.DestroyObjectImmediate; Ctrl+Z restores it). Refuses to remove the Transform. Gated by safetyMode (confirm/autopilot + allowSceneWrites). Marks the scene dirty.",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: RemoveComponentShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.editRemoveComponent, {
      component: args.component,
      instanceId: args.instanceId ?? 0,
      path: args.path,
    });
  },
};

const DeleteAssetShape = {
  path: z.string().optional().describe("Asset path under Assets/, e.g. 'Assets/Prefabs/Enemy.prefab'."),
  guid: z.string().optional().describe("Asset by GUID (alternative to path)."),
  permanent: z
    .boolean()
    .optional()
    .describe("Delete permanently instead of moving to the OS trash (default false — trash is recoverable)."),
};

export const unityDeleteAsset: ToolDef<typeof DeleteAssetShape, EditResult> = {
  name: "unity_delete_asset",
  description:
    "Deletes an asset file from the project. Defaults to moving it to the OS trash (recoverable); set permanent:true to remove it outright. Not Unity-Undoable — recover via the OS trash or git. Gated by safetyMode (confirm/autopilot + allowAssetWrites; asset target).",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "asset",
  inputShape: DeleteAssetShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.editDeleteAsset, {
      path: args.path,
      guid: args.guid,
      permanent: args.permanent,
    });
  },
};

const SaveSceneShape = {
  scenePath: z.string().optional().describe("Scene to save; defaults to the active scene."),
};

export const unitySaveScene: ToolDef<typeof SaveSceneShape, EditResult> = {
  name: "unity_save_scene",
  description:
    "Saves an open scene to disk. Gated by safetyMode (confirm/autopilot + allowSceneWrites). When autoSnapshot is enabled the scene file is snapshotted to .unity-vibe/snapshots before saving.",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: SaveSceneShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.editSaveScene, {
      scenePath: args.scenePath,
    });
  },
};

const AssignRefShape = {
  component: z.string().describe("Component type name on the target whose field to set."),
  field: z.string().describe("Object-reference field/property path on that component."),
  instanceId: z.number().int().optional().describe("Target object by instanceId."),
  path: z.string().optional().describe("Target object by hierarchy path (or current selection)."),
  sourceInstanceId: z.number().int().optional().describe("Source scene object/component by instanceId."),
  sourcePath: z.string().optional().describe("Source scene object by hierarchy path."),
  sourceComponent: z.string().optional().describe("Pick this component off the source object instead of the GameObject."),
  sourceAssetPath: z.string().optional().describe("Source asset by project path (e.g. a Material/ScriptableObject)."),
  sourceGuid: z.string().optional().describe("Source asset by GUID."),
};

export const unityAssignReference: ToolDef<typeof AssignRefShape, EditResult> = {
  name: "unity_assign_reference",
  description:
    "Wires an object-reference field on a component to a source object or asset (e.g. assign a Material, a ScriptableObject, or another scene object/component). Verifies type compatibility and reports a mismatch instead of silently dropping it. Undo-wrapped; gated by safetyMode (confirm/autopilot + allowSceneWrites).",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: AssignRefShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.editAssignReference, { ...args });
  },
};

const WireButtonShape = {
  instanceId: z.number().int().optional().describe("Button GameObject by instanceId."),
  path: z.string().optional().describe("Button GameObject by hierarchy path (or current selection)."),
  handlerInstanceId: z.number().int().optional().describe("Handler component/object by instanceId."),
  handlerPath: z.string().optional().describe("Handler GameObject by hierarchy path (defaults to the button object)."),
  handlerComponent: z.string().describe("Component on the handler object whose method to call."),
  method: z.string().describe("Public void no-arg method name to invoke on click."),
};

export const unityWireUiButton: ToolDef<typeof WireButtonShape, EditResult> = {
  name: "unity_wire_ui_button",
  description:
    "Adds a persistent onClick listener to a UnityEngine.UI.Button, calling a public void method on a target component. UGUI is accessed reflectively so this compiles without the package; returns OBJECT_NOT_FOUND if no Button is present. Undo-wrapped; gated by safetyMode (confirm/autopilot + allowSceneWrites).",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: WireButtonShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.editWireUiButton, { ...args });
  },
};

const InstantiatePrefabShape = {
  prefabPath: z.string().optional().describe("Prefab asset path, e.g. 'Assets/Prefabs/Enemy.prefab'."),
  prefabGuid: z.string().optional().describe("Prefab by GUID (alternative to prefabPath)."),
  parentPath: z.string().optional().describe("Hierarchy path to parent the instance under."),
  name: z.string().optional().describe("Override the instance's name."),
};

export const unityInstantiatePrefab: ToolDef<typeof InstantiatePrefabShape, EditResult> = {
  name: "unity_instantiate_prefab",
  description:
    "Instantiates a prefab into the active scene (PrefabUtility.InstantiatePrefab), optionally parented and renamed, as a linked prefab instance. Undo-wrapped; gated by safetyMode (confirm/autopilot + allowSceneWrites).",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "scene",
  inputShape: InstantiatePrefabShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.editInstantiatePrefab, { ...args });
  },
};

const CreateSoShape = {
  type: z.string().describe("ScriptableObject type name, e.g. 'WeaponData'."),
  path: z.string().describe("Asset path under Assets/, ending in .asset."),
};

export const unityCreateScriptableObject: ToolDef<typeof CreateSoShape, EditResult> = {
  name: "unity_create_scriptable_object",
  description:
    "Creates a ScriptableObject asset of the given type at a path under Assets/ (path made unique if needed). Gated by safetyMode (confirm/autopilot; asset target). Set its fields afterwards with unity_set_serialized_field / unity_assign_reference.",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "asset",
  inputShape: CreateSoShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.editCreateScriptableObject, {
      type: args.type,
      path: args.path,
    });
  },
};

const CreateMatShape = {
  path: z.string().describe("Asset path under Assets/, ending in .mat."),
  shader: z.string().optional().describe("Shader name; defaults to the active pipeline's Lit/Standard shader."),
};

export const unityCreateMaterial: ToolDef<typeof CreateMatShape, EditResult> = {
  name: "unity_create_material",
  description:
    "Creates a Material asset at a path under Assets/, using the named shader (or a sensible pipeline default). Gated by safetyMode (confirm/autopilot; asset target).",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "asset",
  inputShape: CreateMatShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.editCreateMaterial, {
      path: args.path,
      shader: args.shader,
    });
  },
};

const CreateVariantShape = {
  sourcePath: z.string().optional().describe("Base prefab asset path."),
  sourceGuid: z.string().optional().describe("Base prefab by GUID."),
  path: z.string().describe("Variant asset path under Assets/, ending in .prefab."),
};

export const unityCreatePrefabVariant: ToolDef<typeof CreateVariantShape, EditResult> = {
  name: "unity_create_prefab_variant",
  description:
    "Creates a prefab variant of an existing prefab at a new path under Assets/. Gated by safetyMode (confirm/autopilot + allowPrefabWrites; prefab target).",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "prefab",
  inputShape: CreateVariantShape,
  async run(args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.editCreatePrefabVariant, { ...args });
  },
};

const ClearConsoleShape = {};

export const unityClearConsole: ToolDef<typeof ClearConsoleShape, EditResult> = {
  name: "unity_clear_console",
  description:
    "Clears the Unity Editor console and the bridge's captured log buffer — useful to reset before a fresh repro so unity_get_console_logs only shows new output. Gated by safetyMode (confirm/autopilot; console target).",
  requires: ["unity_bridge"],
  write: true,
  writeTarget: "console",
  inputShape: ClearConsoleShape,
  async run(_args, ctx) {
    return bridgeCall<EditResult>(ctx.bridge, BRIDGE_METHODS.consoleClear, {});
  },
};
