using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using static UnityVibeOS.BridgeParams;

namespace UnityVibeOS
{
    /// <summary>
    /// Drives the Editor play-mode state machine. Entering/exiting play mode triggers a script
    /// domain reload (with the default project settings); the bridge socket drops and restarts,
    /// which the MCP client rides through as UNITY_RELOADING. Callers should poll
    /// <see cref="Status"/> until <c>isPlaying</c> settles.
    /// </summary>
    public static class PlayModeControl
    {
        public static IDictionary<string, object> Status()
        {
            bool isPlaying = EditorApplication.isPlaying;
            bool willChange = EditorApplication.isPlayingOrWillChangePlaymode;
            var d = new Dictionary<string, object>
            {
                { "isPlaying", isPlaying },
                { "isPaused", EditorApplication.isPaused },
                { "isTransitioning", willChange != isPlaying },
                { "timeScale", (double)Time.timeScale }
            };
            if (isPlaying)
            {
                d["frameCount"] = Time.frameCount;
                d["timeSinceLevelLoad"] = (double)Time.timeSinceLevelLoad;
            }
            return d;
        }

        public static IDictionary<string, object> Enter()
        {
            if (!EditorApplication.isPlaying && !EditorApplication.isPlayingOrWillChangePlaymode)
            {
                EditorApplication.EnterPlaymode();
            }
            return Status();
        }

        public static IDictionary<string, object> Exit()
        {
            if (EditorApplication.isPlaying)
            {
                EditorApplication.ExitPlaymode();
            }
            return Status();
        }

        public static IDictionary<string, object> Configure(IDictionary<string, object> p)
        {
            if (!EditorApplication.isPlaying)
            {
                throw new BridgeRouter.HandlerError("PLAY_MODE_REQUIRED", "Runtime configuration only takes effect in play mode. Enter play mode first.");
            }

            bool? isPaused = null;
            float? timeScale = null;

            if (p != null && p.TryGetValue("isPaused", out var pausedRaw) && pausedRaw != null)
            {
                if (!(pausedRaw is bool paused))
                    throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", "'isPaused' must be a boolean.");
                isPaused = paused;
            }

            if (p != null && p.TryGetValue("timeScale", out var scaleRaw) && scaleRaw != null)
            {
                var scale = TryFloat(p, "timeScale");
                if (!scale.HasValue || float.IsNaN(scale.Value) || float.IsInfinity(scale.Value) || scale.Value < 0f || scale.Value > 100f)
                    throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", "'timeScale' must be a finite number between zero and 100.");
                timeScale = scale.Value;
            }

            if (isPaused.HasValue) EditorApplication.isPaused = isPaused.Value;
            if (timeScale.HasValue) Time.timeScale = timeScale.Value;

            return Status();
        }

        public static IDictionary<string, object> Step()
        {
            if (!EditorApplication.isPlaying)
            {
                throw new BridgeRouter.HandlerError("PLAY_MODE_REQUIRED", "Cannot step a frame while not in play mode.");
            }
            // Stepping pauses the game and advances exactly one frame.
            EditorApplication.Step();
            return Status();
        }

        // -------- multi-frame stepping --------
        // EditorApplication.Step advances one frame per editor tick, so stepping N frames in a
        // single bridge call is driven by an update hook; the bridge long-polls StepsRemaining
        // on the HTTP thread (see BridgeServer's "playmode.step" await) and returns when done.

        static volatile int _stepsRemaining;
        static volatile int _stepsCompleted;
        static int _lastSteppedFrame = -1;
        static bool _stepPumpHooked;

        /// <summary>Thread-safe: read by the bridge's long-poll probe.</summary>
        public static int StepsRemaining => _stepsRemaining;

        public static IDictionary<string, object> BeginStep(IDictionary<string, object> p)
        {
            if (!EditorApplication.isPlaying)
            {
                throw new BridgeRouter.HandlerError("PLAY_MODE_REQUIRED", "Cannot step a frame while not in play mode.");
            }
            int frames = 1;
            if (p != null && p.TryGetValue("frames", out var f) && f != null)
            {
                if (f is int i) frames = i;
                else if (f is long l) frames = (int)l;
                else if (f is double d) frames = (int)d;
            }
            frames = Mathf.Clamp(frames, 1, 600);

            _stepsCompleted = 0;
            _stepsRemaining = frames;
            _lastSteppedFrame = -1;
            if (!_stepPumpHooked)
            {
                EditorApplication.update += StepPump;
                _stepPumpHooked = true;
            }
            StepPump(); // issue the first step immediately rather than waiting a tick
            return StepStatus();
        }

        public static IDictionary<string, object> StepStatus()
        {
            var d = Status();
            d["framesStepped"] = _stepsCompleted;
            d["stepping"] = _stepsRemaining > 0;
            return d;
        }

        static void StepPump()
        {
            if (_stepsRemaining <= 0) return;
            if (!EditorApplication.isPlaying)
            {
                _stepsRemaining = 0;
                return;
            }
            int frame = Time.frameCount;
            // Wait until the previous step's frame has actually landed before issuing the next.
            if (frame == _lastSteppedFrame) return;
            _lastSteppedFrame = frame;
            EditorApplication.Step();
            _stepsCompleted++;
            _stepsRemaining--;
        }
    }
}
