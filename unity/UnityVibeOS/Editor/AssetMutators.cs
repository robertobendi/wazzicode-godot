using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;
using static UnityVibeOS.BridgeParams;

namespace UnityVibeOS
{
    /// <summary>
    /// Write operations that create assets (ScriptableObjects, materials, prefab variants) or
    /// instantiate prefabs into the scene. Asset creations are persisted immediately; scene
    /// instantiations are Undo-wrapped and mark the scene dirty. Gated by safetyMode at the MCP
    /// layer (asset target needs confirm/autopilot; prefab target also needs allowPrefabWrites).
    /// </summary>
    public static class AssetMutators
    {
        public static IDictionary<string, object> InstantiatePrefab(IDictionary<string, object> p)
        {
            string prefabPath = ResolveAssetPath(p, "prefabPath", "prefabGuid");
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
            if (prefab == null) throw new BridgeRouter.HandlerError("ASSET_NOT_FOUND", $"No prefab at '{prefabPath}'.");

            var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            if (instance == null) throw new BridgeRouter.HandlerError("INTERNAL_ERROR", "InstantiatePrefab returned null.");

            string name = Str(p, "name");
            if (!string.IsNullOrEmpty(name)) instance.name = name;

            string parentPath = Str(p, "parentPath");
            if (!string.IsNullOrEmpty(parentPath))
            {
                var parent = FindByPath(parentPath);
                if (parent == null)
                {
                    UnityEngine.Object.DestroyImmediate(instance);
                    throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"Parent '{parentPath}' not found.");
                }
                instance.transform.SetParent(parent.transform, false);
            }

            Undo.RegisterCreatedObjectUndo(instance, $"UnityVibeOS instantiate {prefab.name}");
            string dirtied = null;
            if (instance.scene.IsValid())
            {
                UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(instance.scene);
                dirtied = instance.scene.path;
            }
            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", $"Instantiated prefab '{prefab.name}' into the scene" },
                { "createdPath", SceneInspector.PathOf(instance) },
                { "sceneDirtied", dirtied },
                { "undoable", true }
            };
        }

        public static IDictionary<string, object> CreateScriptableObject(IDictionary<string, object> p)
        {
            string typeName = Str(p, "type");
            if (string.IsNullOrEmpty(typeName)) throw Invalid("Missing 'type' (ScriptableObject type name).");
            string path = RequireWritablePath(p, ".asset");

            Type type = null;
            foreach (var t in TypeCache.GetTypesDerivedFrom<ScriptableObject>())
            {
                if (t.Name == typeName || t.FullName == typeName) { type = t; break; }
            }
            if (type == null) throw new BridgeRouter.HandlerError("OBJECT_NOT_FOUND", $"ScriptableObject type '{typeName}' not found.");

            var so = ScriptableObject.CreateInstance(type);
            string unique = AssetDatabase.GenerateUniqueAssetPath(path);
            AssetDatabase.CreateAsset(so, unique);
            AssetDatabase.SaveAssets();
            return CreatedAsset($"Created {typeName} asset", unique);
        }

        public static IDictionary<string, object> CreateMaterial(IDictionary<string, object> p)
        {
            string path = RequireWritablePath(p, ".mat");
            string shaderName = Str(p, "shader");
            Shader shader = !string.IsNullOrEmpty(shaderName) ? Shader.Find(shaderName) : null;
            if (shader == null)
            {
                // Pick a sensible default for the active pipeline.
                shader = Shader.Find("Universal Render Pipeline/Lit")
                         ?? Shader.Find("HDRP/Lit")
                         ?? Shader.Find("Standard");
            }
            if (shader == null) throw new BridgeRouter.HandlerError("FEATURE_UNAVAILABLE", "Could not find a default shader to create the material.");

            var mat = new Material(shader);
            string unique = AssetDatabase.GenerateUniqueAssetPath(path);
            AssetDatabase.CreateAsset(mat, unique);
            AssetDatabase.SaveAssets();
            return CreatedAsset($"Created material with shader '{shader.name}'", unique);
        }

        public static IDictionary<string, object> CreatePrefabVariant(IDictionary<string, object> p)
        {
            string sourcePath = ResolveAssetPath(p, "sourcePath", "sourceGuid");
            var source = AssetDatabase.LoadAssetAtPath<GameObject>(sourcePath);
            if (source == null) throw new BridgeRouter.HandlerError("ASSET_NOT_FOUND", $"No prefab at '{sourcePath}'.");
            string path = RequireWritablePath(p, ".prefab");
            string unique = AssetDatabase.GenerateUniqueAssetPath(path);

            // Instantiate the base prefab, then save the instance as a new asset: because the
            // instance is a prefab instance, SaveAsPrefabAsset produces a variant of the source.
            var instance = (GameObject)PrefabUtility.InstantiatePrefab(source);
            try
            {
                var variant = PrefabUtility.SaveAsPrefabAsset(instance, unique, out bool success);
                if (!success || variant == null)
                    throw new BridgeRouter.HandlerError("INTERNAL_ERROR", $"Failed to save prefab variant at '{unique}'.");
                return CreatedAsset($"Created prefab variant of '{source.name}'", unique);
            }
            finally
            {
                if (instance != null) UnityEngine.Object.DestroyImmediate(instance);
            }
        }

        public static IDictionary<string, object> DeleteAsset(IDictionary<string, object> p)
        {
            string path = Str(p, "path");
            string guid = Str(p, "guid");
            if (string.IsNullOrEmpty(path) && !string.IsNullOrEmpty(guid)) path = AssetDatabase.GUIDToAssetPath(guid);
            if (string.IsNullOrEmpty(path)) throw Invalid("Missing 'path' (or 'guid') of the asset to delete.");
            path = path.Replace('\\', '/');
            if (!path.StartsWith("Assets/")) throw Invalid("'path' must be under Assets/.");
            if (string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(path)))
                throw new BridgeRouter.HandlerError("ASSET_NOT_FOUND", $"No asset at '{path}'.");

            // Default to the OS trash (recoverable); 'permanent:true' deletes outright.
            bool permanent = p != null && p.TryGetValue("permanent", out var pv) && pv != null && Convert.ToBoolean(pv);
            bool ok = permanent ? AssetDatabase.DeleteAsset(path) : AssetDatabase.MoveAssetToTrash(path);
            if (!ok) throw new BridgeRouter.HandlerError("INTERNAL_ERROR", $"Failed to delete asset '{path}'.");

            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", $"Deleted asset {path}{(permanent ? " (permanently)" : " (moved to OS trash)")}" },
                { "target", path },
                { "undoable", false }
            };
        }

        public static IDictionary<string, object> ImportAsset(IDictionary<string, object> p)
        {
            string path = Str(p, "path");
            if (string.IsNullOrEmpty(path)) throw Invalid("Missing 'path' (project-relative, under Assets/).");
            path = path.Replace('\\', '/');
            if (!path.StartsWith("Assets/")) throw Invalid("'path' must be under Assets/.");

            string sourcePath = Str(p, "sourcePath");
            if (!string.IsNullOrEmpty(sourcePath))
            {
                if (!File.Exists(sourcePath))
                    throw new BridgeRouter.HandlerError("ASSET_NOT_FOUND", $"Source file '{sourcePath}' does not exist.");
                EnsureFolder(Path.GetDirectoryName(path).Replace('\\', '/'));
                string projectRoot = Path.GetDirectoryName(Application.dataPath); // <project>/Assets → <project>
                string destAbs = Path.Combine(projectRoot, path);
                File.Copy(sourcePath, destAbs, true);
            }
            else if (!File.Exists(path) && !Directory.Exists(path))
            {
                throw new BridgeRouter.HandlerError("ASSET_NOT_FOUND", $"Nothing at '{path}' to import. Provide 'sourcePath' to copy a file in first.");
            }

            bool recursive = p != null && p.TryGetValue("recursive", out var rv) && rv != null && Convert.ToBoolean(rv);
            AssetDatabase.ImportAsset(path, recursive ? ImportAssetOptions.ImportRecursive : ImportAssetOptions.Default);

            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", $"Imported {path}{(string.IsNullOrEmpty(sourcePath) ? "" : $" (copied from {sourcePath})")}" },
                { "createdPath", path },
                { "target", path },
                { "undoable", false }
            };
        }

        public static IDictionary<string, object> SliceSprite(IDictionary<string, object> p)
        {
            string texturePath = Str(p, "texturePath");
            if (string.IsNullOrEmpty(texturePath)) throw Invalid("Missing 'texturePath'.");
            texturePath = texturePath.Replace('\\', '/');

            var importer = AssetImporter.GetAtPath(texturePath) as TextureImporter;
            if (importer == null)
                throw new BridgeRouter.HandlerError("ASSET_NOT_FOUND", $"No importable texture at '{texturePath}'.");
            var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(texturePath);
            if (texture == null)
                throw new BridgeRouter.HandlerError("ASSET_NOT_FOUND", $"Could not load texture at '{texturePath}'.");

            int texW = texture.width, texH = texture.height;
            int offsetX = Int(p, "offsetX", 0), offsetY = Int(p, "offsetY", 0);
            int padX = Int(p, "paddingX", 0), padY = Int(p, "paddingY", 0);
            string mode = Str(p, "mode") ?? "grid_by_cell_size";

            int cellW, cellH, cols, rows;
            if (mode == "grid_by_cell_count")
            {
                cols = Int(p, "columns", 0); rows = Int(p, "rows", 0);
                if (cols <= 0 || rows <= 0) throw Invalid("grid_by_cell_count needs positive 'columns' and 'rows'.");
                cellW = (texW - offsetX - (cols - 1) * padX) / cols;
                cellH = (texH - offsetY - (rows - 1) * padY) / rows;
            }
            else
            {
                cellW = Int(p, "cellWidth", 0); cellH = Int(p, "cellHeight", 0);
                if (cellW <= 0 || cellH <= 0) throw Invalid("grid_by_cell_size needs positive 'cellWidth' and 'cellHeight'.");
                cols = (texW - offsetX + padX) / (cellW + padX);
                rows = (texH - offsetY + padY) / (cellH + padY);
            }
            if (cellW <= 0 || cellH <= 0 || cols <= 0 || rows <= 0)
                throw Invalid("Computed a non-positive grid; check cell size / counts against the texture dimensions.");

            float ppu = (float)DoubleOr(p, "pixelsPerUnit", 100.0);
            int alignment = (int)PivotAlignment(Str(p, "pivot") ?? "Center");

            string baseName = Path.GetFileNameWithoutExtension(texturePath);
            var metas = new List<SpriteMetaData>();
            // Unity sprite rects use a bottom-left origin; iterate rows top→bottom for natural names.
            for (int r = 0; r < rows; r++)
            {
                for (int c = 0; c < cols; c++)
                {
                    int x = offsetX + c * (cellW + padX);
                    int yTop = offsetY + r * (cellH + padY);
                    int y = texH - yTop - cellH; // flip to bottom-left origin
                    if (y < 0 || x + cellW > texW) continue;
                    metas.Add(new SpriteMetaData
                    {
                        name = $"{baseName}_{r * cols + c}",
                        rect = new Rect(x, y, cellW, cellH),
                        alignment = alignment,
                        pivot = PivotVector(alignment)
                    });
                }
            }
            if (metas.Count == 0) throw Invalid("Slicing produced 0 sprites — check the grid parameters.");

            importer.textureType = TextureImporterType.Sprite;
            importer.spriteImportMode = SpriteImportMode.Multiple;
            importer.spritePixelsPerUnit = ppu;
#pragma warning disable 618 // SpriteMetaData[]/spritesheet: still the simplest reliable grid-slice path.
            importer.spritesheet = metas.ToArray();
#pragma warning restore 618
            EditorUtility.SetDirty(importer);
            importer.SaveAndReimport();

            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", $"Sliced {texturePath} into {metas.Count} sprites ({cols}x{rows} grid)" },
                { "target", texturePath },
                { "spriteCount", metas.Count },
                { "undoable", false }
            };
        }

        // ---- helpers ----

        static UnityEngine.SpriteAlignment PivotAlignment(string pivot)
        {
            switch (pivot)
            {
                case "TopLeft": return UnityEngine.SpriteAlignment.TopLeft;
                case "Top": return UnityEngine.SpriteAlignment.TopCenter;
                case "TopRight": return UnityEngine.SpriteAlignment.TopRight;
                case "Left": return UnityEngine.SpriteAlignment.LeftCenter;
                case "Right": return UnityEngine.SpriteAlignment.RightCenter;
                case "BottomLeft": return UnityEngine.SpriteAlignment.BottomLeft;
                case "Bottom": return UnityEngine.SpriteAlignment.BottomCenter;
                case "BottomRight": return UnityEngine.SpriteAlignment.BottomRight;
                default: return UnityEngine.SpriteAlignment.Center;
            }
        }

        static Vector2 PivotVector(int alignment)
        {
            switch ((UnityEngine.SpriteAlignment)alignment)
            {
                case UnityEngine.SpriteAlignment.TopLeft: return new Vector2(0f, 1f);
                case UnityEngine.SpriteAlignment.TopCenter: return new Vector2(0.5f, 1f);
                case UnityEngine.SpriteAlignment.TopRight: return new Vector2(1f, 1f);
                case UnityEngine.SpriteAlignment.LeftCenter: return new Vector2(0f, 0.5f);
                case UnityEngine.SpriteAlignment.RightCenter: return new Vector2(1f, 0.5f);
                case UnityEngine.SpriteAlignment.BottomLeft: return new Vector2(0f, 0f);
                case UnityEngine.SpriteAlignment.BottomCenter: return new Vector2(0.5f, 0f);
                case UnityEngine.SpriteAlignment.BottomRight: return new Vector2(1f, 0f);
                default: return new Vector2(0.5f, 0.5f);
            }
        }

        static double DoubleOr(IDictionary<string, object> p, string key, double def)
        {
            if (p == null || !p.TryGetValue(key, out var v) || v == null) return def;
            try { return Convert.ToDouble(v); } catch { return def; }
        }

        static IDictionary<string, object> CreatedAsset(string summary, string path)
        {
            return new Dictionary<string, object>
            {
                { "applied", true },
                { "summary", $"{summary} at {path}" },
                { "createdPath", path },
                { "undoable", false }
            };
        }

        static string ResolveAssetPath(IDictionary<string, object> p, string pathKey, string guidKey)
        {
            string path = Str(p, pathKey);
            string guid = Str(p, guidKey);
            if (string.IsNullOrEmpty(path) && !string.IsNullOrEmpty(guid)) path = AssetDatabase.GUIDToAssetPath(guid);
            if (string.IsNullOrEmpty(path)) throw Invalid($"Missing '{pathKey}' (or '{guidKey}').");
            return path;
        }

        static string RequireWritablePath(IDictionary<string, object> p, string requiredExt)
        {
            string path = Str(p, "path");
            if (string.IsNullOrEmpty(path)) throw Invalid("Missing 'path' (project-relative, under Assets/).");
            path = path.Replace('\\', '/');
            if (!path.StartsWith("Assets/")) throw Invalid("'path' must be under Assets/.");
            if (!path.EndsWith(requiredExt, StringComparison.OrdinalIgnoreCase))
                throw Invalid($"'path' must end with {requiredExt}.");
            EnsureFolder(Path.GetDirectoryName(path).Replace('\\', '/'));
            return path;
        }

        static void EnsureFolder(string folder)
        {
            if (string.IsNullOrEmpty(folder) || folder == "Assets") return;
            if (AssetDatabase.IsValidFolder(folder)) return;
            string parent = Path.GetDirectoryName(folder).Replace('\\', '/');
            string leaf = Path.GetFileName(folder);
            EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, leaf);
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

        static BridgeRouter.HandlerError Invalid(string msg) => new BridgeRouter.HandlerError("INVALID_ARGUMENT", msg);
    }
}
