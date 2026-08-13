using System;
using System.Collections.Concurrent;
using UnityEditor;

namespace UnityVibeOS
{
    /// <summary>
    /// Drains a queue of actions on the Editor main thread via EditorApplication.update.
    /// HttpListener callbacks run on the threadpool; Unity Editor APIs (Selection, SceneManager, etc.)
    /// must be called on the main thread, so all bridge handlers go through here.
    /// </summary>
    [InitializeOnLoad]
    public static class MainThreadDispatcher
    {
        static readonly ConcurrentQueue<Action> Queue = new ConcurrentQueue<Action>();

        static MainThreadDispatcher()
        {
            EditorApplication.update -= Pump;
            EditorApplication.update += Pump;
        }

        public static void Enqueue(Action action)
        {
            if (action == null) return;
            Queue.Enqueue(action);
            // Wake the editor immediately so this work runs even if the window is unfocused/minimised
            // and its loop is frozen (no-op when focused or off Windows). The threadpool timer in
            // BackgroundKeepAlive is the always-on backstop.
            BackgroundPower.WakePump();
        }

        /// <summary>
        /// True when bridge work is waiting for a main-thread tick. <see cref="BackgroundKeepAlive"/>
        /// reads this to pump the editor loop aggressively while the window is unfocused, so a tool
        /// call doesn't sit in the queue until the user clicks back into Unity.
        /// </summary>
        public static bool HasPending => !Queue.IsEmpty;

        static readonly System.Diagnostics.Stopwatch PumpWatch = new System.Diagnostics.Stopwatch();

        static void Pump()
        {
            // Time-budget the work-per-tick (rather than a fixed action count) so cheap bursts
            // — e.g. a unity_batch of many small edits — drain in one tick, while a run of slow
            // actions still yields to keep the editor responsive.
            if (Queue.IsEmpty) return;
            PumpWatch.Restart();
            int safety = 256;
            while (safety-- > 0 && Queue.TryDequeue(out var action))
            {
                try
                {
                    action();
                }
                catch (Exception e)
                {
                    UnityEngine.Debug.LogError($"[UnityVibeOS] Main-thread action threw: {e}");
                }
                if (PumpWatch.ElapsedMilliseconds >= 8) break;
            }
        }
    }
}
