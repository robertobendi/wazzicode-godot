using System;
using System.Threading;
using UnityEditor;
using UnityEditorInternal;
using UnityEngine;

namespace UnityVibeOS
{
    /// <summary>
    /// Keeps the Editor servicing the bridge while its window is NOT focused — including while a
    /// game is running in play mode — so tool calls run without you clicking back into Unity.
    ///
    /// When Unity loses OS focus it stops ticking <see cref="EditorApplication.update"/>, so the
    /// <see cref="MainThreadDispatcher"/> queue stops draining and bridge calls hang. This driver:
    ///   • keeps the process un-throttled in the background (<see cref="BackgroundPower"/>: Windows
    ///     EcoQoS / macOS App Nap) so it runs at full speed,
    ///   • pokes the OS to keep the editor ticking (Windows: a WM_NULL message-pump wake on a
    ///     threadpool timer + on every enqueue; macOS needs no poke once App Nap is off), and
    ///   • sets <c>Application.runInBackground = true</c> so play mode keeps running unfocused.
    ///
    /// Idle in the background it does nothing heavy, so a foreground game keeps the GPU; it only
    /// spins the player loop when there's queued work or play mode to advance. Toggle in
    /// Window ▸ Unity Vibe OS ▸ "Keep Unity awake (background)". Per-user (EditorPrefs), defaults ON.
    /// </summary>
    [InitializeOnLoad]
    public static class BackgroundKeepAlive
    {
        const string PrefKey = "UnityVibeOS.KeepAwake";
        const int WakeIntervalMs = 100;   // ≤100 ms wake latency even if the editor loop is frozen
        static Timer _waker;
        static volatile bool _enabledCached = true;

        public static bool Enabled
        {
            get => EditorPrefs.GetBool(PrefKey, true);
            set { EditorPrefs.SetBool(PrefKey, value); Apply(); }
        }

        /// <summary>
        /// Last-applied Enabled value, readable from any thread (EditorPrefs is main-thread-only).
        /// The bridge health endpoint reports this so clients can diagnose background stalls.
        /// </summary>
        public static bool EnabledCached => _enabledCached;

        static BackgroundKeepAlive()
        {
            AssemblyReloadEvents.beforeAssemblyReload -= Shutdown;
            AssemblyReloadEvents.beforeAssemblyReload += Shutdown;
            EditorApplication.quitting -= Shutdown;
            EditorApplication.quitting += Shutdown;

            // Apply immediately so an unfocused Editor cannot stall before its first post-reload
            // delayCall. Reapply once on the next tick after the rest of the package initializes.
            Apply();
            EditorApplication.delayCall += Apply;
        }

        static void Apply()
        {
            bool enabled = Enabled;
            _enabledCached = enabled;
            EditorApplication.update -= Tick;
            EditorApplication.playModeStateChanged -= OnPlayModeChanged;
            if (!enabled)
            {
                StopWaker();
                BackgroundPower.KeepUnthrottled(false);
                Application.runInBackground = PlayerSettings.runInBackground;
                return;
            }

            Application.runInBackground = true;
            EditorApplication.update += Tick;
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
            BackgroundPower.KeepUnthrottled(true);
            StartWaker();
        }

        static void StartWaker()
        {
            StopWaker();
            // Threadpool timer — the OS keeps firing it regardless of Unity's focus. WakePump is a
            // no-op off Windows, so this is harmless to run everywhere.
            _waker = new Timer(_ => BackgroundPower.WakePump(), null, 0, WakeIntervalMs);
        }

        static void StopWaker()
        {
            var w = _waker;
            _waker = null;
            try { w?.Dispose(); } catch { /* ignore */ }
        }

        static void Shutdown()
        {
            StopWaker();
            BackgroundPower.KeepUnthrottled(false);
            Application.runInBackground = PlayerSettings.runInBackground;
        }

        static void OnPlayModeChanged(PlayModeStateChange change)
        {
            // The project's Player Setting "Run In Background" (a tracked asset we don't touch) may be
            // off, which would pause the game when unfocused. Re-assert the runtime flag on play so an
            // unfocused play session keeps ticking the bridge.
            if (Enabled && change == PlayModeStateChange.EnteredPlayMode)
                Application.runInBackground = true;
        }

        static void Tick()
        {
            if (InternalEditorUtility.isApplicationActive) return;   // focused editor ticks itself

            // Stay light while idle in the background — the waker keeps the pump warm, so the next
            // call still wakes us instantly. Only spin the loop when there's work or play mode to run.
            bool pending = MainThreadDispatcher.HasPending;
            if (!pending && !EditorApplication.isPlaying) return;

            try
            {
                EditorApplication.QueuePlayerLoopUpdate();
                if (pending) InternalEditorUtility.RepaintAllViews();
            }
            catch { /* mid domain-reload; retry next tick */ }
        }
    }
}
