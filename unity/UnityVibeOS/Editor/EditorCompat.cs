using UnityEditor;
using UnityEngine;

namespace UnityVibeOS
{
    /// <summary>
    /// Small shims over Editor APIs that changed across Unity versions, so call sites stay clean
    /// and warning-free. Unity 6.1 renamed instance IDs to "entity IDs" and marked
    /// <c>EditorUtility.InstanceIDToObject</c> obsolete; it still functions on every supported
    /// version, so we route through it with the obsolete warning locally suppressed.
    /// </summary>
    internal static class EditorCompat
    {
        public static Object IdToObject(int id)
        {
#pragma warning disable CS0618
            return EditorUtility.InstanceIDToObject(id);
#pragma warning restore CS0618
        }
    }
}
