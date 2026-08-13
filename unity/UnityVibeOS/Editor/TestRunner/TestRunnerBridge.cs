#if UNITY_INCLUDE_TESTS
using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using UnityEditor;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;

namespace UnityVibeOS
{
    /// <summary>
    /// Optional integration with the Unity Test Framework. Lives in its own assembly guarded by
    /// UNITY_INCLUDE_TESTS so the core bridge still compiles when the package is absent. It
    /// self-registers test.run / test.status / test.cancel handlers into <see cref="BridgeRouter"/>.
    ///
    /// Test runs are asynchronous and PlayMode runs reload the script domain, so run state is
    /// persisted in <see cref="SessionState"/> (survives reloads, cleared on Editor restart) and
    /// callbacks are re-registered on every load.
    /// </summary>
    [InitializeOnLoad]
    public static class TestRunnerBridge
    {
        const string StateKey = "UnityVibeOS.testRun";
        static readonly TestRunnerApi Api;

        /// <summary>
        /// Thread-safe mirror of "a run is in flight", read by the bridge's test.await long-poll
        /// probe on the HTTP thread. Re-hydrated from SessionState after the domain reloads that
        /// PlayMode runs trigger mid-run.
        /// </summary>
        static volatile bool RunActive;
        static volatile string ActiveRunId;

        static TestRunnerBridge()
        {
            RehydrateExecution(ReadState());

            Api = ScriptableObject.CreateInstance<TestRunnerApi>();
            Api.RegisterCallbacks(new Collector());

            BridgeRouter.Register("test.run", Run);
            BridgeRouter.Register("test.status", Status);
            BridgeRouter.Register("test.cancel", Cancel);
            BridgeServer.RegisterAwait("test.await", AwaitSettled, "test.status");
        }

        static object Run(IDictionary<string, object> p)
        {
            var persisted = ReadState();
            if (IsExecutionActive(persisted))
            {
                string activeRunId = StoredRunId(persisted) ?? "unknown";
                throw new BridgeRouter.HandlerError(
                    "INVALID_ARGUMENT",
                    $"Unity test run '{activeRunId}' is still executing. Wait for it to finish before starting another run.",
                    new Dictionary<string, object>
                    {
                        { "activeRunId", activeRunId },
                        { "state", StoredState(persisted) ?? "running" }
                    });
            }

            if (!TryGetActiveNativeRunIds(out var nativeRunIds))
            {
                throw new BridgeRouter.HandlerError(
                    "FEATURE_UNAVAILABLE",
                    "Unity Test Framework run correlation is unavailable in this package version; refusing to start an untrackable run.");
            }
            if (nativeRunIds.Count > 0)
            {
                throw new BridgeRouter.HandlerError(
                    "INVALID_ARGUMENT",
                    "Unity Test Framework already has an active run. Wait for it to finish before starting a bridge run.",
                    new Dictionary<string, object> { { "activeNativeRunCount", nativeRunIds.Count } });
            }

            string modeStr = p != null && p.TryGetValue("mode", out var m) && m != null ? m.ToString() : "EditMode";
            var mode = modeStr.Equals("PlayMode", StringComparison.OrdinalIgnoreCase) ? TestMode.PlayMode : TestMode.EditMode;
            string filter = p != null && p.TryGetValue("filter", out var f) && f != null ? f.ToString() : null;

            var execFilter = new Filter { testMode = mode };
            if (!string.IsNullOrEmpty(filter)) execFilter.testNames = new[] { filter };
            string runId = Api.Execute(new ExecutionSettings(execFilter));
            if (string.IsNullOrEmpty(runId))
                throw new InvalidOperationException("Unity Test Framework returned an empty native run ID.");

            var state = new Dictionary<string, object>
            {
                { "runId", runId },
                { "state", "running" },
                { "mode", mode.ToString() },
                { "startedAt", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() },
                { "results", new List<object>() },
                { "passed", 0 }, { "failed", 0 }, { "skipped", 0 }, { "total", 0 },
                { "executionActive", true },
                { "ownedRunStarted", false },
                { "ownedCallbackReceived", false },
                { "foreignRunObserved", false },
                { "correlationIntrospectionFailed", false }
            };
            SessionState.SetString(StateKey, MiniJson.Serialize(state));
            RunActive = true;
            ActiveRunId = runId;
            EditorApplication.update -= MonitorNativeRun;
            EditorApplication.update += MonitorNativeRun;

            return new Dictionary<string, object>
            {
                { "runId", runId },
                { "state", "running" },
                { "mode", mode.ToString() }
            };
        }

        static object Status(IDictionary<string, object> p)
        {
            string requestedRunId = RequiredRunId(p);
            var state = ReadState();
            return MatchesRunId(state, requestedRunId) ? PublicState(state) : NotFound(requestedRunId);
        }

        static object Cancel(IDictionary<string, object> p)
        {
            string requestedRunId = RequiredRunId(p);
            var state = ReadState();
            if (!MatchesRunId(state, requestedRunId)) return NotFound(requestedRunId);

            // Unity 2021.3-compatible Test Framework versions have no public cancellation API.
            // Keep the physical execution lock until RunFinished even though status is cancelled.
            if (StoredState(state) == "running")
            {
                state["state"] = "cancelled";
                state["executionActive"] = true;
                SessionState.SetString(StateKey, MiniJson.Serialize(state));
                RunActive = true;
                ActiveRunId = requestedRunId;
            }
            return PublicState(state);
        }

        static bool AwaitSettled(IDictionary<string, object> p)
        {
            string requestedRunId = TryRunId(p);
            return !RunActive
                || string.IsNullOrEmpty(requestedRunId)
                || !string.Equals(requestedRunId, ActiveRunId, StringComparison.Ordinal);
        }

        static Dictionary<string, object> ReadState()
        {
            string raw = SessionState.GetString(StateKey, null);
            return string.IsNullOrEmpty(raw) ? null : MiniJson.Deserialize(raw) as Dictionary<string, object>;
        }

        static bool IsExecutionActive(Dictionary<string, object> state)
        {
            if (state == null) return false;
            if (StoredState(state) == "running") return true;
            return state.TryGetValue("executionActive", out var value) && value is bool active && active;
        }

        static void RehydrateExecution(Dictionary<string, object> state)
        {
            RunActive = IsExecutionActive(state);
            ActiveRunId = RunActive ? StoredRunId(state) : null;
            EditorApplication.update -= MonitorNativeRun;
            if (RunActive) EditorApplication.update += MonitorNativeRun;
        }

        static string RequiredRunId(IDictionary<string, object> p)
        {
            string runId = TryRunId(p);
            if (string.IsNullOrWhiteSpace(runId))
                throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", "Missing 'runId'.");
            return runId;
        }

        static string TryRunId(IDictionary<string, object> p)
        {
            return p != null && p.TryGetValue("runId", out var value) && value != null ? value.ToString() : null;
        }

        static string StoredRunId(Dictionary<string, object> state)
        {
            return state != null && state.TryGetValue("runId", out var value) && value != null ? value.ToString() : null;
        }

        static string StoredState(Dictionary<string, object> state)
        {
            return state != null && state.TryGetValue("state", out var value) && value != null ? value.ToString() : null;
        }

        static bool ForeignRunObserved(Dictionary<string, object> state)
        {
            return state != null
                && state.TryGetValue("foreignRunObserved", out var value)
                && value is bool observed
                && observed;
        }

        static bool OwnedRunStarted(Dictionary<string, object> state)
        {
            return state != null
                && state.TryGetValue("ownedRunStarted", out var value)
                && value is bool started
                && started;
        }

        static bool OwnedCallbackReceived(Dictionary<string, object> state)
        {
            return state != null
                && state.TryGetValue("ownedCallbackReceived", out var value)
                && value is bool received
                && received;
        }

        static bool CorrelationIntrospectionFailed(Dictionary<string, object> state)
        {
            return state != null
                && state.TryGetValue("correlationIntrospectionFailed", out var value)
                && value is bool failed
                && failed;
        }

        static bool MatchesRunId(Dictionary<string, object> state, string requestedRunId)
        {
            return state != null
                && string.Equals(StoredRunId(state), requestedRunId, StringComparison.Ordinal);
        }

        static Dictionary<string, object> PublicState(Dictionary<string, object> state)
        {
            var result = new Dictionary<string, object>(state);
            result.Remove("executionActive");
            result.Remove("foreignRunObserved");
            result.Remove("ownedRunStarted");
            result.Remove("ownedCallbackReceived");
            result.Remove("correlationIntrospectionFailed");
            result.Remove("pendingResults");
            result.Remove("pendingPassed");
            result.Remove("pendingFailed");
            result.Remove("pendingSkipped");
            result.Remove("pendingDurationSec");
            return result;
        }

        static void MonitorNativeRun()
        {
            if (!RunActive)
            {
                EditorApplication.update -= MonitorNativeRun;
                return;
            }

            string expectedRunId = ActiveRunId;
            var state = ReadState();
            if (string.IsNullOrEmpty(expectedRunId) || !MatchesRunId(state, expectedRunId))
            {
                RehydrateExecution(state);
                return;
            }
            if (!TryGetActiveNativeRunIds(out var nativeRunIds))
            {
                state["correlationIntrospectionFailed"] = true;
                MarkCorrelationConflict(state);
                CompleteWithoutAttributedResult(state);
                return;
            }

            bool expectedActive = nativeRunIds.Contains(expectedRunId);
            if (HasForeignRun(nativeRunIds, expectedRunId)) MarkCorrelationConflict(state);
            if (!expectedActive)
            {
                if (OwnedCallbackReceived(state)
                    && !ForeignRunObserved(state)
                    && !CorrelationIntrospectionFailed(state))
                {
                    CompleteAttributedResult(state);
                }
                else
                {
                    CompleteWithoutAttributedResult(state);
                }
            }
        }

        static bool TryGetActiveNativeRunIds(out HashSet<string> runIds)
        {
            runIds = new HashSet<string>(StringComparer.Ordinal);
            try
            {
                var holderType = typeof(TestRunnerApi).Assembly.GetType(
                    "UnityEditor.TestTools.TestRunner.TestRun.TestJobDataHolder",
                    throwOnError: false);
                if (holderType == null) return false;

                PropertyInfo instanceProperty = null;
                for (var type = holderType; type != null && instanceProperty == null; type = type.BaseType)
                {
                    instanceProperty = type.GetProperty(
                        "instance",
                        BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
                }
                var runsField = holderType.GetField("TestRuns", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                if (instanceProperty == null || runsField == null) return false;

                var holder = instanceProperty.GetValue(null, null);
                if (!(runsField.GetValue(holder) is IEnumerable runs)) return false;
                foreach (var run in runs)
                {
                    if (run == null) continue;
                    var runType = run.GetType();
                    var guidField = runType.GetField("guid", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                    var runningField = runType.GetField("isRunning", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                    if (guidField == null || runningField == null) return false;
                    if (!(runningField.GetValue(run) is bool running) || !running) continue;
                    string guid = guidField.GetValue(run)?.ToString();
                    if (!string.IsNullOrEmpty(guid)) runIds.Add(guid);
                }
                return true;
            }
            catch
            {
                runIds.Clear();
                return false;
            }
        }

        static bool HasForeignRun(HashSet<string> runIds, string expectedRunId)
        {
            foreach (string runId in runIds)
            {
                if (!string.Equals(runId, expectedRunId, StringComparison.Ordinal)) return true;
            }
            return false;
        }

        static void MarkCorrelationConflict(Dictionary<string, object> state)
        {
            if (state == null || ForeignRunObserved(state)) return;
            state["foreignRunObserved"] = true;
            SessionState.SetString(StateKey, MiniJson.Serialize(state));
        }

        static void CompleteAttributedResult(Dictionary<string, object> state)
        {
            if (!state.TryGetValue("pendingResults", out var resultsValue) || !(resultsValue is List<object> results))
            {
                CompleteWithoutAttributedResult(state);
                return;
            }

            if (StoredState(state) != "cancelled") state["state"] = "completed";
            state["executionActive"] = false;
            state["results"] = results;
            state["total"] = results.Count;
            state["passed"] = PendingValue(state, "pendingPassed", 0);
            state["failed"] = PendingValue(state, "pendingFailed", 0);
            state["skipped"] = PendingValue(state, "pendingSkipped", 0);
            state["durationSec"] = PendingValue(state, "pendingDurationSec", 0d);
            state["finishedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            RemovePendingState(state);
            SessionState.SetString(StateKey, MiniJson.Serialize(state));
            StopTracking();
        }

        static object PendingValue(Dictionary<string, object> state, string key, object fallback)
        {
            return state.TryGetValue(key, out var value) && value != null ? value : fallback;
        }

        static void RemovePendingState(Dictionary<string, object> state)
        {
            state.Remove("pendingResults");
            state.Remove("pendingPassed");
            state.Remove("pendingFailed");
            state.Remove("pendingSkipped");
            state.Remove("pendingDurationSec");
        }

        static void CompleteWithoutAttributedResult(Dictionary<string, object> state)
        {
            long finishedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (StoredState(state) != "cancelled")
            {
                string message = CorrelationIntrospectionFailed(state)
                    ? "Test Framework run-registry introspection became unavailable; refusing to attribute a global callback."
                    : ForeignRunObserved(state)
                        ? "The native test run finished after another Test Framework run overlapped; global callbacks could not be attributed safely."
                        : "The native test run finished without an attributable Test Framework callback.";
                state["state"] = "completed";
                state["results"] = new List<object>
                {
                    new Dictionary<string, object>
                    {
                        { "name", "UnityVibeOS callback correlation" },
                        { "fullName", "UnityVibeOS callback correlation" },
                        { "status", "Failed" },
                        { "durationSec", 0d },
                        { "message", message },
                        { "stackTrace", "" }
                    }
                };
                state["total"] = 1;
                state["passed"] = 0;
                state["failed"] = 1;
                state["skipped"] = 0;
                Debug.LogError($"[UnityVibeOS] {message}");
            }
            state["executionActive"] = false;
            state["finishedAt"] = finishedAt;
            RemovePendingState(state);
            SessionState.SetString(StateKey, MiniJson.Serialize(state));
            StopTracking();
        }

        static void StopTracking()
        {
            RunActive = false;
            ActiveRunId = null;
            EditorApplication.update -= MonitorNativeRun;
        }

        static Dictionary<string, object> NotFound(string requestedRunId)
        {
            return new Dictionary<string, object>
            {
                { "runId", requestedRunId },
                { "state", "not_found" }
            };
        }

        sealed class Collector : ICallbacks
        {
            public void RunStarted(ITestAdaptor testsToRun)
            {
                string expectedRunId = ActiveRunId;
                var state = ReadState();
                if (string.IsNullOrEmpty(expectedRunId) || !MatchesRunId(state, expectedRunId)) return;
                if (!TryGetActiveNativeRunIds(out var nativeRunIds))
                {
                    state["correlationIntrospectionFailed"] = true;
                    MarkCorrelationConflict(state);
                    CompleteWithoutAttributedResult(state);
                    return;
                }
                if (nativeRunIds.Count != 1 || !nativeRunIds.Contains(expectedRunId))
                {
                    if (HasForeignRun(nativeRunIds, expectedRunId)) MarkCorrelationConflict(state);
                    return;
                }
                state["ownedRunStarted"] = true;
                SessionState.SetString(StateKey, MiniJson.Serialize(state));
            }

            public void TestStarted(ITestAdaptor test) { }

            public void TestFinished(ITestResultAdaptor result) { }

            public void RunFinished(ITestResultAdaptor result)
            {
                string finishedRunId = ActiveRunId;
                var state = ReadState();
                if (string.IsNullOrEmpty(finishedRunId) || !MatchesRunId(state, finishedRunId))
                {
                    RehydrateExecution(state);
                    return;
                }
                if (!TryGetActiveNativeRunIds(out var nativeRunIds))
                {
                    state["correlationIntrospectionFailed"] = true;
                    MarkCorrelationConflict(state);
                    CompleteWithoutAttributedResult(state);
                    return;
                }
                if (nativeRunIds.Count != 1 || !nativeRunIds.Contains(finishedRunId))
                {
                    if (HasForeignRun(nativeRunIds, finishedRunId)) MarkCorrelationConflict(state);
                    return;
                }
                if (!OwnedRunStarted(state) || ForeignRunObserved(state)) return;

                var results = new List<object>();
                int passed = 0, failed = 0, skipped = 0;
                Flatten(result, results, ref passed, ref failed, ref skipped);

                state["ownedCallbackReceived"] = true;
                state["pendingResults"] = results;
                state["pendingPassed"] = passed;
                state["pendingFailed"] = failed;
                state["pendingSkipped"] = skipped;
                state["pendingDurationSec"] = (double)result.Duration;
                SessionState.SetString(StateKey, MiniJson.Serialize(state));
            }

            static void Flatten(ITestResultAdaptor node, List<object> outList, ref int passed, ref int failed, ref int skipped)
            {
                if (node.HasChildren)
                {
                    foreach (var child in node.Children) Flatten(child, outList, ref passed, ref failed, ref skipped);
                    return;
                }
                // Leaf = a single test case.
                string status = node.TestStatus.ToString();
                if (status == "Passed") passed++;
                else if (status == "Failed") failed++;
                else if (status == "Skipped") skipped++;

                outList.Add(new Dictionary<string, object>
                {
                    { "name", node.Test != null ? node.Test.Name : node.Name },
                    { "fullName", node.Test != null ? node.Test.FullName : "" },
                    { "status", status },
                    { "durationSec", (double)node.Duration },
                    { "message", node.Message ?? "" },
                    { "stackTrace", node.StackTrace ?? "" }
                });
            }
        }
    }
}
#endif
