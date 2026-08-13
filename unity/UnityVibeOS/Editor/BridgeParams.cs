using System;
using System.Collections.Generic;

namespace UnityVibeOS
{
    /// <summary>
    /// Shared parsing helpers for MiniJson-decoded RPC params (IDictionary&lt;string, object&gt;
    /// whose values arrive as string / bool / long / double / List&lt;object&gt; / nested dicts).
    /// Consolidates the per-file copies that used to live in each bridge handler — pull these
    /// in with `using static UnityVibeOS.BridgeParams;` so call sites stay unchanged.
    /// </summary>
    internal static class BridgeParams
    {
        /// <summary>String param, or null when absent.</summary>
        public static string Str(IDictionary<string, object> p, string key)
            => p != null && p.TryGetValue(key, out var v) && v != null ? v.ToString() : null;

        /// <summary>String param with a default.</summary>
        public static string Str(IDictionary<string, object> p, string key, string def)
        {
            if (p == null || !p.TryGetValue(key, out var v) || v == null) return def;
            return v.ToString();
        }

        /// <summary>Int param: accepts int/long/double (truncating) and numeric strings.</summary>
        public static int GetInt(IDictionary<string, object> p, string key, int def)
        {
            if (p == null || !p.TryGetValue(key, out var v) || v == null) return def;
            if (v is int i) return i;
            if (v is long l) return (int)l;
            if (v is double d) return (int)d;
            if (int.TryParse(v.ToString(), out var parsed)) return parsed;
            return def;
        }

        /// <summary>Alias for <see cref="GetInt"/> (short name used by mutator handlers).</summary>
        public static int Int(IDictionary<string, object> p, string key, int def)
            => GetInt(p, key, def);

        /// <summary>
        /// Bool param: accepts bool, a bool that arrived JSON-encoded as a string ("true"),
        /// or a number (non-zero = true). Superset of every per-file variant it replaces.
        /// </summary>
        public static bool GetBool(IDictionary<string, object> p, string key, bool def)
        {
            if (p == null || !p.TryGetValue(key, out var v) || v == null) return def;
            if (v is bool b) return b;
            if (v is string s && bool.TryParse(s, out var parsed)) return parsed;
            if (v is long l) return l != 0;
            if (v is int i) return i != 0;
            if (v is double d) return d != 0;
            return def;
        }

        /// <summary>Float param: accepts float/double/int/long.</summary>
        public static float GetFloat(IDictionary<string, object> p, string key, float def)
        {
            if (p == null || !p.TryGetValue(key, out var v) || v == null) return def;
            if (v is float f) return f;
            if (v is double d) return (float)d;
            if (v is int i) return i;
            if (v is long l) return l;
            return def;
        }

        /// <summary>Float param, or null when absent/unparseable.</summary>
        public static float? TryFloat(IDictionary<string, object> p, string key)
        {
            if (p == null || !p.TryGetValue(key, out var v) || v == null) return null;
            try { return (float)Convert.ToDouble(v); } catch { return null; }
        }
    }
}
