using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using static UnityVibeOS.BridgeParams;

namespace UnityVibeOS
{
    /// <summary>
    /// Queries the live type system of the running Editor — every assembly actually loaded for THIS
    /// project, including the exact installed Unity + package versions. This is the antidote to
    /// hallucinated APIs: before writing C#, confirm a type/member exists and read its real
    /// signature here, rather than guessing from memory. Three actions:
    ///   search    — find types whose name matches a query (scoped unity/project/packages/all).
    ///   get_type  — list a type's public members (methods/properties/fields), base type, interfaces.
    ///   get_member — full signatures (incl. overloads) of one member of a type.
    /// </summary>
    public static class ReflectionBridge
    {
        public static object Handle(IDictionary<string, object> p)
        {
            string action = (Str(p, "action") ?? "search").Trim();
            switch (action)
            {
                case "search": return Search(p);
                case "get_type": return GetTypeInfo(p);
                case "get_member": return GetMember(p);
                default:
                    throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", $"Unknown reflect action '{action}'. Use search|get_type|get_member.");
            }
        }

        static object Search(IDictionary<string, object> p)
        {
            string query = Str(p, "query");
            if (string.IsNullOrEmpty(query)) throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", "search needs 'query'.");
            string scope = (Str(p, "scope") ?? "all").Trim().ToLowerInvariant();
            int limit = GetInt(p, "limit", 50);
            bool exact = GetBool(p, "exact", false);

            var hits = new List<object>();
            bool truncated = false;
            foreach (var asm in Assemblies(scope))
            {
                Type[] types;
                try { types = asm.GetTypes(); }
                catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray(); }
                catch { continue; }
                foreach (var t in types)
                {
                    if (t == null || !t.IsPublic) continue;
                    bool match = exact
                        ? string.Equals(t.Name, query, StringComparison.OrdinalIgnoreCase) || string.Equals(t.FullName, query, StringComparison.OrdinalIgnoreCase)
                        : (t.Name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 || (t.FullName ?? "").IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0);
                    if (!match) continue;
                    if (hits.Count >= limit) { truncated = true; break; }
                    hits.Add(new Dictionary<string, object>
                    {
                        { "name", t.Name },
                        { "fullName", t.FullName },
                        { "namespace", t.Namespace ?? "" },
                        { "kind", KindOf(t) },
                        { "assembly", asm.GetName().Name }
                    });
                }
                if (truncated) break;
            }
            // Exact/short matches first, then alphabetical, so the obvious type floats to the top.
            return new Dictionary<string, object>
            {
                { "query", query },
                { "scope", scope },
                { "matchCount", hits.Count },
                { "types", hits },
                { "truncated", truncated }
            };
        }

        static object GetTypeInfo(IDictionary<string, object> p)
        {
            string typeName = Str(p, "type");
            if (string.IsNullOrEmpty(typeName)) throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", "get_type needs 'type'.");
            var t = ResolveType(typeName);
            if (t == null) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"No public type named '{typeName}' is loaded. Try unity_reflect search first.");
            bool includeInherited = GetBool(p, "includeInherited", false);
            int limit = GetInt(p, "limit", 200);
            var flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | (includeInherited ? BindingFlags.FlattenHierarchy : BindingFlags.DeclaredOnly);

            var methods = t.GetMethods(flags).Where(m => !m.IsSpecialName).Take(limit)
                .Select(m => (object)MethodSig(m)).ToList();
            var properties = t.GetProperties(flags).Take(limit).Select(pr => (object)new Dictionary<string, object>
            {
                { "name", pr.Name }, { "type", FriendlyType(pr.PropertyType) },
                { "canRead", pr.CanRead }, { "canWrite", pr.CanWrite },
                { "static", (pr.GetGetMethod(true)?.IsStatic ?? pr.GetSetMethod(true)?.IsStatic) ?? false }
            }).ToList();
            var fields = t.GetFields(flags).Where(f => !f.IsSpecialName).Take(limit).Select(f => (object)new Dictionary<string, object>
            {
                { "name", f.Name }, { "type", FriendlyType(f.FieldType) }, { "static", f.IsStatic }, { "const", f.IsLiteral }
            }).ToList();

            return new Dictionary<string, object>
            {
                { "name", t.Name },
                { "fullName", t.FullName },
                { "namespace", t.Namespace ?? "" },
                { "kind", KindOf(t) },
                { "assembly", t.Assembly.GetName().Name },
                { "baseType", t.BaseType?.FullName },
                { "interfaces", t.GetInterfaces().Select(i => i.Name).Take(40).ToList() },
                { "isAbstract", t.IsAbstract },
                { "methods", methods },
                { "properties", properties },
                { "fields", fields }
            };
        }

        static object GetMember(IDictionary<string, object> p)
        {
            string typeName = Str(p, "type");
            string memberName = Str(p, "member");
            if (string.IsNullOrEmpty(typeName) || string.IsNullOrEmpty(memberName))
                throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", "get_member needs 'type' and 'member'.");
            var t = ResolveType(typeName);
            if (t == null) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"No public type named '{typeName}' is loaded.");
            var flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy;

            var overloads = t.GetMethods(flags).Where(m => m.Name == memberName && !m.IsSpecialName)
                .Select(m => (object)MethodSig(m)).ToList();
            var props = t.GetProperties(flags).Where(pr => pr.Name == memberName).Select(pr => (object)new Dictionary<string, object>
            {
                { "kind", "property" }, { "name", pr.Name }, { "type", FriendlyType(pr.PropertyType) }, { "canRead", pr.CanRead }, { "canWrite", pr.CanWrite }
            }).ToList();
            var fields = t.GetFields(flags).Where(f => f.Name == memberName).Select(f => (object)new Dictionary<string, object>
            {
                { "kind", "field" }, { "name", f.Name }, { "type", FriendlyType(f.FieldType) }, { "static", f.IsStatic }
            }).ToList();

            if (overloads.Count == 0 && props.Count == 0 && fields.Count == 0)
                throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"'{t.Name}' has no public member named '{memberName}'.");

            return new Dictionary<string, object>
            {
                { "type", t.FullName },
                { "member", memberName },
                { "methods", overloads },
                { "properties", props },
                { "fields", fields }
            };
        }

        // ---------- helpers ----------

        static IEnumerable<Assembly> Assemblies(string scope)
        {
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                string name = asm.GetName().Name ?? "";
                bool isUnity = name.StartsWith("UnityEngine") || name.StartsWith("UnityEditor") || name.StartsWith("Unity.");
                bool isProject = name == "Assembly-CSharp" || name == "Assembly-CSharp-Editor" || name.StartsWith("Assembly-CSharp");
                switch (scope)
                {
                    case "unity": if (isUnity) yield return asm; break;
                    case "project": if (isProject) yield return asm; break;
                    case "packages": if (!isUnity && !isProject) yield return asm; break;
                    default: yield return asm; break;
                }
            }
        }

        static Type ResolveType(string name)
        {
            // Try fully-qualified first, then by simple/full name across all loaded assemblies.
            var direct = Type.GetType(name, false);
            if (direct != null) return direct;
            Type byFull = null, bySimple = null;
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = asm.GetTypes(); }
                catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray(); }
                catch { continue; }
                foreach (var t in types)
                {
                    if (t == null) continue;
                    if (t.FullName == name) return t;
                    if (byFull == null && string.Equals(t.FullName, name, StringComparison.OrdinalIgnoreCase)) byFull = t;
                    if (bySimple == null && string.Equals(t.Name, name, StringComparison.Ordinal) && t.IsPublic) bySimple = t;
                }
            }
            return byFull ?? bySimple;
        }

        static Dictionary<string, object> MethodSig(MethodInfo m)
        {
            return new Dictionary<string, object>
            {
                { "name", m.Name },
                { "returnType", FriendlyType(m.ReturnType) },
                { "static", m.IsStatic },
                { "parameters", m.GetParameters().Select(par => (object)new Dictionary<string, object>
                    {
                        { "name", par.Name },
                        { "type", FriendlyType(par.ParameterType) },
                        { "optional", par.IsOptional },
                        { "params", par.GetCustomAttributes(typeof(ParamArrayAttribute), false).Length > 0 }
                    }).ToList() },
                { "signature", $"{(m.IsStatic ? "static " : "")}{FriendlyType(m.ReturnType)} {m.Name}({string.Join(", ", m.GetParameters().Select(par => $"{FriendlyType(par.ParameterType)} {par.Name}"))})" }
            };
        }

        static string KindOf(Type t)
        {
            if (t.IsEnum) return "enum";
            if (t.IsInterface) return "interface";
            if (t.IsValueType) return "struct";
            return "class";
        }

        static string FriendlyType(Type t)
        {
            if (t == null) return "void";
            if (t == typeof(void)) return "void";
            if (t.IsGenericType)
            {
                string baseName = t.Name;
                int tick = baseName.IndexOf('`');
                if (tick > 0) baseName = baseName.Substring(0, tick);
                var args = t.GetGenericArguments().Select(FriendlyType);
                return $"{baseName}<{string.Join(", ", args)}>";
            }
            switch (t.Name)
            {
                case "Int32": return "int";
                case "Int64": return "long";
                case "Single": return "float";
                case "Double": return "double";
                case "Boolean": return "bool";
                case "String": return "string";
                case "Object": return t.Namespace == "System" ? "object" : t.Name;
                default: return t.Name;
            }
        }

    }
}
