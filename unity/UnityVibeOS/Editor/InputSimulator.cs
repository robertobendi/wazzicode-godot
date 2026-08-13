using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using UnityEditor;
using static UnityVibeOS.BridgeParams;

namespace UnityVibeOS
{
    /// <summary>
    /// Play-mode input simulation against the Input System package. The package is an optional
    /// dependency, so everything is reflective — the bridge still compiles when it is absent and
    /// returns FEATURE_UNAVAILABLE at call time. The approach: resolve the control by its path
    /// (e.g. "&lt;Keyboard&gt;/space") on the matching virtual device, then queue a delta-state
    /// event and pump InputSystem.Update() so the value lands the same frame.
    /// </summary>
    public static class InputSimulator
    {
        public static IDictionary<string, object> Simulate(IDictionary<string, object> p)
        {
            if (!EditorApplication.isPlaying)
                throw new BridgeRouter.HandlerError("PLAY_MODE_REQUIRED", "Input simulation only affects a running game. Enter play mode first.");

            string control = Str(p, "control");
            if (string.IsNullOrEmpty(control)) throw Invalid("Missing 'control' (e.g. '<Keyboard>/space').");
            if (!control.StartsWith("<")) control = "<Keyboard>/" + control; // bare key convenience

            string action = Str(p, "action") ?? "press";
            float? explicitValue = TryFloat(p, "value");

            var inputSystemType = FindType("UnityEngine.InputSystem.InputSystem");
            if (inputSystemType == null)
                throw new BridgeRouter.HandlerError("FEATURE_UNAVAILABLE",
                    "The Input System package (com.unity.inputsystem) is not present, so input cannot be simulated. Install it or drive gameplay another way.");

            try
            {
                var ctrl = ResolveControl(inputSystemType, control);
                if (ctrl == null)
                    throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"Could not resolve input control '{control}'.");

                float down = explicitValue ?? 1f;
                if (action == "up")
                {
                    QueueAndUpdate(inputSystemType, ctrl, 0f);
                }
                else if (action == "down")
                {
                    QueueAndUpdate(inputSystemType, ctrl, down);
                }
                else // press = down then up
                {
                    QueueAndUpdate(inputSystemType, ctrl, down);
                    QueueAndUpdate(inputSystemType, ctrl, 0f);
                }

                return new Dictionary<string, object>
                {
                    { "simulated", true },
                    { "control", control },
                    { "action", action },
                    { "backend", "InputSystem" },
                    { "isPlaying", true }
                };
            }
            catch (BridgeRouter.HandlerError) { throw; }
            catch (Exception e)
            {
                throw new BridgeRouter.HandlerError("FEATURE_UNAVAILABLE",
                    $"Input System call failed for '{control}': {e.Message}. Input simulation depends on package internals and may need adjustment for your Input System version.",
                    new Dictionary<string, object> { { "exception", e.GetType().Name } });
            }
        }

        // Resolve a control like "<Keyboard>/space" → the InputControl on the matching device.
        static object ResolveControl(Type inputSystemType, string path)
        {
            string layout = null, child = path;
            if (path.StartsWith("<"))
            {
                int end = path.IndexOf('>');
                if (end > 1)
                {
                    layout = path.Substring(1, end - 1);
                    child = path.Substring(end + 1).TrimStart('/');
                }
            }

            var devicesProp = inputSystemType.GetProperty("devices", BindingFlags.Public | BindingFlags.Static);
            var devices = devicesProp?.GetValue(null) as IEnumerable;
            if (devices == null) return null;

            foreach (var device in devices)
            {
                if (device == null) continue;
                if (layout != null && !DeviceMatchesLayout(device, layout)) continue;
                // InputControl exposes a string indexer for child controls (device["space"]).
                var indexer = device.GetType().GetMethod("get_Item", new[] { typeof(string) });
                if (indexer == null) continue;
                try
                {
                    var ctrl = indexer.Invoke(device, new object[] { child });
                    if (ctrl != null) return ctrl;
                }
                catch { /* wrong device for this child path; keep looking */ }
            }
            return null;
        }

        static bool DeviceMatchesLayout(object device, string layout)
        {
            // InputControl.layout is the registered layout name (e.g. "Keyboard", "Mouse").
            var layoutProp = device.GetType().GetProperty("layout");
            string deviceLayout = layoutProp?.GetValue(device) as string;
            if (!string.IsNullOrEmpty(deviceLayout) && string.Equals(deviceLayout, layout, StringComparison.OrdinalIgnoreCase))
                return true;
            // Fall back to a type-name match (Keyboard/Mouse/Gamepad).
            return device.GetType().Name.IndexOf(layout, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        static void QueueAndUpdate(Type inputSystemType, object control, float value)
        {
            // InputSystem.QueueDeltaStateEvent<TDelta>(InputControl control, TDelta delta, double time = -1)
            MethodInfo generic = null;
            foreach (var m in inputSystemType.GetMethods(BindingFlags.Public | BindingFlags.Static))
            {
                if (m.Name == "QueueDeltaStateEvent" && m.IsGenericMethodDefinition && m.GetParameters().Length >= 2)
                {
                    generic = m;
                    break;
                }
            }
            if (generic == null) throw new Exception("QueueDeltaStateEvent not found on InputSystem.");
            var method = generic.MakeGenericMethod(typeof(float));
            var paramCount = method.GetParameters().Length;
            var args = paramCount >= 3 ? new object[] { control, value, -1.0 } : new object[] { control, value };
            method.Invoke(null, args);

            var update = inputSystemType.GetMethod("Update", BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null);
            update?.Invoke(null, null);
        }

        static Type FindType(string fullName)
        {
            var t = Type.GetType(fullName);
            if (t != null) return t;
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                t = asm.GetType(fullName);
                if (t != null) return t;
            }
            return null;
        }

        static BridgeRouter.HandlerError Invalid(string msg) => new BridgeRouter.HandlerError("INVALID_ARGUMENT", msg);
    }
}
