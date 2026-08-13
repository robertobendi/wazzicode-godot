using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
using static UnityVibeOS.BridgeParams;

namespace UnityVibeOS
{
    /// <summary>
    /// Animator inspection and control. GetState reports live runtime state in play mode, or the
    /// AnimatorController graph (layers/states/parameters/transitions) in edit mode. SetParameter
    /// drives parameters at runtime (play mode only). EditTransition mutates the controller asset
    /// (gated as an asset write at the MCP layer) and saves it.
    /// </summary>
    public static class AnimatorBridge
    {
        public static IDictionary<string, object> GetState(IDictionary<string, object> p)
        {
            var animator = RequireAnimator(p, out var go);

            if (EditorApplication.isPlaying)
                return RuntimeState(animator, go, IntOrNull(p, "layer"));

            return ControllerGraph(animator, go);
        }

        public static IDictionary<string, object> SetParameter(IDictionary<string, object> p)
        {
            if (!EditorApplication.isPlaying)
                throw new BridgeRouter.HandlerError("PLAY_MODE_REQUIRED", "Setting Animator parameters takes effect at runtime. Enter play mode first.");

            var animator = RequireAnimator(p, out var go);
            string name = Str(p, "name");
            if (string.IsNullOrEmpty(name)) throw Invalid("Missing parameter 'name'.");

            var param = FindParameter(animator, name);
            if (param == null)
                throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"Animator has no parameter '{name}'.");

            bool hasValue = p.TryGetValue("value", out var value) && value != null;
            bool resetTrigger = p.TryGetValue("resetTrigger", out var rt) && rt != null && Convert.ToBoolean(rt);
            string desc;

            switch (param.type)
            {
                case AnimatorControllerParameterType.Bool:
                    if (!hasValue) throw Invalid($"Parameter '{name}' is a Bool; provide a boolean 'value'.");
                    animator.SetBool(name, Convert.ToBoolean(value));
                    desc = $"{name} = {Convert.ToBoolean(value)}";
                    break;
                case AnimatorControllerParameterType.Float:
                    if (!hasValue) throw Invalid($"Parameter '{name}' is a Float; provide a numeric 'value'.");
                    animator.SetFloat(name, (float)Convert.ToDouble(value));
                    desc = $"{name} = {Convert.ToDouble(value)}";
                    break;
                case AnimatorControllerParameterType.Int:
                    if (!hasValue) throw Invalid($"Parameter '{name}' is an Int; provide a numeric 'value'.");
                    animator.SetInteger(name, (int)Convert.ToInt64(value));
                    desc = $"{name} = {(int)Convert.ToInt64(value)}";
                    break;
                case AnimatorControllerParameterType.Trigger:
                    if (resetTrigger) { animator.ResetTrigger(name); desc = $"reset trigger {name}"; }
                    else { animator.SetTrigger(name); desc = $"fired trigger {name}"; }
                    break;
                default:
                    throw Invalid($"Unsupported parameter type {param.type}.");
            }

            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", $"Set Animator parameter {desc} on {SceneInspector.PathOf(go)}" },
                { "target", SceneInspector.PathOf(go) }
            };
        }

        public static IDictionary<string, object> EditTransition(IDictionary<string, object> p)
        {
            var controller = ResolveController(p);
            int layer = Int(p, "layer", 0);
            if (layer < 0 || layer >= controller.layers.Length)
                throw Invalid($"Layer {layer} out of range (controller has {controller.layers.Length}).");
            var sm = controller.layers[layer].stateMachine;

            string toName = Str(p, "toState");
            if (string.IsNullOrEmpty(toName)) throw Invalid("Missing 'toState'.");
            var to = FindState(sm, toName);
            if (to == null) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"State '{toName}' not found on layer {layer}.");

            bool fromAny = p.TryGetValue("fromAnyState", out var fa) && fa != null && Convert.ToBoolean(fa);
            bool create = p.TryGetValue("create", out var cr) && cr != null && Convert.ToBoolean(cr);

            AnimatorStateTransition transition = null;
            string label;
            if (fromAny)
            {
                transition = FindTransition(sm.anyStateTransitions, to);
                if (transition == null && create) transition = sm.AddAnyStateTransition(to);
                label = $"AnyState -> {toName}";
            }
            else
            {
                string fromName = Str(p, "fromState");
                if (string.IsNullOrEmpty(fromName)) throw Invalid("Provide 'fromState' (or set fromAnyState:true).");
                var from = FindState(sm, fromName);
                if (from == null) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"State '{fromName}' not found on layer {layer}.");
                transition = FindTransition(from.transitions, to);
                if (transition == null && create) transition = from.AddTransition(to);
                label = $"{fromName} -> {toName}";
            }
            if (transition == null)
                throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"No transition {label}. Pass create:true to add it.");

            var changed = new List<string>();
            if (TryBool(p, "hasExitTime", out var het)) { transition.hasExitTime = het; changed.Add("hasExitTime"); }
            if (TryFloat(p, "exitTime", out var et)) { transition.exitTime = et; changed.Add("exitTime"); }
            if (TryFloat(p, "duration", out var du)) { transition.duration = du; changed.Add("duration"); }
            if (TryFloat(p, "offset", out var off)) { transition.offset = off; changed.Add("offset"); }

            if (p.TryGetValue("conditions", out var condRaw) && condRaw is List<object> condList)
            {
                foreach (var c in new List<AnimatorCondition>(transition.conditions))
                    transition.RemoveCondition(c);
                foreach (var item in condList)
                {
                    if (!(item is Dictionary<string, object> cd)) continue;
                    string paramName = cd.TryGetValue("parameter", out var pn) ? pn?.ToString() : null;
                    string modeStr = cd.TryGetValue("mode", out var mo) ? mo?.ToString() : null;
                    float threshold = cd.TryGetValue("threshold", out var th) && th != null ? (float)Convert.ToDouble(th) : 0f;
                    if (string.IsNullOrEmpty(paramName) || string.IsNullOrEmpty(modeStr))
                        throw Invalid("Each condition needs 'parameter' and 'mode'.");
                    if (!Enum.TryParse<AnimatorConditionMode>(modeStr, true, out var mode))
                        throw Invalid($"Invalid condition mode '{modeStr}'. Use If/IfNot/Greater/Less/Equals/NotEqual.");
                    transition.AddCondition(mode, threshold, paramName);
                }
                changed.Add("conditions");
            }

            EditorUtility.SetDirty(controller);
            AssetDatabase.SaveAssets();

            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", $"{(create ? "Set" : "Updated")} transition {label} ({string.Join(", ", changed)}) on {AssetDatabase.GetAssetPath(controller)}" },
                { "target", AssetDatabase.GetAssetPath(controller) },
                { "undoable", false }
            };
        }

        // ---- runtime / graph readers ----

        static IDictionary<string, object> RuntimeState(Animator animator, GameObject go, int? onlyLayer)
        {
            var layers = new List<object>();
            for (int i = 0; i < animator.layerCount; i++)
            {
                if (onlyLayer.HasValue && onlyLayer.Value != i) continue;
                var info = animator.GetCurrentAnimatorStateInfo(i);
                var clips = new List<object>();
                foreach (var ci in animator.GetCurrentAnimatorClipInfo(i))
                    if (ci.clip != null) clips.Add(ci.clip.name);
                layers.Add(new Dictionary<string, object>
                {
                    { "index", i },
                    { "name", animator.GetLayerName(i) },
                    { "normalizedTime", info.normalizedTime },
                    { "speed", info.speed },
                    { "shortNameHash", info.shortNameHash },
                    { "loop", info.loop },
                    { "clips", clips }
                });
            }

            var parameters = new List<object>();
            foreach (var prm in animator.parameters)
                parameters.Add(new Dictionary<string, object>
                {
                    { "name", prm.name },
                    { "type", prm.type.ToString() },
                    { "value", RuntimeParamValue(animator, prm) }
                });

            return new Dictionary<string, object>
            {
                { "isPlaying", true },
                { "animator", SceneInspector.PathOf(go) },
                { "layers", layers },
                { "parameters", parameters }
            };
        }

        static object RuntimeParamValue(Animator a, AnimatorControllerParameter prm)
        {
            switch (prm.type)
            {
                case AnimatorControllerParameterType.Bool: return a.GetBool(prm.name);
                case AnimatorControllerParameterType.Trigger: return a.GetBool(prm.name);
                case AnimatorControllerParameterType.Float: return a.GetFloat(prm.name);
                case AnimatorControllerParameterType.Int: return a.GetInteger(prm.name);
                default: return null;
            }
        }

        static IDictionary<string, object> ControllerGraph(Animator animator, GameObject go)
        {
            var controller = animator.runtimeAnimatorController as AnimatorController;
            if (controller == null)
            {
                var path = animator.runtimeAnimatorController != null
                    ? AssetDatabase.GetAssetPath(animator.runtimeAnimatorController) : null;
                if (!string.IsNullOrEmpty(path)) controller = AssetDatabase.LoadAssetAtPath<AnimatorController>(path);
            }
            if (controller == null)
                throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"No AnimatorController on '{go.name}'.");

            var parameters = new List<object>();
            foreach (var prm in controller.parameters)
                parameters.Add(new Dictionary<string, object> { { "name", prm.name }, { "type", prm.type.ToString() } });

            var layers = new List<object>();
            for (int i = 0; i < controller.layers.Length; i++)
            {
                var layer = controller.layers[i];
                var states = new List<object>();
                foreach (var cs in layer.stateMachine.states)
                    states.Add(StateInfo(cs.state));
                var anyTransitions = new List<object>();
                foreach (var tr in layer.stateMachine.anyStateTransitions)
                    anyTransitions.Add(TransitionInfo("AnyState", tr));
                layers.Add(new Dictionary<string, object>
                {
                    { "index", i },
                    { "name", layer.name },
                    { "defaultState", layer.stateMachine.defaultState != null ? layer.stateMachine.defaultState.name : null },
                    { "states", states },
                    { "anyStateTransitions", anyTransitions }
                });
            }

            return new Dictionary<string, object>
            {
                { "isPlaying", false },
                { "animator", SceneInspector.PathOf(go) },
                { "controllerPath", AssetDatabase.GetAssetPath(controller) },
                { "parameters", parameters },
                { "layers", layers }
            };
        }

        static IDictionary<string, object> StateInfo(AnimatorState state)
        {
            var transitions = new List<object>();
            foreach (var tr in state.transitions)
                transitions.Add(TransitionInfo(state.name, tr));
            return new Dictionary<string, object>
            {
                { "name", state.name },
                { "speed", state.speed },
                { "motion", state.motion != null ? state.motion.name : null },
                { "transitions", transitions }
            };
        }

        static IDictionary<string, object> TransitionInfo(string from, AnimatorStateTransition tr)
        {
            var conditions = new List<object>();
            foreach (var c in tr.conditions)
                conditions.Add(new Dictionary<string, object>
                {
                    { "parameter", c.parameter },
                    { "mode", c.mode.ToString() },
                    { "threshold", c.threshold }
                });
            return new Dictionary<string, object>
            {
                { "from", from },
                { "to", tr.destinationState != null ? tr.destinationState.name : null },
                { "hasExitTime", tr.hasExitTime },
                { "exitTime", tr.exitTime },
                { "duration", tr.duration },
                { "conditions", conditions }
            };
        }

        // ---- resolution helpers ----

        static Animator RequireAnimator(IDictionary<string, object> p, out GameObject go)
        {
            go = ResolveTarget(p);
            var animator = go.GetComponent<Animator>();
            if (animator == null)
                throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"No Animator on '{go.name}'.");
            return animator;
        }

        static AnimatorController ResolveController(IDictionary<string, object> p)
        {
            string path = Str(p, "controllerPath");
            string guid = Str(p, "controllerGuid");
            if (string.IsNullOrEmpty(path) && !string.IsNullOrEmpty(guid)) path = AssetDatabase.GUIDToAssetPath(guid);
            if (!string.IsNullOrEmpty(path))
            {
                var ac = AssetDatabase.LoadAssetAtPath<AnimatorController>(path.Replace('\\', '/'));
                if (ac == null) throw new BridgeRouter.HandlerError("ASSET_NOT_FOUND", $"No AnimatorController at '{path}'.");
                return ac;
            }
            // Fall back to the controller on a target GameObject's Animator.
            var animator = RequireAnimator(p, out _);
            var controller = animator.runtimeAnimatorController as AnimatorController;
            if (controller == null)
                throw Invalid("Provide 'controllerPath' (or 'controllerGuid'), or target a GameObject whose Animator uses an AnimatorController asset.");
            return controller;
        }

        static AnimatorState FindState(AnimatorStateMachine sm, string name)
        {
            foreach (var cs in sm.states)
                if (cs.state != null && cs.state.name == name) return cs.state;
            return null;
        }

        static AnimatorStateTransition FindTransition(AnimatorStateTransition[] transitions, AnimatorState to)
        {
            foreach (var tr in transitions)
                if (tr.destinationState == to) return tr;
            return null;
        }

        static AnimatorControllerParameter FindParameter(Animator a, string name)
        {
            foreach (var prm in a.parameters)
                if (prm.name == name) return prm;
            return null;
        }

        static GameObject ResolveTarget(IDictionary<string, object> p)
        {
            int instanceId = Int(p, "instanceId", 0);
            string path = Str(p, "path");
            GameObject go = null;
            if (instanceId != 0) go = EditorCompat.IdToObject(instanceId) as GameObject;
            if (go == null && !string.IsNullOrEmpty(path)) go = FindByPath(path);
            if (go == null && instanceId == 0 && string.IsNullOrEmpty(path)) go = Selection.activeGameObject;
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

        static int? IntOrNull(IDictionary<string, object> p, string key)
        {
            if (p == null || !p.TryGetValue(key, out var v) || v == null) return null;
            try { return (int)Convert.ToInt64(v); } catch { return null; }
        }

        static bool TryBool(IDictionary<string, object> p, string key, out bool val)
        {
            val = false;
            if (p == null || !p.TryGetValue(key, out var v) || v == null) return false;
            try { val = Convert.ToBoolean(v); return true; } catch { return false; }
        }

        static bool TryFloat(IDictionary<string, object> p, string key, out float val)
        {
            val = 0f;
            if (p == null || !p.TryGetValue(key, out var v) || v == null) return false;
            try { val = (float)Convert.ToDouble(v); return true; } catch { return false; }
        }

        static BridgeRouter.HandlerError Invalid(string msg) => new BridgeRouter.HandlerError("INVALID_ARGUMENT", msg);
    }
}
