using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using static UnityVibeOS.BridgeParams;

namespace UnityVibeOS
{
    /// <summary>
    /// HTTP JSON-RPC bridge server. Bound to 127.0.0.1 only.
    /// Routes are:
    ///   POST /rpc      - JSON-RPC envelope (see protocol)
    ///   GET  /health   - returns {"status":"ok"} for cheap reachability probes
    /// Auto-starts on editor load.
    /// </summary>
    [InitializeOnLoad]
    public static class BridgeServer
    {
        public const string ProtocolVersion = "1.0";
        public const string DefaultHost = "127.0.0.1";
        public const int DefaultPort = 38578;

        static HttpListener Listener;
        static CancellationTokenSource Cts;
        static Task ServeTask;
        static long StartedAt;

        public static int Port { get; private set; } = DefaultPort;
        public static string Host { get; private set; } = DefaultHost;
        public static bool IsRunning => Listener != null && Listener.IsListening;
        public static long UptimeMs => StartedAt == 0 ? 0 : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - StartedAt;

        static BridgeServer()
        {
            // Built-in long-poll waits. These settle against EditorStateMirror (thread-safe),
            // so the HTTP thread never touches Unity APIs while waiting.
            RegisterAwait("compile.await", _ => !EditorStateMirror.IsCompiling, "compile.status");
            RegisterAwait("playmode.await", p =>
            {
                bool wantPlaying = !string.Equals(Str(p, "until", "playing"), "stopped", StringComparison.OrdinalIgnoreCase);
                if (EditorStateMirror.IsTransitioning) return false;
                return EditorStateMirror.IsPlaying == wantPlaying;
            }, "playmode.status");
            RegisterAwait("playmode.step", _ => PlayModeControl.StepsRemaining == 0, "playmode.stepStatus", beginMethod: "playmode.beginStep");

            // On domain reload we only tear down the socket — the discovery file stays so the
            // client knows a bridge exists here and treats the gap as UNITY_RELOADING, not a
            // missing Editor. On quit we also remove the discovery file.
            AssemblyReloadEvents.beforeAssemblyReload -= StopForReload;
            AssemblyReloadEvents.beforeAssemblyReload += StopForReload;
            EditorApplication.quitting -= OnQuit;
            EditorApplication.quitting += OnQuit;

            // Start immediately: an unfocused Editor may not deliver the delayCall tick after a
            // domain reload. Keep the delayed call as a retry for transient bind/startup failures.
            TryStart();
            EditorApplication.delayCall += TryStart;
        }

        static void TryStart()
        {
            try { Start(); }
            catch (Exception e) { Debug.LogError($"[UnityVibeOS] bridge auto-start failed: {e}"); }
        }

        public static void Start()
        {
            if (IsRunning) return;
            // Resolve the port: explicit override (env) first, then probe upward from the
            // default so a second Editor instance falls back cleanly instead of colliding.
            int requested = ResolvePreferredPort();
            for (int candidate = requested; candidate < requested + 16; candidate++)
            {
                HttpListener listener = null;
                CancellationTokenSource cts = null;
                try
                {
                    listener = new HttpListener();
                    var prefix = $"http://{DefaultHost}:{candidate}/";
                    listener.Prefixes.Add(prefix);
                    listener.Start();
                    Listener = listener;
                    Port = candidate;
                    cts = new CancellationTokenSource();
                    Cts = cts;
                    StartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    ServeTask = Task.Run(() => AcceptLoop(listener, cts.Token));
                    WriteDiscovery();
                    Debug.Log($"[UnityVibeOS] bridge listening on {prefix} (project {ProjectInfo.ProjectPath})");
                    return;
                }
                catch (HttpListenerException)
                {
                    // Port busy (another Editor / leftover socket) — try the next one.
                    ReleaseAttempt(listener, cts);
                    continue;
                }
                catch (Exception e)
                {
                    ReleaseAttempt(listener, cts);
                    Debug.LogError($"[UnityVibeOS] failed to start bridge on {DefaultHost}:{candidate}: {e.Message}");
                    return;
                }
            }
            Debug.LogError($"[UnityVibeOS] could not bind any port in [{requested}, {requested + 16}); bridge not started.");
        }

        static int ResolvePreferredPort()
        {
            var env = Environment.GetEnvironmentVariable("UVIBE_BRIDGE_PORT");
            if (!string.IsNullOrEmpty(env) && int.TryParse(env, out var p) && p > 0 && p < 65536) return p;
            return DefaultPort;
        }

        /// <summary>
        /// Discovery file lets the MCP server find the actual bound port and verify it is
        /// talking to the right project, even when the port was auto-selected.
        /// </summary>
        static void WriteDiscovery()
        {
            try
            {
                var dir = Path.Combine(ProjectInfo.ProjectPath, "Library", "UnityVibeOS");
                Directory.CreateDirectory(dir);
                var payload = new Dictionary<string, object>
                {
                    { "port", Port },
                    { "host", DefaultHost },
                    { "projectPath", ProjectInfo.ProjectPath },
                    { "unityVersion", ProjectInfo.UnityVersion },
                    { "pid", System.Diagnostics.Process.GetCurrentProcess().Id },
                    { "protocolVersion", ProtocolVersion },
                    { "startedAt", StartedAt }
                };
                File.WriteAllText(Path.Combine(dir, "bridge.json"), MiniJson.Serialize(payload));
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[UnityVibeOS] failed to write discovery file: {e.Message}");
            }
        }

        static void DeleteDiscovery()
        {
            try
            {
                var file = Path.Combine(ProjectInfo.ProjectPath, "Library", "UnityVibeOS", "bridge.json");
                if (File.Exists(file)) File.Delete(file);
            }
            catch (Exception e)
            {
                // A stale bridge.json makes clients dial a dead port, so surface the failure.
                Debug.LogWarning($"[UnityVibeOS] failed to delete discovery file: {e.Message}");
            }
        }

        public static void Stop()
        {
            StopCore(true);
        }

        static void StopForReload()
        {
            StopCore(false);
        }

        static void StopCore(bool deleteDiscovery)
        {
            var cts = Cts;
            var listener = Listener;
            Listener = null;
            Cts = null;
            ServeTask = null;
            StartedAt = 0;
            try { cts?.Cancel(); } catch (ObjectDisposedException) { /* already stopping */ }
            if (listener != null)
            {
                try { listener.Stop(); } catch { /* ignore */ }
                try { listener.Close(); } catch { /* ignore */ }
            }
            try { cts?.Dispose(); } catch { /* ignore */ }
            if (deleteDiscovery) DeleteDiscovery();
        }

        static void OnQuit()
        {
            Stop();
        }

        static void ReleaseAttempt(HttpListener listener, CancellationTokenSource cts)
        {
            if (ReferenceEquals(Listener, listener))
            {
                Listener = null;
                Cts = null;
                ServeTask = null;
                StartedAt = 0;
            }
            try { cts?.Cancel(); } catch { /* ignore */ }
            if (listener != null)
            {
                try { listener.Stop(); } catch { /* ignore */ }
                try { listener.Close(); } catch { /* ignore */ }
            }
            try { cts?.Dispose(); } catch { /* ignore */ }
        }

        /// <summary>
        /// Per-method main-thread budget. Most reads are sub-second, but test runs,
        /// play-mode transitions, and asset graph scans can legitimately take longer.
        /// </summary>
        static TimeSpan TimeoutFor(string method)
        {
            switch (method)
            {
                case "playmode.enter":
                case "playmode.exit":
                    return TimeSpan.FromSeconds(60);
                case "asset.findReferences":
                case "asset.findDependencies":
                case "asset.findMissingScripts":
                case "asset.findMissingReferences":
                case "asset.refresh":
                    return TimeSpan.FromSeconds(120);
                case "test.run":
                case "test.status":
                    return TimeSpan.FromSeconds(30);
                default:
                    return TimeSpan.FromSeconds(15);
            }
        }

        static async Task AcceptLoop(HttpListener listener, CancellationToken token)
        {
            while (!token.IsCancellationRequested && listener.IsListening)
            {
                HttpListenerContext ctx;
                try
                {
                    ctx = await listener.GetContextAsync().ConfigureAwait(false);
                }
                catch (ObjectDisposedException) { break; }
                catch (HttpListenerException) { break; }
                catch (Exception e)
                {
                    Debug.LogWarning($"[UnityVibeOS] bridge accept error: {e.Message}");
                    continue;
                }

                _ = Task.Run(() => HandleRequest(ctx));
            }
        }

        static async Task HandleRequest(HttpListenerContext ctx)
        {
            try
            {
                var path = ctx.Request.Url?.AbsolutePath ?? "/";
                if (ctx.Request.HttpMethod == "GET" && path == "/health")
                {
                    // Served entirely off the HTTP thread from mirrored state, so it answers even
                    // when the editor main thread is frozen (unfocused with keep-awake off). That
                    // makes it the client's probe for "is Unity stalled or just busy".
                    var healthBody = MiniJson.Serialize(new Dictionary<string, object>
                    {
                        { "status", "ok" },
                        { "unityVersion", ProjectInfo.UnityVersion },
                        { "projectPath", ProjectInfo.ProjectPath },
                        { "uptimeMs", UptimeMs },
                        { "editorTickAgeMs", EditorStateMirror.TickAgeMs },
                        { "keepAwakeEnabled", BackgroundKeepAlive.EnabledCached },
                        { "wasFocused", EditorStateMirror.WasFocused },
                        { "isCompiling", EditorStateMirror.IsCompiling },
                        { "isPlaying", EditorStateMirror.IsPlaying }
                    });
                    WriteResponse(ctx, 200, healthBody);
                    return;
                }
                if (ctx.Request.HttpMethod == "OPTIONS")
                {
                    ctx.Response.AddHeader("Access-Control-Allow-Origin", "http://127.0.0.1");
                    ctx.Response.AddHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
                    ctx.Response.AddHeader("Access-Control-Allow-Headers", "Content-Type");
                    WriteResponse(ctx, 204, "");
                    return;
                }
                if (ctx.Request.HttpMethod != "POST" || path != "/rpc")
                {
                    WriteResponse(ctx, 404, MiniJson.Serialize(new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "error", new Dictionary<string, object> {
                            { "code", "INVALID_ARGUMENT" },
                            { "message", $"Unknown route: {ctx.Request.HttpMethod} {path}" } } }
                    }));
                    return;
                }

                string body;
                using (var sr = new StreamReader(ctx.Request.InputStream, ctx.Request.ContentEncoding ?? Encoding.UTF8))
                {
                    body = await sr.ReadToEndAsync().ConfigureAwait(false);
                }

                Dictionary<string, object> req;
                try
                {
                    req = MiniJson.Deserialize(body) as Dictionary<string, object>;
                }
                catch (Exception e)
                {
                    WriteResponse(ctx, 400, MakeErrorEnvelope(null, "MALFORMED_BRIDGE_RESPONSE", $"Bad request JSON: {e.Message}"));
                    return;
                }
                if (req == null)
                {
                    WriteResponse(ctx, 400, MakeErrorEnvelope(null, "MALFORMED_BRIDGE_RESPONSE", "Bad request JSON: not an object."));
                    return;
                }

                string id = TryGetString(req, "id");
                string method = TryGetString(req, "method");
                Dictionary<string, object> p = req.TryGetValue("params", out var pObj) ? pObj as Dictionary<string, object> : new Dictionary<string, object>();

                if (string.IsNullOrEmpty(method))
                {
                    WriteResponse(ctx, 400, MakeErrorEnvelope(id, "INVALID_ARGUMENT", "missing 'method'"));
                    return;
                }

                long start = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

                if (AwaitSpecs.TryGetValue(method, out var awaitSpec))
                {
                    await HandleAwaitRequest(ctx, id, p, awaitSpec, start).ConfigureAwait(false);
                    return;
                }

                DispatchAndRespond(ctx, id, method, p, start, null);
            }
            catch (ThreadAbortException)
            {
                // Expected when Unity tears down the AppDomain while an RPC is in flight.
            }
            catch (Exception e)
            {
                Debug.LogError($"[UnityVibeOS] request handling failure: {e}");
                try
                {
                    WriteResponse(ctx, 500, MakeErrorEnvelope(null, "INTERNAL_ERROR", e.Message));
                }
                catch { /* ignore */ }
            }
        }

        // -------- long-poll awaits --------

        /// <summary>
        /// A method that waits server-side instead of making the client poll. The probe runs on
        /// the HTTP thread against thread-safe state only; once it settles (or the long-poll
        /// window closes) the authoritative status payload is fetched on the main thread and
        /// returned with a "settled" flag. An optional begin method (main thread) kicks off the
        /// work first — e.g. starting a multi-frame step.
        /// </summary>
        sealed class AwaitSpec
        {
            public Func<IDictionary<string, object>, bool> IsSettled;
            public string StatusMethod;
            public string BeginMethod;
        }

        static readonly ConcurrentDictionary<string, AwaitSpec> AwaitSpecs =
            new ConcurrentDictionary<string, AwaitSpec>();

        /// <summary>
        /// Cap on a single long-poll request. Clients re-issue if their own deadline is longer,
        /// so individual HTTP requests stay comfortably under client/network timeouts.
        /// </summary>
        const int MaxAwaitMs = 25_000;
        const int AwaitProbeMs = 50;

        /// <summary>
        /// Registers a long-poll method. Optional modules (e.g. the Test Framework integration)
        /// use this to expose their own awaits; the probe must be thread-safe.
        /// </summary>
        public static void RegisterAwait(string method, Func<IDictionary<string, object>, bool> isSettled, string statusMethod, string beginMethod = null)
        {
            if (string.IsNullOrEmpty(method) || isSettled == null || string.IsNullOrEmpty(statusMethod)) return;
            AwaitSpecs[method] = new AwaitSpec { IsSettled = isSettled, StatusMethod = statusMethod, BeginMethod = beginMethod };
        }

        static async Task HandleAwaitRequest(HttpListenerContext ctx, string id, Dictionary<string, object> p, AwaitSpec spec, long start)
        {
            if (spec.BeginMethod != null)
            {
                // Begin failures (e.g. PLAY_MODE_REQUIRED) short-circuit the wait.
                if (!RunOnMainThread(spec.BeginMethod, p, out _, out var beginError, out var timedOutMethod))
                {
                    WriteResponse(ctx, 504, MakeErrorEnvelope(id, "BRIDGE_TIMEOUT", $"Main-thread handler for '{timedOutMethod}' did not complete in time.{StallHint()}"));
                    return;
                }
                if (beginError != null)
                {
                    RespondError(ctx, id, beginError, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - start);
                    return;
                }
            }

            int requested = GetInt(p, "timeoutMs", MaxAwaitMs);
            long deadline = start + Math.Min(Math.Max(requested, AwaitProbeMs), MaxAwaitMs);
            bool settled = Probe(spec, p);
            while (!settled && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() < deadline)
            {
                await Task.Delay(AwaitProbeMs).ConfigureAwait(false);
                settled = Probe(spec, p);
            }

            DispatchAndRespond(ctx, id, spec.StatusMethod, p, start, settled);
        }

        /// <summary>
        /// Explains a main-thread timeout when the editor loop is demonstrably frozen (vs merely
        /// busy). Built from mirrored state only, so it is safe to call on the HTTP thread.
        /// </summary>
        static string StallHint()
        {
            long ageMs = EditorStateMirror.TickAgeMs;
            if (ageMs < 5000) return "";
            if (!EditorStateMirror.WasFocused)
            {
                string keepAwake = BackgroundKeepAlive.EnabledCached
                    ? "'Keep Unity awake (background)' is on but the loop is not ticking"
                    : "'Keep Unity awake (background)' is OFF";
                return $" Unity's editor loop has not ticked for {ageMs / 1000}s and the window is unfocused — {keepAwake}. Focus the Unity window, or enable Window ▸ Unity Vibe OS ▸ Keep Unity awake (background).";
            }
            return $" Unity's editor loop has not ticked for {ageMs / 1000}s while focused — likely a blocking import/compile; it should recover when that finishes.";
        }

        static bool Probe(AwaitSpec spec, IDictionary<string, object> p)
        {
            // A throwing probe settles immediately; the status payload reflects reality.
            try { return spec.IsSettled(p); }
            catch { return true; }
        }

        // -------- main-thread dispatch + response --------

        /// <summary>
        /// Runs a router method on the main thread. Returns false only on main-thread timeout.
        /// </summary>
        static bool RunOnMainThread(string method, Dictionary<string, object> p, out object result, out Exception error, out string timedOutMethod)
        {
            object r = null;
            Exception captured = null;
            var done = new ManualResetEventSlim(false);
            MainThreadDispatcher.Enqueue(() =>
            {
                try { r = BridgeRouter.Dispatch(method, p); }
                catch (Exception e) { captured = e; }
                finally { done.Set(); }
            });
            timedOutMethod = method;
            if (!done.Wait(TimeoutFor(method)))
            {
                result = null;
                error = null;
                return false;
            }
            result = r;
            error = captured;
            return true;
        }

        static void DispatchAndRespond(HttpListenerContext ctx, string id, string method, Dictionary<string, object> p, long start, bool? settled)
        {
            if (!RunOnMainThread(method, p, out var result, out var captured, out _))
            {
                var budget = TimeoutFor(method);
                WriteResponse(ctx, 504, MakeErrorEnvelope(id, "BRIDGE_TIMEOUT", $"Main-thread handler for '{method}' did not complete within {budget.TotalSeconds:0}s.{StallHint()}"));
                return;
            }

            long durationMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - start;

            if (captured != null)
            {
                RespondError(ctx, id, captured, durationMs);
                return;
            }

            if (settled.HasValue && result is IDictionary<string, object> dict)
            {
                bool authoritativeSettled = settled.Value;
                if (authoritativeSettled
                    && method == "compile.status"
                    && dict.TryGetValue("isCompiling", out var isCompiling)
                    && isCompiling is bool compiling
                    && compiling)
                {
                    authoritativeSettled = false;
                }
                dict["settled"] = authoritativeSettled;
            }

            var ok = new Dictionary<string, object>
            {
                { "id", id ?? "" },
                { "ok", true },
                { "result", result },
                { "error", null },
                { "meta", new Dictionary<string, object> {
                    { "unityVersion", ProjectInfo.UnityVersion },
                    { "projectPath", ProjectInfo.ProjectPath },
                    { "durationMs", durationMs }
                }}
            };
            WriteResponse(ctx, 200, MiniJson.Serialize(ok));
        }

        static void RespondError(HttpListenerContext ctx, string id, Exception captured, long durationMs)
        {
            string code = "INTERNAL_ERROR";
            IDictionary<string, object> details = null;
            if (captured is BridgeRouter.HandlerError he)
            {
                code = he.Code;
                details = he.Details;
            }
            var envelope = new Dictionary<string, object>
            {
                { "id", id ?? "" },
                { "ok", false },
                { "result", null },
                { "error", new Dictionary<string, object> {
                    { "code", code },
                    { "message", captured.Message ?? "" },
                    { "details", details ?? new Dictionary<string, object>() }
                }},
                { "meta", new Dictionary<string, object> {
                    { "unityVersion", ProjectInfo.UnityVersion },
                    { "projectPath", ProjectInfo.ProjectPath },
                    { "durationMs", durationMs }
                }}
            };
            WriteResponse(ctx, 200, MiniJson.Serialize(envelope));
        }

        static string MakeErrorEnvelope(string id, string code, string message)
        {
            var d = new Dictionary<string, object>
            {
                { "id", id ?? "" },
                { "ok", false },
                { "result", null },
                { "error", new Dictionary<string, object> {
                    { "code", code },
                    { "message", message },
                    { "details", new Dictionary<string, object>() }
                }},
                { "meta", new Dictionary<string, object> {
                    { "unityVersion", ProjectInfo.UnityVersion },
                    { "projectPath", ProjectInfo.ProjectPath },
                    { "durationMs", 0 }
                }}
            };
            return MiniJson.Serialize(d);
        }

        static void WriteResponse(HttpListenerContext ctx, int status, string body)
        {
            try
            {
                ctx.Response.StatusCode = status;
                ctx.Response.ContentType = "application/json; charset=utf-8";
                if (!string.IsNullOrEmpty(body))
                {
                    var bytes = Encoding.UTF8.GetBytes(body);
                    ctx.Response.ContentLength64 = bytes.Length;
                    ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
                }
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[UnityVibeOS] failed to write response: {e.Message}");
            }
            finally
            {
                try { ctx.Response.OutputStream.Close(); } catch { /* ignore */ }
                try { ctx.Response.Close(); } catch { /* ignore */ }
            }
        }

        static string TryGetString(IDictionary<string, object> d, string k)
        {
            return d != null && d.TryGetValue(k, out var v) && v != null ? v.ToString() : null;
        }
    }
}
