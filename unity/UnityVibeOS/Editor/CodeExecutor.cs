using System;
using System.CodeDom.Compiler;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using static UnityVibeOS.BridgeParams;

namespace UnityVibeOS
{
    /// <summary>
    /// Compiles and runs a snippet of C# inside the running Editor — the fastest way to perform a
    /// one-off Editor operation that has no dedicated tool (bulk-rename, recompute, probe an API)
    /// without writing a script file and waiting for a domain reload. The snippet becomes the body
    /// of a static Execute() method; whatever it `return`s is reported back, along with anything it
    /// logged. This is powerful and unsandboxed, so the MCP layer classifies it as a dedicated
    /// code operation while Studio protects the task with checkpoints and an action log. A denylist
    /// refuses the most obviously destructive calls.
    ///
    /// Compilation uses CodeDom (CSharpCodeProvider), which requires the project's "Api Compatibility
    /// Level" to be .NET Framework. Under .NET Standard the provider can't compile at runtime; the
    /// handler detects that and returns FEATURE_UNAVAILABLE with guidance rather than throwing.
    /// </summary>
    public static class CodeExecutor
    {
        const int MaxCodeLength = 50_000;

        // Substrings refused outright. Not a security boundary (the snippet runs with full Editor
        // privileges), just a guard against the most common accidental footguns.
        static readonly string[] Denylist =
        {
            "System.IO.Directory.Delete",
            "Directory.Delete",
            "System.IO.File.Delete",
            "File.Delete",
            "FileUtil.DeleteFileOrDirectory",
            "AssetDatabase.DeleteAsset",
            "System.Diagnostics.Process",
            "Process.Start",
            "while (true)",
            "while(true)",
            "for (;;)",
            "for(;;)",
            "Application.Quit",
            "EditorApplication.Exit",
        };

        public static IDictionary<string, object> Execute(IDictionary<string, object> p)
        {
            string code = Str(p, "code");
            if (string.IsNullOrEmpty(code)) throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", "Missing 'code'.");
            if (code.Length > MaxCodeLength) throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", $"Code is {code.Length} chars; max is {MaxCodeLength}.");

            bool safetyChecks = GetBool(p, "safetyChecks", true);
            if (safetyChecks)
            {
                foreach (var bad in Denylist)
                {
                    if (code.IndexOf(bad, StringComparison.OrdinalIgnoreCase) >= 0)
                        throw new BridgeRouter.HandlerError("INVALID_ARGUMENT",
                            $"Refused: snippet contains a denied pattern ('{bad}'). Pass safetyChecks:false to override if you are certain, or use a dedicated tool.");
                }
            }

            string source = WrapSource(code, AsStringList(p, "usings"));

            CompilerResults results;
            try
            {
                results = Compile(source);
            }
            catch (Exception e)
            {
                // CodeDom not available (e.g. .NET Standard API level) — degrade gracefully.
                throw new BridgeRouter.HandlerError("FEATURE_UNAVAILABLE",
                    "In-Editor C# compilation is unavailable in this project. Set Player Settings ▸ Api Compatibility Level to '.NET Framework' to enable unity_execute_code, or write a script with unity_create_script instead. (" + e.GetType().Name + ": " + e.Message + ")");
            }

            var errors = new List<object>();
            var warnings = new List<object>();
            foreach (CompilerError err in results.Errors)
            {
                var entry = new Dictionary<string, object>
                {
                    { "line", Math.Max(0, err.Line - LineOffset()) },
                    { "number", err.ErrorNumber },
                    { "message", err.ErrorText }
                };
                if (err.IsWarning) warnings.Add(entry); else errors.Add(entry);
            }

            if (errors.Count > 0)
            {
                return new Dictionary<string, object>
                {
                    { "compiled", false },
                    { "executed", false },
                    { "errorCount", errors.Count },
                    { "errors", errors },
                    { "warnings", warnings },
                    { "summary", $"Did not compile: {errors.Count} error(s)." }
                };
            }

            // Capture anything the snippet logs while it runs.
            var captured = new List<object>();
            Application.LogCallback handler = (condition, stack, type) =>
                captured.Add(new Dictionary<string, object> { { "type", type.ToString() }, { "message", condition } });

            object returnValue = null;
            string returnType = "void";
            string error = null;
            Application.logMessageReceived += handler;
            try
            {
                var asm = results.CompiledAssembly;
                var type = asm.GetType("UVibeDynamic.Snippet");
                var method = type.GetMethod("Execute", BindingFlags.Public | BindingFlags.Static);
                returnValue = method.Invoke(null, null);
                if (returnValue != null) returnType = returnValue.GetType().Name;
            }
            catch (TargetInvocationException tie)
            {
                error = (tie.InnerException ?? tie).ToString();
            }
            catch (Exception e)
            {
                error = e.ToString();
            }
            finally
            {
                Application.logMessageReceived -= handler;
            }

            var result = new Dictionary<string, object>
            {
                { "compiled", true },
                { "executed", error == null },
                { "errorCount", 0 },
                { "warnings", warnings },
                { "returnType", returnType },
                { "returnValue", Stringify(returnValue) },
                { "logs", captured },
                { "summary", error == null
                    ? $"Compiled and executed; returned {returnType}."
                    : "Compiled but threw at runtime." }
            };
            if (error != null) result["runtimeError"] = error;
            return result;
        }

        static int LineOffset()
        {
            // Number of lines we prepend in WrapSource before the user's code begins, so reported
            // error lines map back to the snippet. Keep in sync with WrapSource's header.
            return HeaderLineCount;
        }

        static int HeaderLineCount;

        static string WrapSource(string code, List<string> extraUsings)
        {
            var sb = new StringBuilder();
            var usings = new List<string>
            {
                "System", "System.Collections", "System.Collections.Generic", "System.Linq", "System.Text",
                "UnityEngine", "UnityEditor", "UnityEngine.SceneManagement", "UnityEditor.SceneManagement"
            };
            if (extraUsings != null) usings.AddRange(extraUsings);
            foreach (var u in usings.Distinct()) sb.Append("using ").Append(u).Append(";\n");
            sb.Append("namespace UVibeDynamic {\n");
            sb.Append("  public static class Snippet {\n");
            sb.Append("    public static object Execute() {\n");
            HeaderLineCount = CountChar(sb.ToString(), '\n'); // user code starts on the next line
            sb.Append(code).Append("\n");
            sb.Append("      return null;\n");
            sb.Append("    }\n  }\n}\n");
            return sb.ToString();
        }

        static CompilerResults Compile(string source)
        {
            var provider = new Microsoft.CSharp.CSharpCodeProvider();
            var options = new CompilerParameters
            {
                GenerateInMemory = true,
                GenerateExecutable = false,
                TreatWarningsAsErrors = false
            };
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    if (asm.IsDynamic) continue;
                    var loc = asm.Location;
                    if (string.IsNullOrEmpty(loc)) continue;
                    options.ReferencedAssemblies.Add(loc);
                }
                catch { /* some assemblies have no on-disk location; skip */ }
            }
            return provider.CompileAssemblyFromSource(options, source);
        }

        static string Stringify(object value)
        {
            if (value == null) return null;
            try
            {
                if (value is UnityEngine.Object uo) return $"{uo.name} ({uo.GetType().Name})";
                if (value is System.Collections.IEnumerable en && !(value is string))
                {
                    var parts = new List<string>();
                    int i = 0;
                    foreach (var item in en) { if (i++ >= 50) { parts.Add("…"); break; } parts.Add(item?.ToString() ?? "null"); }
                    return "[" + string.Join(", ", parts) + "]";
                }
                string s = value.ToString();
                return s.Length > 4000 ? s.Substring(0, 4000) + "…" : s;
            }
            catch (Exception e) { return $"<ToString threw: {e.Message}>"; }
        }

        static int CountChar(string s, char c)
        {
            int n = 0;
            foreach (var ch in s) if (ch == c) n++;
            return n;
        }

        static List<string> AsStringList(IDictionary<string, object> p, string key)
        {
            if (p == null || !p.TryGetValue(key, out var v) || v == null) return null;
            if (v is List<object> l) return l.Where(x => x != null).Select(x => x.ToString()).ToList();
            return null;
        }
    }
}
