using System;
using System.Collections.Generic;
using System.Threading;
using UnityEditor;
using UnityEngine;

namespace UnityVibeOS
{
    /// <summary>
    /// Captures Unity logs into a bounded ring buffer using
    /// Application.logMessageReceivedThreaded so multi-threaded logs are not dropped.
    /// Logs emitted before this static ctor runs are not retained (documented limitation).
    /// </summary>
    [InitializeOnLoad]
    public static class ConsoleCapture
    {
        public sealed class Entry
        {
            public string Type;       // "Log" | "Warning" | "Error" | "Assert" | "Exception"
            public string Message;
            public string StackTrace;
            public long Timestamp;    // ms since unix epoch
        }

        const int CAPACITY = 2000;
        const string StateKey = "UnityVibeOS.consoleCapture.v1";
        static readonly object Lock = new object();
        static readonly Queue<Entry> Buffer = new Queue<Entry>(CAPACITY);
        static long? LatestEvictedTimestamp;
        static readonly int MainThreadId;
        static bool ReloadCheckpointStarted;

        static ConsoleCapture()
        {
            MainThreadId = Thread.CurrentThread.ManagedThreadId;
            RestoreState();
            Application.logMessageReceivedThreaded -= OnLog;
            Application.logMessageReceivedThreaded += OnLog;
            AssemblyReloadEvents.beforeAssemblyReload -= BeforeAssemblyReload;
            AssemblyReloadEvents.beforeAssemblyReload += BeforeAssemblyReload;
        }

        static void OnLog(string message, string stackTrace, LogType type)
        {
            var entry = new Entry
            {
                Type = MapType(type),
                Message = message ?? "",
                StackTrace = stackTrace ?? "",
                Timestamp = NowMs(),
            };
            lock (Lock)
            {
                if (Buffer.Count >= CAPACITY)
                {
                    var evicted = Buffer.Dequeue();
                    if (!LatestEvictedTimestamp.HasValue || evicted.Timestamp > LatestEvictedTimestamp.Value)
                        LatestEvictedTimestamp = evicted.Timestamp;
                }
                Buffer.Enqueue(entry);
            }

            // SessionState is Editor-main-thread-only. The reload checkpoint includes worker logs
            // observed by then; worker logs arriving later remain an unavoidable teardown gap.
            // Severe main-thread teardown logs can be safely checkpointed immediately.
            if (ReloadCheckpointStarted
                && Thread.CurrentThread.ManagedThreadId == MainThreadId
                && (entry.Type == "Error" || entry.Type == "Assert" || entry.Type == "Exception"))
            {
                PersistState();
            }
        }

        public static IList<object> Read(string level, int limit, long? sinceTimestamp, out bool truncated, out int bufferSize)
        {
            var snapshot = SnapshotEntries(out var latestEvictedTimestamp, out bufferSize);
            var result = new List<object>();
            int effectiveLimit = Math.Max(0, limit);
            int matchCount = 0;
            for (int i = snapshot.Count - 1; i >= 0; i--)
            {
                var e = snapshot[i];
                if (sinceTimestamp.HasValue && e.Timestamp <= sinceTimestamp.Value) continue;
                if (!MatchesLevel(level, e.Type)) continue;
                matchCount++;
                if (result.Count >= effectiveLimit) continue;
                result.Add(new Dictionary<string, object>
                {
                    { "type", e.Type },
                    { "message", e.Message },
                    { "stackTrace", e.StackTrace },
                    { "timestamp", e.Timestamp }
                });
            }
            // Re-reverse to chronological order for callers.
            result.Reverse();
            bool evictionOverlapsWindow = latestEvictedTimestamp.HasValue
                && (!sinceTimestamp.HasValue || latestEvictedTimestamp.Value > sinceTimestamp.Value);
            truncated = matchCount > effectiveLimit || evictionOverlapsWindow;
            return result;
        }

        public static int BufferSize { get { lock (Lock) { return Buffer.Count; } } }

        /// <summary>
        /// Clears our captured buffer and the Unity Editor console. There is no public API for
        /// the latter, so we use the documented reflection entry point (UnityEditor.LogEntries).
        /// </summary>
        public static IDictionary<string, object> Clear()
        {
            int cleared;
            lock (Lock)
            {
                cleared = Buffer.Count;
                Buffer.Clear();
                LatestEvictedTimestamp = null;
            }
            SessionState.EraseString(StateKey);
            bool consoleCleared = false;
            try
            {
                var logEntries = System.Type.GetType("UnityEditor.LogEntries,UnityEditor");
                var clearMethod = logEntries?.GetMethod("Clear", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public);
                if (clearMethod != null)
                {
                    clearMethod.Invoke(null, null);
                    consoleCleared = true;
                }
            }
            catch { /* reflection entry point may move between versions; buffer is still cleared */ }

            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", $"Cleared {cleared} buffered log(s)" + (consoleCleared ? " and the Unity console" : "") }
            };
        }

        static List<Entry> SnapshotEntries(out long? latestEvictedTimestamp, out int bufferSize)
        {
            lock (Lock)
            {
                latestEvictedTimestamp = LatestEvictedTimestamp;
                bufferSize = Buffer.Count;
                return new List<Entry>(Buffer);
            }
        }

        static void BeforeAssemblyReload()
        {
            ReloadCheckpointStarted = true;
            PersistState();
        }

        static void PersistState()
        {
            List<Entry> snapshot;
            long? latestEvictedTimestamp;
            lock (Lock)
            {
                snapshot = new List<Entry>(Buffer);
                latestEvictedTimestamp = LatestEvictedTimestamp;
            }

            var entries = new List<object>(snapshot.Count);
            foreach (var entry in snapshot)
            {
                entries.Add(new Dictionary<string, object>
                {
                    { "type", entry.Type },
                    { "message", entry.Message },
                    { "stackTrace", entry.StackTrace },
                    { "timestamp", entry.Timestamp }
                });
            }
            SessionState.SetString(StateKey, MiniJson.Serialize(new Dictionary<string, object>
            {
                { "entries", entries },
                { "latestEvictedTimestamp", latestEvictedTimestamp }
            }));
        }

        static void RestoreState()
        {
            string raw = SessionState.GetString(StateKey, null);
            if (string.IsNullOrEmpty(raw)) return;

            bool malformed = false;
            try
            {
                if (!(MiniJson.Deserialize(raw) is Dictionary<string, object> state))
                {
                    malformed = true;
                }
                else
                {
                    if (state.TryGetValue("latestEvictedTimestamp", out var evictedRaw) && evictedRaw != null)
                    {
                        if (TryLong(evictedRaw, out var evictedTimestamp)) LatestEvictedTimestamp = evictedTimestamp;
                        else malformed = true;
                    }

                    if (state.TryGetValue("entries", out var entriesRaw) && entriesRaw is List<object> entries)
                    {
                        foreach (var item in entries)
                        {
                            if (!TryEntry(item, out var entry))
                            {
                                malformed = true;
                                continue;
                            }
                            if (Buffer.Count >= CAPACITY)
                            {
                                var evicted = Buffer.Dequeue();
                                if (!LatestEvictedTimestamp.HasValue || evicted.Timestamp > LatestEvictedTimestamp.Value)
                                    LatestEvictedTimestamp = evicted.Timestamp;
                            }
                            Buffer.Enqueue(entry);
                        }
                    }
                    else
                    {
                        malformed = true;
                    }
                }
            }
            catch (Exception e)
            {
                malformed = true;
                Debug.LogWarning($"[UnityVibeOS] failed to restore persisted console state: {e.Message}");
            }

            if (malformed)
            {
                LatestEvictedTimestamp = long.MaxValue;
                SessionState.EraseString(StateKey);
            }
        }

        static bool TryEntry(object value, out Entry entry)
        {
            entry = null;
            if (!(value is Dictionary<string, object> d)
                || !d.TryGetValue("type", out var typeRaw)
                || !d.TryGetValue("message", out var messageRaw)
                || !d.TryGetValue("stackTrace", out var stackRaw)
                || !d.TryGetValue("timestamp", out var timestampRaw)
                || typeRaw == null
                || messageRaw == null
                || stackRaw == null
                || !TryLong(timestampRaw, out var timestamp))
            {
                return false;
            }
            entry = new Entry
            {
                Type = typeRaw.ToString(),
                Message = messageRaw.ToString(),
                StackTrace = stackRaw.ToString(),
                Timestamp = timestamp
            };
            return true;
        }

        static bool TryLong(object value, out long result)
        {
            if (value is long l) { result = l; return true; }
            if (value is int i) { result = i; return true; }
            if (value is double d && d >= long.MinValue && d <= long.MaxValue)
            {
                result = (long)d;
                return true;
            }
            result = 0;
            return false;
        }

        static bool MatchesLevel(string level, string type)
        {
            if (string.IsNullOrEmpty(level) || level == "all") return true;
            if (level == "warning_or_error")
                return type == "Warning" || type == "Error" || type == "Assert" || type == "Exception";
            if (level == "error")
                return type == "Error" || type == "Assert" || type == "Exception";
            return true;
        }

        static string MapType(LogType t)
        {
            switch (t)
            {
                case LogType.Log: return "Log";
                case LogType.Warning: return "Warning";
                case LogType.Error: return "Error";
                case LogType.Assert: return "Assert";
                case LogType.Exception: return "Exception";
                default: return "Log";
            }
        }

        static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}
