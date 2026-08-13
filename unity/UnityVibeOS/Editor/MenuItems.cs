using UnityEditor;
using UnityEngine;

namespace UnityVibeOS
{
    public static class MenuItems
    {
        const string Root = "Window/Unity Vibe OS/";

        [MenuItem(Root + "Status")]
        static void ShowStatus()
        {
            string msg =
                $"Unity Vibe OS\n" +
                $"\n" +
                $"Bridge:        {(BridgeServer.IsRunning ? "running" : "stopped")}\n" +
                $"Address:       {BridgeServer.Host}:{BridgeServer.Port}\n" +
                $"Uptime:        {BridgeServer.UptimeMs / 1000}s\n" +
                $"Keep awake:    {(BackgroundKeepAlive.Enabled ? "on (runs unfocused)" : "off")}\n" +
                $"Console buffer:{ConsoleCapture.BufferSize}\n" +
                $"Compiling:     {EditorApplication.isCompiling}\n" +
                $"Unity version: {Application.unityVersion}\n" +
                $"Project path:  {ProjectInfo.ProjectPath}";
            EditorUtility.DisplayDialog("Unity Vibe OS", msg, "OK");
        }

        [MenuItem(Root + "Restart Bridge")]
        static void RestartBridge()
        {
            BridgeServer.Stop();
            EditorApplication.delayCall += () => BridgeServer.Start();
        }

        [MenuItem(Root + "Stop Bridge")]
        static void StopBridge()
        {
            BridgeServer.Stop();
        }

        [MenuItem(Root + "Start Bridge")]
        static void StartBridge()
        {
            BridgeServer.Start();
        }

        // Checkmark toggle: keep the Editor processing the bridge while it is not focused,
        // so you don't have to click back into Unity for tool calls to run.
        const string KeepAwakeItem = Root + "Keep Unity Awake (background)";

        [MenuItem(KeepAwakeItem)]
        static void ToggleKeepAwake()
        {
            BackgroundKeepAlive.Enabled = !BackgroundKeepAlive.Enabled;
        }

        [MenuItem(KeepAwakeItem, true)]
        static bool ToggleKeepAwakeValidate()
        {
            Menu.SetChecked(KeepAwakeItem, BackgroundKeepAlive.Enabled);
            return true;
        }
    }
}
