using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using static UnityVibeOS.BridgeParams;

namespace UnityVibeOS
{
    /// <summary>
    /// Write operations on scene/GameObject state. Every mutation goes through Unity's Undo
    /// system so the user can Ctrl+Z, and marks the owning scene dirty (the caller decides when
    /// to save). The MCP layer gates these behind safetyMode; the bridge itself trusts the call.
    /// </summary>
    public static class Mutators
    {
        public static IDictionary<string, object> SetSerializedField(IDictionary<string, object> p)
        {
            var go = RequireTarget(p);
            string componentName = Str(p, "component");
            string field = Str(p, "field");
            if (string.IsNullOrEmpty(componentName)) throw Invalid("Missing 'component'.");
            if (string.IsNullOrEmpty(field)) throw Invalid("Missing 'field'.");
            if (!p.TryGetValue("value", out var value)) throw Invalid("Missing 'value'.");

            Component comp = null;
            foreach (var c in go.GetComponents<Component>())
            {
                if (c != null && c.GetType().Name == componentName) { comp = c; break; }
            }
            if (comp == null) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"Component '{componentName}' not found on '{go.name}'.");

            var so = new SerializedObject(comp);
            var prop = so.FindProperty(field);
            if (prop == null) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"Field '{field}' not found on '{componentName}'.");

            Undo.RecordObject(comp, $"UnityVibeOS set {componentName}.{field}");
            SetPropertyValue(prop, value);
            so.ApplyModifiedProperties();
            EditorUtility.SetDirty(comp);
            string dirtied = MarkDirty(go);

            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", $"Set {componentName}.{field} on {SceneInspector.PathOf(go)}" },
                { "target", SceneInspector.PathOf(go) },
                { "sceneDirtied", dirtied },
                { "undoable", true }
            };
        }

        public static IDictionary<string, object> AddComponent(IDictionary<string, object> p)
        {
            var go = RequireTarget(p);
            string componentName = Str(p, "component");
            if (string.IsNullOrEmpty(componentName)) throw Invalid("Missing 'component'.");

            Type type = null;
            foreach (var t in TypeCache.GetTypesDerivedFrom<Component>())
            {
                if (t.Name == componentName || t.FullName == componentName) { type = t; break; }
            }
            if (type == null) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"Component type '{componentName}' not found.");

            var added = Undo.AddComponent(go, type);
            string dirtied = MarkDirty(go);
            return new Dictionary<string, object>
            {
                { "applied", added != null },
                { "summary", $"Added {componentName} to {SceneInspector.PathOf(go)}" },
                { "target", SceneInspector.PathOf(go) },
                { "sceneDirtied", dirtied },
                { "undoable", true }
            };
        }

        public static IDictionary<string, object> CreateGameObject(IDictionary<string, object> p)
        {
            string name = Str(p, "name");
            if (string.IsNullOrEmpty(name)) name = "GameObject";
            string primitive = Str(p, "primitive"); // optional: Cube/Sphere/etc.
            string parentPath = Str(p, "parentPath");

            GameObject go;
            if (!string.IsNullOrEmpty(primitive) && Enum.TryParse<PrimitiveType>(primitive, true, out var pt))
            {
                go = GameObject.CreatePrimitive(pt);
                go.name = name;
            }
            else
            {
                go = new GameObject(name);
            }

            if (!string.IsNullOrEmpty(parentPath))
            {
                var parent = FindByPath(parentPath);
                if (parent == null)
                {
                    UnityEngine.Object.DestroyImmediate(go);
                    throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"Parent '{parentPath}' not found.");
                }
                go.transform.SetParent(parent.transform, false);
            }

            Undo.RegisterCreatedObjectUndo(go, $"UnityVibeOS create {name}");
            string dirtied = MarkDirty(go);
            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", $"Created GameObject '{name}'" },
                { "createdPath", SceneInspector.PathOf(go) },
                { "sceneDirtied", dirtied },
                { "undoable", true }
            };
        }

        public static IDictionary<string, object> DeleteGameObject(IDictionary<string, object> p)
        {
            var go = RequireTarget(p);
            string path = SceneInspector.PathOf(go);
            // Capture the dirtied scene before the object (and its scene reference) is destroyed.
            string dirtied = MarkDirty(go);
            Undo.DestroyObjectImmediate(go);
            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", $"Deleted GameObject '{path}'" },
                { "target", path },
                { "sceneDirtied", dirtied },
                { "undoable", true }
            };
        }

        public static IDictionary<string, object> RemoveComponent(IDictionary<string, object> p)
        {
            var go = RequireTarget(p);
            string componentName = Str(p, "component");
            if (string.IsNullOrEmpty(componentName)) throw Invalid("Missing 'component'.");
            var comp = FindComponent(go, componentName); // throws OBJECT_NOT_FOUND if absent
            if (comp is Transform)
                throw Invalid("Cannot remove the Transform component — every GameObject must have one.");

            string path = SceneInspector.PathOf(go);
            Undo.DestroyObjectImmediate(comp);
            string dirtied = MarkDirty(go);
            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", $"Removed {componentName} from {path}" },
                { "target", path },
                { "sceneDirtied", dirtied },
                { "undoable", true }
            };
        }

        public static IDictionary<string, object> SaveScene(IDictionary<string, object> p)
        {
            string scenePath = Str(p, "scenePath");
            bool saved;
            string savedPath;
            if (!string.IsNullOrEmpty(scenePath))
            {
                var scene = SceneManager.GetSceneByPath(scenePath);
                if (!scene.IsValid() || !scene.isLoaded)
                    throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"Scene '{scenePath}' is not open.");
                saved = EditorSceneManager.SaveScene(scene);
                savedPath = scene.path;
            }
            else
            {
                var active = SceneManager.GetActiveScene();
                saved = EditorSceneManager.SaveScene(active);
                savedPath = active.path;
            }
            return new Dictionary<string, object>
            {
                { "applied", saved },
                { "summary", saved ? $"Saved scene {savedPath}" : $"Save failed for {savedPath}" },
                { "target", savedPath }
            };
        }

        public static IDictionary<string, object> AssignReference(IDictionary<string, object> p)
        {
            var go = RequireTarget(p);
            string componentName = Str(p, "component");
            string field = Str(p, "field");
            if (string.IsNullOrEmpty(componentName)) throw Invalid("Missing 'component'.");
            if (string.IsNullOrEmpty(field)) throw Invalid("Missing 'field'.");

            var comp = FindComponent(go, componentName);
            var so = new SerializedObject(comp);
            var prop = so.FindProperty(field);
            if (prop == null) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"Field '{field}' not found on '{componentName}'.");
            if (prop.propertyType != SerializedPropertyType.ObjectReference)
                throw Invalid($"Field '{field}' is not an object reference ({prop.propertyType}). Use unity_set_serialized_field for value types.");

            var source = ResolveSource(p);
            Undo.RecordObject(comp, $"UnityVibeOS assign {componentName}.{field}");
            prop.objectReferenceValue = source;
            so.ApplyModifiedProperties();

            // Unity silently drops type-incompatible references; verify with a fresh read.
            var verify = new SerializedObject(comp).FindProperty(field);
            if (source != null && (verify == null || verify.objectReferenceValue == null))
                throw Invalid($"Type mismatch: '{source.GetType().Name}' is not assignable to '{componentName}.{field}'.");

            EditorUtility.SetDirty(comp);
            string dirtied = MarkDirty(go);
            return EditOk(
                $"Assigned {componentName}.{field} = {(source != null ? source.name : "null")} on {SceneInspector.PathOf(go)}",
                SceneInspector.PathOf(go), dirtied);
        }

        public static IDictionary<string, object> WireUiButton(IDictionary<string, object> p)
        {
            var buttonGo = RequireTarget(p);
            // Locate the Button component by full type name so we don't hard-reference UGUI.
            Component button = null;
            foreach (var c in buttonGo.GetComponents<Component>())
            {
                if (c != null && c.GetType().FullName == "UnityEngine.UI.Button") { button = c; break; }
            }
            if (button == null)
                throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND",
                    $"No UnityEngine.UI.Button on '{buttonGo.name}'. Is the UGUI package installed and is this the button object?");

            string method = Str(p, "method");
            if (string.IsNullOrEmpty(method)) throw Invalid("Missing 'method' (the handler method to call).");

            var handler = ResolveHandler(p, buttonGo);
            var methodInfo = handler.GetType().GetMethod(method, BindingFlags.Public | BindingFlags.Instance, null, Type.EmptyTypes, null);
            if (methodInfo == null || methodInfo.ReturnType != typeof(void))
                throw Invalid($"No public void {method}() on '{handler.GetType().Name}'.");

            var onClick = button.GetType().GetProperty("onClick")?.GetValue(button) as UnityEngine.Events.UnityEvent;
            if (onClick == null)
                throw new BridgeRouter.HandlerError("INTERNAL_ERROR", "Could not access Button.onClick.");

            var action = (UnityEngine.Events.UnityAction)Delegate.CreateDelegate(typeof(UnityEngine.Events.UnityAction), handler, methodInfo);
            Undo.RecordObject(button, $"UnityVibeOS wire Button.onClick -> {method}");
            UnityEditor.Events.UnityEventTools.AddPersistentListener(onClick, action);
            EditorUtility.SetDirty(button);
            string dirtied = MarkDirty(buttonGo);
            return EditOk(
                $"Wired {SceneInspector.PathOf(buttonGo)} Button.onClick -> {handler.GetType().Name}.{method}()",
                SceneInspector.PathOf(buttonGo), dirtied);
        }

        public static IDictionary<string, object> SetTransform(IDictionary<string, object> p)
        {
            var go = RequireTarget(p);
            var t = go.transform;
            bool world = string.Equals(Str(p, "space"), "world", StringComparison.OrdinalIgnoreCase);

            Undo.RecordObject(t, $"UnityVibeOS set transform {go.name}");
            var changed = new List<string>();
            if (TryVec3(p, "position", out var pos))
            {
                if (world) t.position = pos; else t.localPosition = pos;
                changed.Add("position");
            }
            if (TryVec3(p, "rotation", out var euler))
            {
                if (world) t.eulerAngles = euler; else t.localEulerAngles = euler;
                changed.Add("rotation");
            }
            if (TryVec3(p, "scale", out var scale))
            {
                t.localScale = scale; // scale is always local
                changed.Add("scale");
            }
            if (changed.Count == 0) throw Invalid("Nothing to set: provide position, rotation and/or scale.");

            EditorUtility.SetDirty(t);
            string dirtied = MarkDirty(go);
            return EditOk(
                $"Set transform ({string.Join(", ", changed)}; {(world ? "world" : "local")}) on {SceneInspector.PathOf(go)}",
                SceneInspector.PathOf(go), dirtied);
        }

        public static IDictionary<string, object> Reparent(IDictionary<string, object> p)
        {
            var go = RequireTarget(p);

            Transform newParent = null;
            int parentId = Int(p, "newParentInstanceId", 0);
            if (parentId != 0)
            {
                var parentGo = EditorCompat.IdToObject(parentId) as GameObject;
                if (parentGo == null) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"New parent instanceId {parentId} not found.");
                newParent = parentGo.transform;
            }
            else
            {
                string parentPath = Str(p, "newParentPath");
                if (!string.IsNullOrEmpty(parentPath))
                {
                    var parentGo = FindByPath(parentPath);
                    if (parentGo == null) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"New parent '{parentPath}' not found.");
                    newParent = parentGo.transform;
                }
                // else: no parent given → move to scene root.
            }

            if (newParent != null && (newParent == go.transform || newParent.IsChildOf(go.transform)))
                throw Invalid("Cannot reparent an object under itself or one of its descendants.");

            bool worldPositionStays = !p.ContainsKey("worldPositionStays") || Convert.ToBoolean(p["worldPositionStays"]);
            // 4-arg overload (Unity 2020.2+) registers the parent change for Undo while honouring
            // whether the world transform is preserved.
            Undo.SetTransformParent(go.transform, newParent, worldPositionStays, "UnityVibeOS reparent");

            if (p.TryGetValue("siblingIndex", out var siv) && siv != null)
            {
                int idx = (int)Convert.ToInt64(siv);
                Undo.RecordObject(go.transform, "UnityVibeOS sibling index");
                go.transform.SetSiblingIndex(idx);
            }

            string dirtied = MarkDirty(go);
            string parentDesc = newParent != null ? SceneInspector.PathOf(newParent.gameObject) : "(scene root)";
            return EditOk(
                $"Reparented {go.name} under {parentDesc}",
                SceneInspector.PathOf(go), dirtied);
        }

        // ---- helpers ----

        static bool TryVec3(IDictionary<string, object> p, string key, out Vector3 v)
        {
            v = Vector3.zero;
            if (p == null || !p.TryGetValue(key, out var raw) || !(raw is Dictionary<string, object>)) return false;
            // F(object, key) already reads x/y/z out of a Dictionary<string,object>.
            v = new Vector3(F(raw, "x"), F(raw, "y"), F(raw, "z"));
            return true;
        }

        static Component FindComponent(GameObject go, string name)
        {
            foreach (var c in go.GetComponents<Component>())
            {
                if (c != null && (c.GetType().Name == name || c.GetType().FullName == name)) return c;
            }
            throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"Component '{name}' not found on '{go.name}'.");
        }

        static UnityEngine.Object ResolveSource(IDictionary<string, object> p)
        {
            string assetPath = Str(p, "sourceAssetPath");
            string guid = Str(p, "sourceGuid");
            if (string.IsNullOrEmpty(assetPath) && !string.IsNullOrEmpty(guid)) assetPath = AssetDatabase.GUIDToAssetPath(guid);
            if (!string.IsNullOrEmpty(assetPath))
            {
                var asset = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(assetPath);
                if (asset == null) throw new BridgeRouter.HandlerError("ASSET_NOT_FOUND", $"No asset at '{assetPath}'.");
                return asset;
            }
            int sourceId = Int(p, "sourceInstanceId", 0);
            if (sourceId != 0)
            {
                var obj = EditorCompat.IdToObject(sourceId);
                if (obj == null) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"No object with instanceId {sourceId}.");
                if (obj is GameObject g) return MaybeComponent(p, g, obj);
                return obj; // a Component or asset reference
            }
            string sourcePath = Str(p, "sourcePath");
            if (!string.IsNullOrEmpty(sourcePath))
            {
                var srcGo = FindByPath(sourcePath);
                if (srcGo == null) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"Scene object '{sourcePath}' not found.");
                return MaybeComponent(p, srcGo, srcGo);
            }
            throw Invalid("No source given. Provide sourceAssetPath/sourceGuid (asset) or sourceInstanceId/sourcePath (scene), optionally sourceComponent.");
        }

        static UnityEngine.Object MaybeComponent(IDictionary<string, object> p, GameObject go, UnityEngine.Object fallback)
        {
            string sourceComponent = Str(p, "sourceComponent");
            return string.IsNullOrEmpty(sourceComponent) ? fallback : (UnityEngine.Object)FindComponent(go, sourceComponent);
        }

        static UnityEngine.Object ResolveHandler(IDictionary<string, object> p, GameObject fallback)
        {
            int id = Int(p, "handlerInstanceId", 0);
            if (id != 0)
            {
                var o = EditorCompat.IdToObject(id);
                if (o is Component) return o;
                if (o is GameObject g) fallback = g;
            }
            string handlerPath = Str(p, "handlerPath");
            GameObject go = !string.IsNullOrEmpty(handlerPath) ? FindByPath(handlerPath) : fallback;
            if (go == null) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", "Handler object not found.");
            string handlerComponent = Str(p, "handlerComponent");
            if (string.IsNullOrEmpty(handlerComponent))
                throw Invalid("Specify handlerComponent — the component whose method the button should call.");
            return FindComponent(go, handlerComponent);
        }

        static IDictionary<string, object> EditOk(string summary, string target, string dirtied)
        {
            var d = new Dictionary<string, object> { { "applied", true }, { "summary", summary }, { "undoable", true } };
            if (!string.IsNullOrEmpty(target)) d["target"] = target;
            if (!string.IsNullOrEmpty(dirtied)) d["sceneDirtied"] = dirtied;
            return d;
        }

        static GameObject RequireTarget(IDictionary<string, object> p)
        {
            int instanceId = Int(p, "instanceId", 0);
            string path = Str(p, "path");
            GameObject go = null;
            if (instanceId != 0) go = EditorCompat.IdToObject(instanceId) as GameObject;
            if (go == null && !string.IsNullOrEmpty(path)) go = FindByPath(path);
            if (go == null && instanceId == 0 && string.IsNullOrEmpty(path))
            {
                go = Selection.activeGameObject; // fall back to current selection
            }
            if (go == null)
                throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", "Target GameObject not found (provide instanceId or path, or select one).");
            return go;
        }

        static GameObject FindByPath(string path)
        {
            foreach (var go in Resources.FindObjectsOfTypeAll<GameObject>())
            {
                if (go == null || !go.scene.IsValid()) continue;
                if ((go.hideFlags & HideFlags.HideAndDontSave) != 0) continue;
                if (SceneInspector.PathOf(go) == path) return go;
            }
            return null;
        }

        static string MarkDirty(GameObject go)
        {
            if (go.scene.IsValid())
            {
                EditorSceneManager.MarkSceneDirty(go.scene);
                return go.scene.path;
            }
            return null;
        }

        internal static void SetPropertyValue(SerializedProperty prop, object value)
        {
            switch (prop.propertyType)
            {
                case SerializedPropertyType.Integer:
                    RequireScalar(value, prop);
                    prop.intValue = (int)Convert.ToInt64(value);
                    break;
                case SerializedPropertyType.Boolean:
                    RequireScalar(value, prop);
                    prop.boolValue = Convert.ToBoolean(value);
                    break;
                case SerializedPropertyType.Float:
                    RequireScalar(value, prop);
                    prop.floatValue = (float)Convert.ToDouble(value);
                    break;
                case SerializedPropertyType.String:
                    RequireScalar(value, prop);
                    prop.stringValue = value?.ToString() ?? "";
                    break;
                case SerializedPropertyType.Enum:
                    RequireScalar(value, prop);
                    if (value is string es)
                    {
                        int idx = Array.IndexOf(prop.enumNames, es);
                        if (idx < 0) throw Invalid($"Enum value '{es}' not valid. Options: {string.Join(",", prop.enumNames)}");
                        prop.enumValueIndex = idx;
                    }
                    else prop.enumValueIndex = (int)Convert.ToInt64(value);
                    break;
                case SerializedPropertyType.Vector2:
                    RequireVectorValue(value, prop, "{x,y}");
                    prop.vector2Value = new Vector2(C(value, "x", 0), C(value, "y", 1));
                    break;
                case SerializedPropertyType.Vector3:
                    RequireVectorValue(value, prop, "{x,y,z}");
                    prop.vector3Value = new Vector3(C(value, "x", 0), C(value, "y", 1), C(value, "z", 2));
                    break;
                case SerializedPropertyType.Vector4:
                    RequireVectorValue(value, prop, "{x,y,z,w}");
                    prop.vector4Value = new Vector4(C(value, "x", 0), C(value, "y", 1), C(value, "z", 2), C(value, "w", 3));
                    break;
                case SerializedPropertyType.Color:
                    RequireVectorValue(value, prop, "{r,g,b,a}");
                    prop.colorValue = new Color(C(value, "r", 0), C(value, "g", 1), C(value, "b", 2),
                        HasComp(value, "a", 3) ? C(value, "a", 3) : 1f);
                    break;
                case SerializedPropertyType.ObjectReference:
                    prop.objectReferenceValue = ResolveObjectReference(value);
                    break;
                case SerializedPropertyType.Quaternion:
                    RequireVectorValue(value, prop, "{x,y,z,w} or {x,y,z} euler");
                    // Accept a full quaternion {x,y,z,w} or, more conveniently, euler angles {x,y,z}.
                    prop.quaternionValue = HasComp(value, "w", 3)
                        ? new Quaternion(C(value, "x", 0), C(value, "y", 1), C(value, "z", 2), C(value, "w", 3))
                        : Quaternion.Euler(C(value, "x", 0), C(value, "y", 1), C(value, "z", 2));
                    break;
                case SerializedPropertyType.Vector2Int:
                    RequireVectorValue(value, prop, "{x,y}");
                    prop.vector2IntValue = new Vector2Int(Ci(value, "x", 0), Ci(value, "y", 1));
                    break;
                case SerializedPropertyType.Vector3Int:
                    RequireVectorValue(value, prop, "{x,y,z}");
                    prop.vector3IntValue = new Vector3Int(Ci(value, "x", 0), Ci(value, "y", 1), Ci(value, "z", 2));
                    break;
                case SerializedPropertyType.Rect:
                    RequireVectorValue(value, prop, "{x,y,width,height}");
                    prop.rectValue = new Rect(C(value, "x", 0), C(value, "y", 1), C(value, "width", 2), C(value, "height", 3));
                    break;
                case SerializedPropertyType.RectInt:
                    RequireVectorValue(value, prop, "{x,y,width,height}");
                    prop.rectIntValue = new RectInt(Ci(value, "x", 0), Ci(value, "y", 1), Ci(value, "width", 2), Ci(value, "height", 3));
                    break;
                case SerializedPropertyType.Bounds:
                    prop.boundsValue = new Bounds(Vec3Of(Sub(value, "center", prop)), Vec3Of(Sub(value, "size", prop)));
                    break;
                case SerializedPropertyType.BoundsInt:
                    prop.boundsIntValue = new BoundsInt(Vec3IntOf(Sub(value, "position", prop)), Vec3IntOf(Sub(value, "size", prop)));
                    break;
                case SerializedPropertyType.LayerMask:
                    prop.intValue = ResolveLayerMask(value);
                    break;
                case SerializedPropertyType.Character:
                    RequireScalar(value, prop);
                    prop.intValue = value is string cs && cs.Length > 0 ? cs[0] : (int)Convert.ToInt64(value);
                    break;
                case SerializedPropertyType.Generic:
                    // Arrays/lists and custom serializable structs/classes. Recurse so nested
                    // structs and object-valued fields work, e.g. {min:{x,y,z}, max:{x,y,z}} or [1,2,3].
                    SetGenericValue(prop, value);
                    break;
                default:
                    throw Invalid($"Setting fields of type {prop.propertyType} is not supported. Supported: " +
                                  "int, float, bool, string, enum, Vector2/3/4, Vector2Int/3Int, Color, Quaternion, " +
                                  "Rect, RectInt, Bounds, BoundsInt, LayerMask, Character, object references, " +
                                  "and custom structs/arrays (nested objects/arrays).");
            }
        }

        // Upper bound on array elements written in one call — guards against a malformed value
        // resizing an array to something huge and stalling the Editor.
        const int MaxArrayElements = 8192;

        // A "Generic" serialized property is either an array/list or a custom serializable
        // struct/class. Recurse into it so object- and array-valued fields are settable:
        // arrays take a JSON array, structs take a JSON object keyed by their sub-field names.
        static void SetGenericValue(SerializedProperty prop, object value)
        {
            if (prop.isArray)
            {
                if (!(value is List<object> list))
                    throw Invalid($"Field '{prop.name}' is an array; expected a JSON array, " +
                                  $"got {(value == null ? "null" : value.GetType().Name)}.");
                if (list.Count > MaxArrayElements)
                    throw Invalid($"Array for '{prop.name}' has {list.Count} elements; max is {MaxArrayElements}.");
                prop.arraySize = list.Count;
                for (int i = 0; i < list.Count; i++)
                    SetPropertyValue(prop.GetArrayElementAtIndex(i), list[i]);
                return;
            }

            if (!(value is Dictionary<string, object> dict))
                throw Invalid($"Field '{prop.name}' is a struct; expected a JSON object of its sub-fields, " +
                              $"got {(value == null ? "null" : value.GetType().Name)}.");
            foreach (var kv in dict)
            {
                var child = prop.FindPropertyRelative(kv.Key);
                if (child == null)
                    throw Invalid($"Struct field '{prop.name}' has no sub-field '{kv.Key}'.");
                SetPropertyValue(child, kv.Value);
            }
        }

        // Resolve a LayerMask value: a bitmask number, a single layer name, or an array of
        // layer names OR'd together. Unknown names are reported rather than silently dropped.
        static int ResolveLayerMask(object value)
        {
            if (value is string name) return 1 << RequireLayer(name);
            if (value is List<object> names)
            {
                int mask = 0;
                foreach (var n in names) mask |= 1 << RequireLayer(n?.ToString());
                return mask;
            }
            return (int)Convert.ToInt64(value);
        }

        static int RequireLayer(string name)
        {
            int layer = LayerMask.NameToLayer(name);
            if (layer < 0) throw Invalid($"Layer '{name}' does not exist.");
            return layer;
        }

        static UnityEngine.Object ResolveObjectReference(object value)
        {
            if (value == null) return null;
            if (value is Dictionary<string, object> d)
            {
                string path = d.TryGetValue("path", out var pv) ? pv?.ToString() : null;
                string guid = d.TryGetValue("guid", out var gv) ? gv?.ToString() : null;
                if (string.IsNullOrEmpty(path) && !string.IsNullOrEmpty(guid)) path = AssetDatabase.GUIDToAssetPath(guid);
                if (!string.IsNullOrEmpty(path) && path.StartsWith("Assets/"))
                {
                    var asset = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(path);
                    if (asset == null) throw new BridgeRouter.HandlerError("ASSET_NOT_FOUND", $"No asset at '{path}'.");
                    return asset;
                }
                if (!string.IsNullOrEmpty(path))
                {
                    var sceneGo = FindByPath(path);
                    if (sceneGo == null) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"Scene object '{path}' not found.");
                    return sceneGo;
                }
            }
            throw Invalid("Object reference must be {path|guid} for an asset, or {path} for a scene object.");
        }

        static float F(object value, string key)
        {
            if (value is Dictionary<string, object> d && d.TryGetValue(key, out var v) && v != null)
                return (float)Convert.ToDouble(v);
            return 0f;
        }

        // A vector/color value may arrive as a named object ({x,y,z}) or a positional
        // array ([x,y,z]). Read one component by name or by index, defaulting to 0.
        static float C(object value, string key, int index)
        {
            if (value is Dictionary<string, object> d && d.TryGetValue(key, out var v) && v != null)
                return (float)Convert.ToDouble(v);
            if (value is List<object> a && index < a.Count && a[index] != null)
                return (float)Convert.ToDouble(a[index]);
            return 0f;
        }

        // Integer-component variant of C() for Vector2Int/Vector3Int/RectInt etc.
        static int Ci(object value, string key, int index)
        {
            if (value is Dictionary<string, object> d && d.TryGetValue(key, out var v) && v != null)
                return (int)Convert.ToInt64(v);
            if (value is List<object> a && index < a.Count && a[index] != null)
                return (int)Convert.ToInt64(a[index]);
            return 0;
        }

        static Vector3 Vec3Of(object v) => new Vector3(C(v, "x", 0), C(v, "y", 1), C(v, "z", 2));
        static Vector3Int Vec3IntOf(object v) => new Vector3Int(Ci(v, "x", 0), Ci(v, "y", 1), Ci(v, "z", 2));

        // Pull a required sub-object (e.g. a Bounds' "center"/"size") out of a JSON object value.
        static object Sub(object value, string key, SerializedProperty prop)
        {
            if (value is Dictionary<string, object> d && d.TryGetValue(key, out var v) && v != null) return v;
            throw Invalid($"Field '{prop.name}' is a {prop.propertyType}; expected an object with a '{key}' sub-object.");
        }

        static bool HasComp(object value, string key, int index)
            => (value is Dictionary<string, object> d && d.ContainsKey(key))
               || (value is List<object> a && index < a.Count);

        // Refuse to silently write a zero vector when the value isn't a usable shape.
        // Without this guard, a value like a bare number or wrong-shaped object would
        // fall through every component to 0 and collapse transforms/sizes to (0,0,0).
        static void RequireVectorValue(object value, SerializedProperty prop, string shape)
        {
            if (value is Dictionary<string, object> || value is List<object>) return;
            throw Invalid($"Field '{prop.name}' is a {prop.propertyType}; expected an object {shape} or array, " +
                          $"got {(value == null ? "null" : value.GetType().Name)}.");
        }

        // Mirror of RequireVectorValue for scalar fields: reject an object/array sent to a
        // primitive field with a clear message, rather than a raw cast exception (int/float/enum)
        // or a silently stringified dictionary (string). The actual conversion follows.
        static void RequireScalar(object value, SerializedProperty prop)
        {
            if (!(value is Dictionary<string, object>) && !(value is List<object>)) return;
            throw Invalid($"Field '{prop.name}' is a {prop.propertyType}; expected a primitive value, " +
                          $"got a JSON {(value is List<object> ? "array" : "object")}.");
        }

        static BridgeRouter.HandlerError Invalid(string msg) => new BridgeRouter.HandlerError("INVALID_ARGUMENT", msg);
    }
}
