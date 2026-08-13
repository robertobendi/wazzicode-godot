using System.Collections.Generic;
using UnityEditor;
using UnityEditor.Compilation;

namespace UnityVibeOS
{
    /// <summary>
    /// Tracks compile state and accumulates the most recent assembly compile messages.
    /// The Unity API exposes per-assembly messages; we aggregate across the latest pass.
    /// </summary>
    [InitializeOnLoad]
    public static class CompileWatcher
    {
        static readonly object Lock = new object();
        static readonly List<CompilerMessage> LastMessages = new List<CompilerMessage>();
        static volatile bool LastIsCompiling;

        static CompileWatcher()
        {
            CompilationPipeline.compilationStarted -= OnStarted;
            CompilationPipeline.compilationFinished -= OnFinished;
            CompilationPipeline.assemblyCompilationFinished -= OnAssemblyFinished;
            CompilationPipeline.compilationStarted += OnStarted;
            CompilationPipeline.compilationFinished += OnFinished;
            CompilationPipeline.assemblyCompilationFinished += OnAssemblyFinished;
            LastIsCompiling = EditorApplication.isCompiling;
        }

        static void OnStarted(object _)
        {
            lock (Lock) { LastMessages.Clear(); LastIsCompiling = true; }
        }

        static void OnFinished(object _)
        {
            lock (Lock) { LastIsCompiling = false; }
        }

        static void OnAssemblyFinished(string assemblyName, CompilerMessage[] messages)
        {
            if (messages == null) return;
            lock (Lock)
            {
                LastMessages.AddRange(messages);
            }
        }

        public static IDictionary<string, object> GetStatus()
        {
            int errorCount = 0;
            int warningCount = 0;
            var errors = new List<object>();
            lock (Lock)
            {
                foreach (var m in LastMessages)
                {
                    if (m.type == CompilerMessageType.Error) errorCount++;
                    else if (m.type == CompilerMessageType.Warning) warningCount++;
                    errors.Add(new Dictionary<string, object>
                    {
                        { "file", m.file ?? "" },
                        { "line", m.line },
                        { "column", m.column },
                        { "message", m.message ?? "" },
                        { "type", m.type == CompilerMessageType.Error ? "error" : "warning" }
                    });
                }
            }
            // EditorApplication.isCompiling is the live truth.
            bool isCompiling = EditorApplication.isCompiling;
            return new Dictionary<string, object>
            {
                { "isCompiling", isCompiling },
                { "hasErrors", errorCount > 0 },
                { "errorCount", errorCount },
                { "warningCount", warningCount },
                { "errors", errors }
            };
        }

        public static IDictionary<string, object> RefreshAssets()
        {
            AssetDatabase.Refresh(ImportAssetOptions.ForceUpdate | ImportAssetOptions.ForceSynchronousImport);
            return GetStatus();
        }
    }
}
