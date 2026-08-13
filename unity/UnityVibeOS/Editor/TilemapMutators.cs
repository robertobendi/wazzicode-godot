using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.Tilemaps;
using static UnityVibeOS.BridgeParams;

namespace UnityVibeOS
{
    /// <summary>
    /// Tilemap painting: stamp (or erase) a tile asset onto cells of a scene Tilemap. Undo-wrapped
    /// and gated as a scene write at the MCP layer. UnityEngine.Tilemaps is an engine module, so it
    /// is referenced directly.
    /// </summary>
    public static class TilemapMutators
    {
        public static IDictionary<string, object> PaintTilemap(IDictionary<string, object> p)
        {
            var go = RequireTarget(p);
            var tilemap = go.GetComponent<Tilemap>();
            if (tilemap == null)
                throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"No Tilemap component on '{go.name}'.");

            bool erase = p.TryGetValue("erase", out var ev) && ev != null && Convert.ToBoolean(ev);
            TileBase tile = null;
            string tileAssetPath = Str(p, "tileAssetPath");
            if (!erase)
            {
                if (string.IsNullOrEmpty(tileAssetPath))
                    throw Invalid("Provide 'tileAssetPath' to paint, or set erase:true to clear cells.");
                tile = AssetDatabase.LoadAssetAtPath<TileBase>(tileAssetPath.Replace('\\', '/'));
                if (tile == null)
                    throw new BridgeRouter.HandlerError("ASSET_NOT_FOUND", $"No TileBase asset at '{tileAssetPath}'.");
            }

            var cells = CollectCells(p);
            if (cells.Count == 0) throw Invalid("No cells given. Provide 'cells' [{x,y,z?}] or a 'rect' {x,y,width,height}.");

            Undo.RecordObject(tilemap, erase ? "UnityVibeOS erase tiles" : "UnityVibeOS paint tiles");
            foreach (var cell in cells) tilemap.SetTile(cell, tile);
            EditorUtility.SetDirty(tilemap);
            string dirtied = go.scene.IsValid() ? go.scene.path : null;
            if (go.scene.IsValid()) UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);

            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", $"{(erase ? "Erased" : "Painted")} {cells.Count} cell(s) on {SceneInspector.PathOf(go)}{(erase ? "" : $" with {tile.name}")}" },
                { "target", SceneInspector.PathOf(go) },
                { "cellsAffected", cells.Count },
                { "sceneDirtied", dirtied },
                { "undoable", true }
            };
        }

        static List<Vector3Int> CollectCells(IDictionary<string, object> p)
        {
            var result = new List<Vector3Int>();
            if (p.TryGetValue("cells", out var raw) && raw is List<object> list)
            {
                foreach (var item in list)
                {
                    if (item is Dictionary<string, object> d)
                        result.Add(new Vector3Int(IntOf(d, "x", 0), IntOf(d, "y", 0), IntOf(d, "z", 0)));
                }
            }
            if (p.TryGetValue("rect", out var rraw) && rraw is Dictionary<string, object> rect)
            {
                int x = IntOf(rect, "x", 0), y = IntOf(rect, "y", 0), z = IntOf(rect, "z", 0);
                int w = IntOf(rect, "width", 0), h = IntOf(rect, "height", 0);
                for (int dx = 0; dx < w; dx++)
                    for (int dy = 0; dy < h; dy++)
                        result.Add(new Vector3Int(x + dx, y + dy, z));
            }
            return result;
        }

        static GameObject RequireTarget(IDictionary<string, object> p)
        {
            int instanceId = Int(p, "tilemapInstanceId", 0);
            string path = Str(p, "tilemapPath");
            GameObject go = null;
            if (instanceId != 0) go = EditorCompat.IdToObject(instanceId) as GameObject;
            if (go == null && !string.IsNullOrEmpty(path)) go = FindByPath(path);
            if (go == null && instanceId == 0 && string.IsNullOrEmpty(path)) go = Selection.activeGameObject;
            if (go == null)
                throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", "Tilemap GameObject not found (provide tilemapInstanceId or tilemapPath, or select one).");
            return go;
        }

        static GameObject FindByPath(string path)
        {
            foreach (var go in Resources.FindObjectsOfTypeAll<GameObject>())
            {
                if (go == null || !go.scene.IsValid()) continue;
                if ((go.hideFlags & HideFlags.HideAndDontSave) != 0) continue;
                if (SceneInspector.PathOf(go) == path) return go;
            }
            return null;
        }

        static int IntOf(Dictionary<string, object> d, string key, int def)
        {
            if (d == null || !d.TryGetValue(key, out var v) || v == null) return def;
            try { return (int)Convert.ToInt64(v); } catch { return def; }
        }

        static BridgeRouter.HandlerError Invalid(string msg) => new BridgeRouter.HandlerError("INVALID_ARGUMENT", msg);
    }
}
