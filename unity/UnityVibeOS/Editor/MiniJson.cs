// Minimal JSON encoder/decoder for Unity Vibe OS bridge.
// Encodes IDictionary<string, object>, IList, string, bool, numeric, null.
// Decodes to those same types. Keeps the bridge dependency-free.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace UnityVibeOS
{
    public static class MiniJson
    {
        public static string Serialize(object value)
        {
            var sb = new StringBuilder(256);
            EncodeValue(value, sb);
            return sb.ToString();
        }

        public static object Deserialize(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            var p = new Parser(json);
            return p.ParseValue();
        }

        // ---- Encoder ----

        static void EncodeValue(object v, StringBuilder sb)
        {
            if (v == null) { sb.Append("null"); return; }
            switch (v)
            {
                case bool b: sb.Append(b ? "true" : "false"); return;
                case string s: EncodeString(s, sb); return;
                case int i: sb.Append(i.ToString(CultureInfo.InvariantCulture)); return;
                case long l: sb.Append(l.ToString(CultureInfo.InvariantCulture)); return;
                case short sh: sb.Append(sh.ToString(CultureInfo.InvariantCulture)); return;
                case byte by: sb.Append(by.ToString(CultureInfo.InvariantCulture)); return;
                case uint ui: sb.Append(ui.ToString(CultureInfo.InvariantCulture)); return;
                case ulong ul: sb.Append(ul.ToString(CultureInfo.InvariantCulture)); return;
                case float f: EncodeFloat(f, sb); return;
                case double d: EncodeDouble(d, sb); return;
                case decimal dec: sb.Append(dec.ToString(CultureInfo.InvariantCulture)); return;
            }
            if (v is IDictionary<string, object> sdict) { EncodeObject(sdict, sb); return; }
            if (v is IDictionary idict) { EncodeNonGenericDict(idict, sb); return; }
            if (v is IEnumerable list) { EncodeArray(list, sb); return; }

            // Fallback: ToString
            EncodeString(v.ToString() ?? "", sb);
        }

        static void EncodeObject(IDictionary<string, object> dict, StringBuilder sb)
        {
            sb.Append('{');
            bool first = true;
            foreach (var kv in dict)
            {
                if (!first) sb.Append(',');
                first = false;
                EncodeString(kv.Key, sb);
                sb.Append(':');
                EncodeValue(kv.Value, sb);
            }
            sb.Append('}');
        }

        static void EncodeNonGenericDict(IDictionary dict, StringBuilder sb)
        {
            sb.Append('{');
            bool first = true;
            foreach (DictionaryEntry kv in dict)
            {
                if (!first) sb.Append(',');
                first = false;
                EncodeString(kv.Key?.ToString() ?? "", sb);
                sb.Append(':');
                EncodeValue(kv.Value, sb);
            }
            sb.Append('}');
        }

        static void EncodeArray(IEnumerable list, StringBuilder sb)
        {
            sb.Append('[');
            bool first = true;
            foreach (var item in list)
            {
                if (!first) sb.Append(',');
                first = false;
                EncodeValue(item, sb);
            }
            sb.Append(']');
        }

        static void EncodeFloat(float f, StringBuilder sb)
        {
            if (float.IsNaN(f) || float.IsInfinity(f)) { sb.Append("null"); return; }
            sb.Append(f.ToString("R", CultureInfo.InvariantCulture));
        }

        static void EncodeDouble(double d, StringBuilder sb)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); return; }
            sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
        }

        static void EncodeString(string s, StringBuilder sb)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20)
                        {
                            sb.Append("\\u").Append(((int)c).ToString("X4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('"');
        }

        // ---- Decoder ----

        sealed class Parser
        {
            readonly string s;
            int i;
            public Parser(string s) { this.s = s; this.i = 0; }

            public object ParseValue()
            {
                SkipWs();
                if (i >= s.Length) throw new FormatException("Unexpected end of JSON");
                char c = s[i];
                if (c == '{') return ParseObject();
                if (c == '[') return ParseArray();
                if (c == '"') return ParseString();
                if (c == 't' || c == 'f') return ParseBool();
                if (c == 'n') return ParseNull();
                return ParseNumber();
            }

            Dictionary<string, object> ParseObject()
            {
                var dict = new Dictionary<string, object>();
                i++; // consume {
                SkipWs();
                if (i < s.Length && s[i] == '}') { i++; return dict; }
                while (i < s.Length)
                {
                    SkipWs();
                    if (s[i] != '"') throw new FormatException($"Expected string key at {i}");
                    var key = ParseString();
                    SkipWs();
                    if (i >= s.Length || s[i] != ':') throw new FormatException($"Expected ':' at {i}");
                    i++;
                    SkipWs();
                    var val = ParseValue();
                    dict[key] = val;
                    SkipWs();
                    if (i >= s.Length) throw new FormatException("Unexpected end inside object");
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == '}') { i++; return dict; }
                    throw new FormatException($"Expected ',' or '}}' at {i}");
                }
                throw new FormatException("Unterminated object");
            }

            List<object> ParseArray()
            {
                var arr = new List<object>();
                i++; // consume [
                SkipWs();
                if (i < s.Length && s[i] == ']') { i++; return arr; }
                while (i < s.Length)
                {
                    SkipWs();
                    arr.Add(ParseValue());
                    SkipWs();
                    if (i >= s.Length) throw new FormatException("Unexpected end inside array");
                    if (s[i] == ',') { i++; continue; }
                    if (s[i] == ']') { i++; return arr; }
                    throw new FormatException($"Expected ',' or ']' at {i}");
                }
                throw new FormatException("Unterminated array");
            }

            string ParseString()
            {
                if (s[i] != '"') throw new FormatException($"Expected string at {i}");
                i++;
                var sb = new StringBuilder();
                while (i < s.Length)
                {
                    char c = s[i++];
                    if (c == '"') return sb.ToString();
                    if (c == '\\')
                    {
                        if (i >= s.Length) throw new FormatException("Unterminated escape");
                        char esc = s[i++];
                        switch (esc)
                        {
                            case '"': sb.Append('"'); break;
                            case '\\': sb.Append('\\'); break;
                            case '/': sb.Append('/'); break;
                            case 'b': sb.Append('\b'); break;
                            case 'f': sb.Append('\f'); break;
                            case 'n': sb.Append('\n'); break;
                            case 'r': sb.Append('\r'); break;
                            case 't': sb.Append('\t'); break;
                            case 'u':
                                if (i + 4 > s.Length) throw new FormatException("Bad \\u");
                                var hex = s.Substring(i, 4);
                                i += 4;
                                sb.Append((char)int.Parse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                                break;
                            default: throw new FormatException($"Bad escape \\{esc}");
                        }
                    }
                    else
                    {
                        sb.Append(c);
                    }
                }
                throw new FormatException("Unterminated string");
            }

            bool ParseBool()
            {
                if (s.Length - i >= 4 && s.Substring(i, 4) == "true") { i += 4; return true; }
                if (s.Length - i >= 5 && s.Substring(i, 5) == "false") { i += 5; return false; }
                throw new FormatException($"Bad bool at {i}");
            }

            object ParseNull()
            {
                if (s.Length - i >= 4 && s.Substring(i, 4) == "null") { i += 4; return null; }
                throw new FormatException($"Bad null at {i}");
            }

            object ParseNumber()
            {
                int start = i;
                if (s[i] == '-') i++;
                while (i < s.Length && (char.IsDigit(s[i]) || s[i] == '.' || s[i] == 'e' || s[i] == 'E' || s[i] == '+' || s[i] == '-'))
                {
                    i++;
                }
                var slice = s.Substring(start, i - start);
                if (slice.IndexOf('.') >= 0 || slice.IndexOf('e') >= 0 || slice.IndexOf('E') >= 0)
                {
                    return double.Parse(slice, CultureInfo.InvariantCulture);
                }
                if (long.TryParse(slice, NumberStyles.Integer, CultureInfo.InvariantCulture, out var l))
                {
                    if (l >= int.MinValue && l <= int.MaxValue) return (int)l;
                    return l;
                }
                return double.Parse(slice, CultureInfo.InvariantCulture);
            }

            void SkipWs()
            {
                while (i < s.Length)
                {
                    char c = s[i];
                    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
                    else return;
                }
            }
        }
    }
}
