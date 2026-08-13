using System.Collections.Generic;
using UnityEditor;

namespace UnityVibeOS
{
    /// <summary>
    /// Generic Editor escape hatch: execute a menu command by path. The allowlist that decides
    /// WHICH menu items may run lives in .unity-vibe/config.json and is enforced on the MCP side
    /// (the bridge trusts the call, like every other write). This just invokes the command and
    /// reports whether Unity accepted it.
    /// </summary>
    public static class MenuBridge
    {
        public static IDictionary<string, object> ExecuteMenuItem(IDictionary<string, object> p)
        {
            string menuItem = p != null && p.TryGetValue("menuItem", out var v) && v != null ? v.ToString() : null;
            if (string.IsNullOrEmpty(menuItem))
                throw new BridgeRouter.HandlerError("INVALID_ARGUMENT", "Missing 'menuItem' (the menu path to execute).");

            bool executed = EditorApplication.ExecuteMenuItem(menuItem);
            return new Dictionary<string, object>
            {
                { "applied", executed },
                { "executed", executed },
                { "menuItem", menuItem },
                { "summary", executed ? $"Executed menu item '{menuItem}'" : $"Menu item '{menuItem}' was not found or could not run" }
            };
        }
    }
}
