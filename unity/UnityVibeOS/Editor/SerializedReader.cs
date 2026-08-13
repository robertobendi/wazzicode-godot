using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace UnityVibeOS
{
    /// <summary>
    /// Converts a Unity SerializedObject into a JSON-friendly Dictionary&lt;string, object&gt;.
    /// Handles primitives, vectors, colors, references; everything else becomes a stringified placeholder.
    /// </summary>
    public static class SerializedReader
    {
        public static IDictionary<string, object> ReadFields(SerializedObject so, int maxDepth = 6, int maxFields = 256)
        {
            var dict = new Dictionary<string, object>();
            if (so == null) return dict;
            var iter = so.GetIterator();
            // Skip the "m_Script" pseudo-field for clarity, except surface it as `_script`.
            if (iter.NextVisible(true))
            {
                int count = 0;
                do
                {
                    if (count++ >= maxFields) break;
                    if (iter.depth > maxDepth) continue;
                    if (iter.depth > 0) continue; // top-level only; recursive types handled via property type check
                    var name = iter.name;
                    if (name == "m_Script") continue;
                    var val = ReadProperty(iter, maxDepth);
                    dict[name] = val;
                } while (iter.NextVisible(false));
            }
            return dict;
        }

        public static object ReadProperty(SerializedProperty p, int maxDepth)
        {
            if (p == null) return null;
            switch (p.propertyType)
            {
                case SerializedPropertyType.Integer: return p.intValue;
                case SerializedPropertyType.Boolean: return p.boolValue;
                case SerializedPropertyType.Float:
                    return (double)p.floatValue;
                case SerializedPropertyType.String: return p.stringValue;
                case SerializedPropertyType.Character: return ((char)p.intValue).ToString();
                case SerializedPropertyType.Color:
                    var c = p.colorValue;
                    return new Dictionary<string, object>
                    {
                        { "r", (double)c.r }, { "g", (double)c.g }, { "b", (double)c.b }, { "a", (double)c.a }
                    };
                case SerializedPropertyType.ObjectReference:
                    return EncodeObjectReference(p);
                case SerializedPropertyType.Enum:
                    {
                        if (p.enumNames != null && p.enumValueIndex >= 0 && p.enumValueIndex < p.enumNames.Length)
                            return p.enumNames[p.enumValueIndex];
                        return p.intValue;
                    }
                case SerializedPropertyType.Vector2:
                    return new Dictionary<string, object> { { "x", (double)p.vector2Value.x }, { "y", (double)p.vector2Value.y } };
                case SerializedPropertyType.Vector3:
                    return new Dictionary<string, object>
                    {
                        { "x", (double)p.vector3Value.x }, { "y", (double)p.vector3Value.y }, { "z", (double)p.vector3Value.z }
                    };
                case SerializedPropertyType.Vector4:
                    return new Dictionary<string, object>
                    {
                        { "x", (double)p.vector4Value.x }, { "y", (double)p.vector4Value.y },
                        { "z", (double)p.vector4Value.z }, { "w", (double)p.vector4Value.w }
                    };
                case SerializedPropertyType.Quaternion:
                    return new Dictionary<string, object>
                    {
                        { "x", (double)p.quaternionValue.x }, { "y", (double)p.quaternionValue.y },
                        { "z", (double)p.quaternionValue.z }, { "w", (double)p.quaternionValue.w }
                    };
                case SerializedPropertyType.Rect:
                    return new Dictionary<string, object>
                    {
                        { "x", (double)p.rectValue.x }, { "y", (double)p.rectValue.y },
                        { "width", (double)p.rectValue.width }, { "height", (double)p.rectValue.height }
                    };
                case SerializedPropertyType.Bounds:
                    return new Dictionary<string, object>
                    {
                        { "center", new Dictionary<string, object>
                            { { "x", (double)p.boundsValue.center.x }, { "y", (double)p.boundsValue.center.y }, { "z", (double)p.boundsValue.center.z } } },
                        { "size", new Dictionary<string, object>
                            { { "x", (double)p.boundsValue.size.x }, { "y", (double)p.boundsValue.size.y }, { "z", (double)p.boundsValue.size.z } } }
                    };
                case SerializedPropertyType.Vector2Int:
                    return new Dictionary<string, object> { { "x", p.vector2IntValue.x }, { "y", p.vector2IntValue.y } };
                case SerializedPropertyType.Vector3Int:
                    return new Dictionary<string, object>
                    {
                        { "x", p.vector3IntValue.x }, { "y", p.vector3IntValue.y }, { "z", p.vector3IntValue.z }
                    };
                case SerializedPropertyType.RectInt:
                    return new Dictionary<string, object>
                    {
                        { "x", p.rectIntValue.x }, { "y", p.rectIntValue.y },
                        { "width", p.rectIntValue.width }, { "height", p.rectIntValue.height }
                    };
                case SerializedPropertyType.BoundsInt:
                    return new Dictionary<string, object>
                    {
                        { "position", new Dictionary<string, object>
                            { { "x", p.boundsIntValue.position.x }, { "y", p.boundsIntValue.position.y }, { "z", p.boundsIntValue.position.z } } },
                        { "size", new Dictionary<string, object>
                            { { "x", p.boundsIntValue.size.x }, { "y", p.boundsIntValue.size.y }, { "z", p.boundsIntValue.size.z } } }
                    };
                case SerializedPropertyType.LayerMask: return p.intValue;
                case SerializedPropertyType.AnimationCurve: return "<AnimationCurve>";
                case SerializedPropertyType.Gradient: return "<Gradient>";
                case SerializedPropertyType.ExposedReference: return "<ExposedReference>";
                case SerializedPropertyType.FixedBufferSize: return p.fixedBufferSize;
                case SerializedPropertyType.Generic:
                    return ReadGeneric(p, maxDepth);
                case SerializedPropertyType.ArraySize: return p.intValue;
                default:
                    return $"<{p.propertyType}>";
            }
        }

        static object ReadGeneric(SerializedProperty p, int maxDepth)
        {
            if (maxDepth <= 0) return "<truncated>";
            if (p.isArray && p.propertyType == SerializedPropertyType.Generic)
            {
                var list = new List<object>();
                for (int i = 0; i < p.arraySize && i < 64; i++)
                {
                    var element = p.GetArrayElementAtIndex(i);
                    list.Add(ReadProperty(element, maxDepth - 1));
                }
                if (p.arraySize > 64) list.Add($"<+{p.arraySize - 64} more>");
                return list;
            }
            // Dive into child properties.
            var sub = new Dictionary<string, object>();
            var iter = p.Copy();
            var end = p.GetEndProperty();
            if (iter.NextVisible(true))
            {
                int count = 0;
                while (!SerializedProperty.EqualContents(iter, end))
                {
                    if (count++ > 64) break;
                    sub[iter.name] = ReadProperty(iter, maxDepth - 1);
                    if (!iter.NextVisible(false)) break;
                }
            }
            return sub;
        }

        static object EncodeObjectReference(SerializedProperty p)
        {
            var obj = p.objectReferenceValue;
            // p.objectReferenceInstanceIDValue != 0 with null obj => missing reference.
            if (obj == null)
            {
                if (p.objectReferenceInstanceIDValue != 0)
                {
                    return new Dictionary<string, object>
                    {
                        { "referenceType", "Missing" },
                        { "name", null }
                    };
                }
                return null;
            }
            string referenceType = "Asset";
            if (obj is GameObject) referenceType = "GameObject";
            else if (obj is Component) referenceType = "Component";
            else if (obj is ScriptableObject) referenceType = "ScriptableObject";

            string assetPath = AssetDatabase.GetAssetPath(obj);
            string guid = !string.IsNullOrEmpty(assetPath) ? AssetDatabase.AssetPathToGUID(assetPath) : "";

            string scenePath = null;
            if (obj is GameObject go) scenePath = SceneInspector.PathOf(go);
            else if (obj is Component cmp && cmp != null && cmp.gameObject != null) scenePath = SceneInspector.PathOf(cmp.gameObject);

            var d = new Dictionary<string, object>
            {
                { "referenceType", referenceType },
                { "name", obj.name },
                { "type", obj.GetType().Name }
            };
            if (!string.IsNullOrEmpty(assetPath)) d["path"] = assetPath;
            else if (!string.IsNullOrEmpty(scenePath)) d["path"] = scenePath;
            if (!string.IsNullOrEmpty(guid)) d["guid"] = guid;
            return d;
        }
    }
}
