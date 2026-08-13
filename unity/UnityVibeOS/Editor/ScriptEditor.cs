using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;
using static UnityVibeOS.BridgeParams;

namespace UnityVibeOS
{
    /// <summary>
    /// Read and write C# (and other text) source files under the project. This is what lets Claude
    /// author and surgically edit game code instead of guessing. Writes go to disk and trigger an
    /// AssetDatabase import so Unity recompiles; the MCP layer gates writes behind the 'script'
    /// safety target. Edits are SHA-preconditionable to guard against clobbering concurrent changes.
    ///
    /// Three editing strategies, increasing in structure:
    ///   - ApplyTextEdits: deterministic line/column range replacements (always exact).
    ///   - ApplyStructuredEdits: method/anchor-aware ops (replace_method, insert_method, anchors).
    ///   - Create: write a whole new file.
    /// A brace scanner masks out comments and string/char literals first, so method/brace matching
    /// never trips on a '{' or method name that lives inside a string or comment.
    /// </summary>
    public static class ScriptEditor
    {
        const long MaxFileBytes = 8L * 1024 * 1024; // 8 MiB — source files are small; cap pathological reads.
        static readonly UTF8Encoding Utf8NoBom = new UTF8Encoding(false);

        // ---------- Read-side handlers ----------

        public static IDictionary<string, object> Read(IDictionary<string, object> p)
        {
            string assetPath = ReqPath(p, "path");
            string abs = ResolveExisting(assetPath, requireText: true);
            byte[] bytes = File.ReadAllBytes(abs);
            if (bytes.Length > MaxFileBytes) throw Invalid($"File is {bytes.Length} bytes; exceeds the {MaxFileBytes} byte read cap.");
            string contents = Utf8NoBom.GetString(StripBom(bytes));

            int startLine = GetInt(p, "startLine", 0);
            int endLine = GetInt(p, "endLine", 0);
            bool truncated = false;
            if (startLine > 0)
            {
                var lines = SplitLines(contents);
                int s = Math.Max(1, startLine);
                int e = endLine > 0 ? Math.Min(lines.Count, endLine) : lines.Count;
                if (s <= lines.Count)
                {
                    contents = string.Join("\n", lines.GetRange(s - 1, Math.Max(0, e - s + 1)));
                    truncated = (s > 1) || (e < lines.Count);
                }
            }

            return new Dictionary<string, object>
            {
                { "path", assetPath },
                { "contents", contents },
                { "sha256", Sha256(bytes) },
                { "lineCount", CountLines(Utf8NoBom.GetString(StripBom(bytes))) },
                { "sizeBytes", bytes.Length },
                { "truncated", truncated }
            };
        }

        public static IDictionary<string, object> GetSha(IDictionary<string, object> p)
        {
            string assetPath = ReqPath(p, "path");
            string abs = ToAbsoluteUnderProject(assetPath, requireText: true);
            if (!File.Exists(abs))
            {
                return new Dictionary<string, object>
                {
                    { "path", assetPath }, { "exists", false }, { "sha256", "" }, { "sizeBytes", 0 }, { "lineCount", 0 }
                };
            }
            byte[] bytes = File.ReadAllBytes(abs);
            return new Dictionary<string, object>
            {
                { "path", assetPath },
                { "exists", true },
                { "sha256", Sha256(bytes) },
                { "sizeBytes", bytes.Length },
                { "lineCount", CountLines(Utf8NoBom.GetString(StripBom(bytes))) }
            };
        }

        public static IDictionary<string, object> FindInFile(IDictionary<string, object> p)
        {
            string assetPath = ReqPath(p, "path");
            string pattern = Str(p, "pattern");
            if (string.IsNullOrEmpty(pattern)) throw Invalid("Missing 'pattern'.");
            bool ignoreCase = GetBool(p, "ignoreCase", false);
            int maxResults = GetInt(p, "maxResults", 100);
            string abs = ResolveExisting(assetPath, requireText: true);
            string contents = Utf8NoBom.GetString(StripBom(File.ReadAllBytes(abs)));

            Regex rx;
            try { rx = new Regex(pattern, ignoreCase ? RegexOptions.IgnoreCase | RegexOptions.Multiline : RegexOptions.Multiline); }
            catch (Exception e) { throw Invalid($"Invalid regex: {e.Message}"); }

            var lines = SplitLines(contents);
            var matches = new List<object>();
            bool truncated = false;
            for (int i = 0; i < lines.Count; i++)
            {
                foreach (Match m in rx.Matches(lines[i]))
                {
                    if (matches.Count >= maxResults) { truncated = true; break; }
                    matches.Add(new Dictionary<string, object>
                    {
                        { "line", i + 1 },
                        { "column", m.Index + 1 },
                        { "match", m.Value },
                        { "lineText", lines[i].Length > 400 ? lines[i].Substring(0, 400) : lines[i] }
                    });
                }
                if (truncated) break;
            }

            return new Dictionary<string, object>
            {
                { "path", assetPath },
                { "pattern", pattern },
                { "matchCount", matches.Count },
                { "matches", matches },
                { "truncated", truncated }
            };
        }

        // ---------- Write-side handlers ----------

        public static IDictionary<string, object> Create(IDictionary<string, object> p)
        {
            string assetPath = ReqPath(p, "path");
            string contents = p.TryGetValue("contents", out var c) && c != null ? c.ToString() : "";
            bool overwrite = GetBool(p, "overwrite", false);
            if (!assetPath.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
                throw Invalid("unity_create_script requires a path ending in .cs. Use unity_apply_text_edits for other text assets.");
            string abs = ToAbsoluteUnderProject(assetPath, requireText: true, allowAssetsOnly: true);
            if (File.Exists(abs) && !overwrite)
                throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", $"'{assetPath}' already exists. Pass overwrite:true to replace it, or edit it with unity_apply_text_edits.");

            byte[] bytes = Utf8NoBom.GetBytes(contents);
            Directory.CreateDirectory(Path.GetDirectoryName(abs));
            File.WriteAllBytes(abs, bytes);
            ImportPath(assetPath);

            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", $"Created script {assetPath} ({CountLines(contents)} lines)" },
                { "path", assetPath },
                { "createdPath", assetPath },
                { "sha256After", Sha256(bytes) },
                { "changed", true },
                { "undoable", false }
            };
        }

        public static IDictionary<string, object> ApplyTextEdits(IDictionary<string, object> p)
        {
            string assetPath = ReqPath(p, "path");
            string abs = ResolveExisting(assetPath, requireText: true);
            byte[] before = File.ReadAllBytes(abs);
            string shaBefore = Sha256(before);
            CheckPrecondition(p, shaBefore);
            string contents = Utf8NoBom.GetString(StripBom(before));

            var rawEdits = AsList(p, "edits");
            if (rawEdits == null || rawEdits.Count == 0) throw Invalid("Missing 'edits' (a non-empty array of range edits).");

            var spans = new List<(int start, int end, string text)>();
            foreach (var item in rawEdits)
            {
                if (!(item is IDictionary<string, object> e)) throw Invalid("Each edit must be an object.");
                int startLine = GetInt(e, "startLine", 0);
                int startCol = GetInt(e, "startCol", 1);
                int endLine = GetInt(e, "endLine", startLine);
                int endCol = GetInt(e, "endCol", startCol);
                string newText = e.TryGetValue("newText", out var nt) && nt != null ? nt.ToString() : "";
                if (startLine < 1) throw Invalid("Edit 'startLine' is 1-based and required.");
                int s = OffsetOf(contents, startLine, startCol);
                int en = OffsetOf(contents, endLine, endCol);
                if (en < s) throw Invalid($"Edit end ({endLine}:{endCol}) precedes start ({startLine}:{startCol}).");
                spans.Add((s, en, newText));
            }

            // Detect overlaps, then apply from the end so earlier offsets stay valid.
            var ordered = spans.OrderBy(x => x.start).ToList();
            for (int i = 1; i < ordered.Count; i++)
                if (ordered[i].start < ordered[i - 1].end)
                    throw Invalid("Edits overlap. Make ranges disjoint, or apply them in separate calls.");

            var sb = new StringBuilder(contents);
            foreach (var span in ordered.OrderByDescending(x => x.start))
                sb.Remove(span.start, span.end - span.start).Insert(span.start, span.text);
            string updated = sb.ToString();

            return WriteResult(assetPath, abs, shaBefore, contents, updated, GetBool(p, "preview", false), $"Applied {spans.Count} text edit(s) to {assetPath}", spans.Count);
        }

        public static IDictionary<string, object> ApplyStructuredEdits(IDictionary<string, object> p)
        {
            string assetPath = ReqPath(p, "path");
            string abs = ResolveExisting(assetPath, requireText: true);
            byte[] before = File.ReadAllBytes(abs);
            string shaBefore = Sha256(before);
            CheckPrecondition(p, shaBefore);
            string original = Utf8NoBom.GetString(StripBom(before));

            var rawEdits = AsList(p, "edits");
            if (rawEdits == null || rawEdits.Count == 0) throw Invalid("Missing 'edits' (a non-empty array of structured ops).");

            string text = original;
            int count = 0;
            foreach (var item in rawEdits)
            {
                if (!(item is IDictionary<string, object> e)) throw Invalid("Each edit must be an object.");
                text = ApplyOneStructured(text, e);
                count++;
            }

            return WriteResult(assetPath, abs, shaBefore, original, text, GetBool(p, "preview", false), $"Applied {count} structured edit(s) to {assetPath}", count);
        }

        // ---------- Structured op engine ----------

        static string ApplyOneStructured(string text, IDictionary<string, object> e)
        {
            string op = (Str(e, "op") ?? "").Trim();
            string newText = e.TryGetValue("newText", out var nt) && nt != null ? nt.ToString() : "";
            switch (op)
            {
                case "prepend":
                    return newText + (newText.EndsWith("\n") ? "" : "\n") + text;
                case "append":
                    return text + (text.EndsWith("\n") ? "" : "\n") + newText + (newText.EndsWith("\n") ? "" : "\n");
                case "replace_method":
                {
                    var (s, en) = FindMethodSpan(text, ReqStr(e, "name", "replace_method needs 'name'"), Str(e, "className"), GetInt(e, "index", 0));
                    return text.Substring(0, s) + newText + text.Substring(en);
                }
                case "delete_method":
                {
                    var (s, en) = FindMethodSpan(text, ReqStr(e, "name", "delete_method needs 'name'"), Str(e, "className"), GetInt(e, "index", 0));
                    // Swallow a trailing blank line so deletions don't leave a gap.
                    int after = en;
                    while (after < text.Length && (text[after] == '\r' || text[after] == '\n')) { after++; if (text[after - 1] == '\n') break; }
                    return text.Substring(0, s) + text.Substring(after);
                }
                case "insert_method":
                {
                    string position = (Str(e, "position") ?? "end_of_class").Trim();
                    string body = newText.EndsWith("\n") ? newText : newText + "\n";
                    if (position == "after" || position == "before")
                    {
                        var (s, en) = FindMethodSpan(text, ReqStr(e, "name", "insert_method after/before needs 'name'"), Str(e, "className"), GetInt(e, "index", 0));
                        int at = position == "after" ? en : s;
                        string sep = position == "after" ? "\n" : "";
                        return text.Substring(0, at) + sep + body + text.Substring(at);
                    }
                    // end_of_class: insert before the closing brace of the (named or only) class.
                    int insertAt = EndOfClassInsertionPoint(text, Str(e, "className"));
                    return text.Substring(0, insertAt) + body + text.Substring(insertAt);
                }
                case "anchor_insert":
                {
                    var (mStart, mEnd) = MatchAnchor(text, ReqStr(e, "anchor", "anchor_insert needs 'anchor'"), GetBool(e, "ignoreCase", false));
                    string where = (Str(e, "position") ?? "after").Trim();
                    int at = where == "before" ? mStart : mEnd;
                    return text.Substring(0, at) + newText + text.Substring(at);
                }
                case "anchor_replace":
                {
                    var (mStart, mEnd) = MatchAnchor(text, ReqStr(e, "anchor", "anchor_replace needs 'anchor'"), GetBool(e, "ignoreCase", false));
                    return text.Substring(0, mStart) + newText + text.Substring(mEnd);
                }
                case "anchor_delete":
                {
                    var (mStart, mEnd) = MatchAnchor(text, ReqStr(e, "anchor", "anchor_delete needs 'anchor'"), GetBool(e, "ignoreCase", false));
                    return text.Substring(0, mStart) + text.Substring(mEnd);
                }
                default:
                    throw Invalid($"Unknown structured op '{op}'. Use replace_method|insert_method|delete_method|anchor_insert|anchor_replace|anchor_delete|prepend|append.");
            }
        }

        // ---------- Code-aware scanning ----------

        /// <summary>
        /// Returns a copy of <paramref name="src"/> with every comment and string/char literal
        /// replaced by spaces (newlines preserved). Brace/method matching runs on this mask so a
        /// '{', '}' or identifier inside a string or comment is never mistaken for real code.
        /// </summary>
        static string MaskCommentsAndStrings(string src)
        {
            var sb = new StringBuilder(src.Length);
            int i = 0, n = src.Length;
            while (i < n)
            {
                char ch = src[i];
                // Line comment
                if (ch == '/' && i + 1 < n && src[i + 1] == '/')
                {
                    while (i < n && src[i] != '\n') { sb.Append(src[i] == '\n' ? '\n' : ' '); i++; }
                    continue;
                }
                // Block comment
                if (ch == '/' && i + 1 < n && src[i + 1] == '*')
                {
                    while (i < n && !(src[i] == '*' && i + 1 < n && src[i + 1] == '/')) { sb.Append(src[i] == '\n' ? '\n' : ' '); i++; }
                    if (i < n) { sb.Append(' '); i++; } // *
                    if (i < n) { sb.Append(' '); i++; } // /
                    continue;
                }
                // Verbatim / interpolated-verbatim string  @"..."  $@"..."  @$"..."
                if (ch == '@' || (ch == '$' && i + 1 < n && (src[i + 1] == '@')))
                {
                    int q = i;
                    while (q < n && src[q] != '"') { if (src[q] == '\n') break; q++; }
                    if (q < n && src[q] == '"')
                    {
                        for (int k = i; k <= q; k++) sb.Append(src[k] == '\n' ? '\n' : ' ');
                        i = q + 1;
                        while (i < n)
                        {
                            if (src[i] == '"' && i + 1 < n && src[i + 1] == '"') { sb.Append("  "); i += 2; continue; }
                            if (src[i] == '"') { sb.Append(' '); i++; break; }
                            sb.Append(src[i] == '\n' ? '\n' : ' '); i++;
                        }
                        continue;
                    }
                }
                // Regular string
                if (ch == '"' || (ch == '$' && i + 1 < n && src[i + 1] == '"'))
                {
                    if (ch == '$') { sb.Append(' '); i++; }
                    sb.Append(' '); i++; // opening quote
                    while (i < n && src[i] != '"' && src[i] != '\n')
                    {
                        if (src[i] == '\\' && i + 1 < n) { sb.Append("  "); i += 2; continue; }
                        sb.Append(' '); i++;
                    }
                    if (i < n && src[i] == '"') { sb.Append(' '); i++; }
                    continue;
                }
                // Char literal
                if (ch == '\'')
                {
                    sb.Append(' '); i++;
                    while (i < n && src[i] != '\'' && src[i] != '\n')
                    {
                        if (src[i] == '\\' && i + 1 < n) { sb.Append("  "); i += 2; continue; }
                        sb.Append(' '); i++;
                    }
                    if (i < n && src[i] == '\'') { sb.Append(' '); i++; }
                    continue;
                }
                sb.Append(ch);
                i++;
            }
            return sb.ToString();
        }

        static int MatchingBrace(string mask, int openIndex)
        {
            int depth = 0;
            for (int i = openIndex; i < mask.Length; i++)
            {
                if (mask[i] == '{') depth++;
                else if (mask[i] == '}') { depth--; if (depth == 0) return i; }
            }
            throw Invalid("Unbalanced braces: could not find the closing '}' of the target block.");
        }

        /// <summary>Find [start,end) of a method's full span (signature line through closing brace or expression-body ';').</summary>
        static (int start, int end) FindMethodSpan(string text, string name, string className, int index)
        {
            string mask = MaskCommentsAndStrings(text);
            int searchStart = 0, searchEnd = text.Length;
            if (!string.IsNullOrEmpty(className))
            {
                var cls = FindClassBody(text, mask, className);
                searchStart = cls.bodyOpen; searchEnd = cls.bodyClose;
            }

            // Candidate declarations: the method name immediately followed by '(' (or generic args then '('),
            // not preceded by '.' (which would make it a call), found in real code (mask).
            var rx = new Regex(@"(?<![\w.])" + Regex.Escape(name) + @"\s*(?:<[^>{}();]*>)?\s*\(", RegexOptions.None);
            var candidates = new List<(int sigStart, int end)>();
            foreach (Match m in rx.Matches(mask))
            {
                if (m.Index < searchStart || m.Index >= searchEnd) continue;
                int parenOpen = mask.IndexOf('(', m.Index);
                if (parenOpen < 0) continue;
                int parenClose = MatchingParen(mask, parenOpen);
                if (parenClose < 0) continue;
                // After the parameter list: optional 'where' constraints, then '{' (block body) or '=>' (expression body).
                int j = parenClose + 1;
                while (j < mask.Length && char.IsWhiteSpace(mask[j])) j++;
                // Skip generic constraints
                while (j < searchEnd && mask[j] == 'w' && j + 5 < mask.Length && mask.Substring(j, 5) == "where")
                {
                    int brace = mask.IndexOf('{', j);
                    int arrow = mask.IndexOf("=>", j, StringComparison.Ordinal);
                    if (brace < 0 && arrow < 0) break;
                    j = (arrow >= 0 && (brace < 0 || arrow < brace)) ? arrow : brace;
                    break;
                }
                while (j < mask.Length && char.IsWhiteSpace(mask[j])) j++;
                int methodEnd;
                if (j < mask.Length && mask[j] == '{')
                {
                    methodEnd = MatchingBrace(mask, j) + 1;
                }
                else if (j + 1 < mask.Length && mask[j] == '=' && mask[j + 1] == '>')
                {
                    int semi = mask.IndexOf(';', j);
                    if (semi < 0) continue;
                    methodEnd = semi + 1;
                }
                else continue; // not a method declaration (e.g. a call or a field initializer)

                int sigStart = StartOfLine(text, DeclarationStart(mask, m.Index));
                candidates.Add((sigStart, methodEnd));
            }

            if (candidates.Count == 0)
                throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"No method named '{name}'{(string.IsNullOrEmpty(className) ? "" : $" in class '{className}'")} found.");
            if (candidates.Count > 1 && index <= 0 && GetMethodDisambiguationRequired(candidates))
                throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", $"{candidates.Count} methods named '{name}' (overloads). Pass 'index' (1-based) or 'className' to disambiguate.");
            int pick = index > 0 ? index - 1 : 0;
            if (pick < 0 || pick >= candidates.Count) throw Invalid($"index {index} out of range; {candidates.Count} match(es).");
            return (candidates[pick].sigStart, candidates[pick].end);
        }

        static bool GetMethodDisambiguationRequired(List<(int, int)> candidates) => candidates.Count > 1;

        static (int bodyOpen, int bodyClose) FindClassBody(string text, string mask, string className)
        {
            var rx = new Regex(@"\b(?:class|struct|interface)\s+" + Regex.Escape(className) + @"\b");
            var m = rx.Match(mask);
            if (!m.Success) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"No class/struct/interface named '{className}' found.");
            int brace = mask.IndexOf('{', m.Index);
            if (brace < 0) throw Invalid($"Could not find the body of '{className}'.");
            int close = MatchingBrace(mask, brace);
            return (brace, close);
        }

        static int EndOfClassInsertionPoint(string text, string className)
        {
            string mask = MaskCommentsAndStrings(text);
            int close;
            if (!string.IsNullOrEmpty(className)) { close = FindClassBody(text, mask, className).bodyClose; }
            else
            {
                // No class given: use the last top-level type's closing brace.
                var rx = new Regex(@"\b(?:class|struct|interface)\s+\w+");
                var matches = rx.Matches(mask);
                if (matches.Count == 0) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", "No class/struct/interface found to insert into. Pass 'className'.");
                var last = matches[matches.Count - 1];
                int brace = mask.IndexOf('{', last.Index);
                if (brace < 0) throw Invalid("Could not find the class body to insert into.");
                close = MatchingBrace(mask, brace);
            }
            return StartOfLine(text, close);
        }

        static (int start, int end) MatchAnchor(string text, string anchor, bool ignoreCase)
        {
            Regex rx;
            try { rx = new Regex(anchor, RegexOptions.Multiline | (ignoreCase ? RegexOptions.IgnoreCase : RegexOptions.None)); }
            catch (Exception e) { throw Invalid($"Invalid anchor regex: {e.Message}"); }
            var m = rx.Match(text);
            if (!m.Success) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"Anchor /{anchor}/ did not match anything in the file.");
            return (m.Index, m.Index + m.Length);
        }

        static int MatchingParen(string mask, int openIndex)
        {
            int depth = 0;
            for (int i = openIndex; i < mask.Length; i++)
            {
                if (mask[i] == '(') depth++;
                else if (mask[i] == ')') { depth--; if (depth == 0) return i; }
            }
            return -1;
        }

        // Back up from a method-name match to the start of the declaration (after the previous
        // statement/block boundary in masked code), so the returned span starts at the modifiers/return type.
        static int DeclarationStart(string mask, int nameIndex)
        {
            int i = nameIndex - 1;
            while (i >= 0)
            {
                char ch = mask[i];
                if (ch == ';' || ch == '{' || ch == '}') return i + 1;
                i--;
            }
            return 0;
        }

        static int StartOfLine(string text, int index)
        {
            int i = Math.Min(index, text.Length);
            while (i > 0 && text[i - 1] != '\n') i--;
            return i;
        }

        // ---------- Shared helpers ----------

        static IDictionary<string, object> WriteResult(string assetPath, string abs, string shaBefore, string oldText, string newText, bool preview, string summary, int editCount)
        {
            bool changed = !string.Equals(oldText, newText, StringComparison.Ordinal);
            if (preview)
            {
                return new Dictionary<string, object>
                {
                    { "applied", false },
                    { "summary", $"[preview] {summary}" },
                    { "path", assetPath },
                    { "sha256Before", shaBefore },
                    { "changed", changed },
                    { "editCount", editCount },
                    { "diff", UnifiedDiff(oldText, newText, assetPath) },
                    { "undoable", false }
                };
            }
            if (!changed)
            {
                return new Dictionary<string, object>
                {
                    { "applied", true }, { "summary", $"No change — file already matches." }, { "path", assetPath },
                    { "sha256Before", shaBefore }, { "sha256After", shaBefore }, { "changed", false }, { "editCount", editCount }, { "undoable", false }
                };
            }
            byte[] outBytes = Utf8NoBom.GetBytes(newText);
            File.WriteAllBytes(abs, outBytes);
            ImportPath(assetPath);
            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", summary },
                { "path", assetPath },
                { "sha256Before", shaBefore },
                { "sha256After", Sha256(outBytes) },
                { "changed", true },
                { "editCount", editCount },
                { "undoable", false }
            };
        }

        static void CheckPrecondition(IDictionary<string, object> p, string shaBefore)
        {
            string expected = Str(p, "preconditionSha256");
            if (!string.IsNullOrEmpty(expected) && !string.Equals(expected, shaBefore, StringComparison.OrdinalIgnoreCase))
                throw new BridgeRouter.HandlerError("INVALID_ARGUMENT",
                    "preconditionSha256 does not match the file on disk — it changed since you last read it. Re-read with unity_read_script and retry.",
                    new Dictionary<string, object> { { "currentSha256", shaBefore } });
        }

        static void ImportPath(string assetPath)
        {
            try { AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceUpdate); }
            catch { try { AssetDatabase.Refresh(); } catch { /* ignore */ } }
        }

        static int OffsetOf(string text, int line, int col)
        {
            if (line < 1) throw Invalid("Line numbers are 1-based.");
            int curLine = 1, i = 0;
            while (i < text.Length && curLine < line) { if (text[i] == '\n') curLine++; i++; }
            if (curLine < line) { if (line == curLine) return text.Length; return text.Length; }
            int col1 = Math.Max(1, col);
            int offset = i + (col1 - 1);
            // Clamp to the end of this line (don't run past the newline into the next line).
            int lineEnd = text.IndexOf('\n', i);
            if (lineEnd < 0) lineEnd = text.Length;
            if (offset > lineEnd) offset = lineEnd;
            return Math.Min(offset, text.Length);
        }

        static string UnifiedDiff(string a, string b, string label)
        {
            // Minimal, dependency-free line diff: emit a context-free replacement block.
            var la = SplitLines(a); var lb = SplitLines(b);
            int prefix = 0; while (prefix < la.Count && prefix < lb.Count && la[prefix] == lb[prefix]) prefix++;
            int suffix = 0; while (suffix < (la.Count - prefix) && suffix < (lb.Count - prefix) && la[la.Count - 1 - suffix] == lb[lb.Count - 1 - suffix]) suffix++;
            var sb = new StringBuilder();
            sb.Append($"--- a/{label}\n+++ b/{label}\n");
            sb.Append($"@@ -{prefix + 1},{la.Count - prefix - suffix} +{prefix + 1},{lb.Count - prefix - suffix} @@\n");
            for (int i = prefix; i < la.Count - suffix; i++) sb.Append("-" + la[i] + "\n");
            for (int i = prefix; i < lb.Count - suffix; i++) sb.Append("+" + lb[i] + "\n");
            return sb.ToString();
        }

        static string Sha256(byte[] bytes)
        {
            using (var sha = SHA256.Create())
            {
                var hash = sha.ComputeHash(StripBom(bytes));
                var sb = new StringBuilder(hash.Length * 2);
                foreach (var b in hash) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        static byte[] StripBom(byte[] bytes)
        {
            if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
            {
                var trimmed = new byte[bytes.Length - 3];
                Array.Copy(bytes, 3, trimmed, 0, trimmed.Length);
                return trimmed;
            }
            return bytes;
        }

        static List<string> SplitLines(string s) => new List<string>(s.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n'));
        static int CountLines(string s) => SplitLines(s).Count;

        // ---------- Path validation ----------

        static string ResolveExisting(string assetPath, bool requireText)
        {
            string abs = ToAbsoluteUnderProject(assetPath, requireText);
            if (!File.Exists(abs)) throw new BridgeRouter.HandlerError("ASSET_NOT_FOUND", $"No file at '{assetPath}'.");
            return abs;
        }

        static string ToAbsoluteUnderProject(string assetPath, bool requireText, bool allowAssetsOnly = false)
        {
            string norm = assetPath.Replace('\\', '/').Trim();
            if (norm.Contains("..")) throw Invalid("Path may not contain '..'.");
            bool underAssets = norm.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase) || norm.Equals("Assets", StringComparison.OrdinalIgnoreCase);
            bool underPackages = norm.StartsWith("Packages/", StringComparison.OrdinalIgnoreCase);
            if (allowAssetsOnly && !underAssets) throw Invalid("New scripts must be created under Assets/.");
            if (!underAssets && !underPackages) throw Invalid("Path must be under Assets/ (or Packages/ for reads).");
            string abs = Path.GetFullPath(Path.Combine(ProjectInfo.ProjectPath, norm));
            string root = Path.GetFullPath(ProjectInfo.ProjectPath);
            if (!abs.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw Invalid("Resolved path escapes the project root.");
            return abs;
        }

        // ---------- Param helpers ----------

        static string ReqPath(IDictionary<string, object> p, string key)
        {
            string v = Str(p, key);
            if (string.IsNullOrEmpty(v)) throw Invalid($"Missing '{key}'.");
            return v;
        }

        static string ReqStr(IDictionary<string, object> p, string key, string message)
        {
            string v = Str(p, key);
            if (string.IsNullOrEmpty(v)) throw Invalid(message);
            return v;
        }

        static List<object> AsList(IDictionary<string, object> p, string key)
        {
            if (p == null || !p.TryGetValue(key, out var v) || v == null) return null;
            if (v is List<object> l) return l;
            if (v is IEnumerable<object> e) return new List<object>(e);
            return null;
        }

        static BridgeRouter.HandlerError Invalid(string message) => new BridgeRouter.HandlerError("INVALID_ARGUMENT", message);
    }
}
