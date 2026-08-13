using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
#if UNITY_2020_2_OR_NEWER
using Unity.Profiling;
#endif

namespace UnityVibeOS
{
    /// <summary>
    /// Surfaces Unity's own profiler counters via <c>Unity.Profiling.ProfilerRecorder</c> rather
    /// than re-deriving metrics. Recorders are started once on load and left running so they
    /// accumulate a rolling window of per-frame samples; <see cref="Sample"/> just reads the
    /// averages. Counters only advance while frames render, so values are richest in play mode.
    /// </summary>
    [InitializeOnLoad]
    public static class PerformanceProbe
    {
#if UNITY_2020_2_OR_NEWER
        const int Capacity = 90; // ~1.5s window at 60fps

        sealed class Probe
        {
            public string Name;
            public string Category;
            public string Unit;
            public ProfilerRecorder Recorder;
        }

        static readonly List<Probe> Probes = new List<Probe>();
        static bool _started;

        static PerformanceProbe()
        {
            AssemblyReloadEvents.beforeAssemblyReload -= DisposeAll;
            AssemblyReloadEvents.beforeAssemblyReload += DisposeAll;
            EditorApplication.delayCall += EnsureStarted;
        }

        static void Add(ProfilerCategory category, string name, string unit)
        {
            try
            {
                var rec = ProfilerRecorder.StartNew(category, name, Capacity);
                Probes.Add(new Probe { Name = name, Category = category.ToString(), Unit = unit, Recorder = rec });
            }
            catch
            {
                // A counter name may not exist on every Unity version / pipeline — skip it.
            }
        }

        static void EnsureStarted()
        {
            if (_started) return;
            _started = true;
            Add(ProfilerCategory.Internal, "Main Thread", "ns");
            Add(ProfilerCategory.Render, "Draw Calls Count", "count");
            Add(ProfilerCategory.Render, "Batches Count", "count");
            Add(ProfilerCategory.Render, "SetPass Calls Count", "count");
            Add(ProfilerCategory.Render, "Triangles Count", "count");
            Add(ProfilerCategory.Render, "Vertices Count", "count");
            Add(ProfilerCategory.Memory, "GC Allocated In Frame", "bytes");
            Add(ProfilerCategory.Memory, "System Used Memory", "bytes");
            Add(ProfilerCategory.Memory, "GC Reserved Memory", "bytes");
        }

        static void DisposeAll()
        {
            foreach (var p in Probes)
            {
                try { p.Recorder.Dispose(); } catch { /* ignore */ }
            }
            Probes.Clear();
            _started = false;
        }

        static bool Stats(ProfilerRecorder r, out double avg, out long last, out long min, out long max, out int n)
        {
            avg = 0; last = 0; min = 0; max = 0; n = 0;
            if (!r.Valid) return false;
            n = r.Count;
            if (n == 0) return true;
            long sum = 0;
            min = long.MaxValue;
            max = long.MinValue;
            for (int i = 0; i < n; i++)
            {
                long v = r.GetSample(i).Value;
                sum += v;
                if (v < min) min = v;
                if (v > max) max = v;
            }
            last = r.LastValue;
            avg = (double)sum / n;
            return true;
        }

        public static IDictionary<string, object> Sample()
        {
            EnsureStarted();
            var counters = new List<object>();
            double mainThreadMs = -1;
            bool anyData = false;

            foreach (var p in Probes)
            {
                if (!Stats(p.Recorder, out var avg, out var last, out var min, out var max, out var n)) continue;
                if (n > 0) anyData = true;
                counters.Add(new Dictionary<string, object>
                {
                    { "name", p.Name },
                    { "category", p.Category },
                    { "average", avg },
                    { "last", last },
                    { "min", min },
                    { "max", max },
                    { "unit", p.Unit },
                    { "sampleCount", n }
                });
                if (p.Name == "Main Thread" && n > 0) mainThreadMs = avg / 1_000_000.0; // ns -> ms
            }

            var result = new Dictionary<string, object>
            {
                { "isPlaying", EditorApplication.isPlaying },
                { "warmingUp", !anyData },
                { "counters", counters }
            };
            if (mainThreadMs > 0)
            {
                result["mainThreadMs"] = mainThreadMs;
                result["estimatedFps"] = mainThreadMs > 0 ? 1000.0 / mainThreadMs : 0;
            }
            if (!anyData)
            {
                result["fallback"] = EditorApplication.isPlaying
                    ? "Profiler counters have not accumulated samples yet; call again after a few frames."
                    : "Counters advance while frames render. Enter play mode (unity_enter_play_mode) for meaningful draw-call / GC data.";
            }
            return result;
        }
#else
        public static IDictionary<string, object> Sample()
        {
            return new Dictionary<string, object>
            {
                { "isPlaying", EditorApplication.isPlaying },
                { "counters", new List<object>() },
                { "fallback", "ProfilerRecorder requires Unity 2020.2 or newer; performance probes are unavailable on this version." }
            };
        }
#endif
    }
}
