using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace UnityVibeOS
{
    /// <summary>
    /// Tiny per-OS glue that keeps the backgrounded Unity process running normally, so the bridge
    /// stays live while you're focused on another app (a game, a browser…). Two operations, each a
    /// safe no-op off its platform or if the OS API is missing:
    ///
    ///   • <see cref="KeepUnthrottled"/> — stop the OS from throttling a background app's CPU.
    ///     Windows demotes background processes into EcoQoS; macOS uses App Nap. Both get turned off
    ///     while keep-alive is on, so a woken editor runs at full speed instead of crawling.
    ///   • <see cref="WakePump"/> — Windows only: when Unity is unfocused/minimised its message pump
    ///     blocks and the editor stops ticking, so queued bridge work never runs until you click in.
    ///     A benign WM_NULL post wakes it. macOS keeps ticking once App Nap is off, so this is a
    ///     no-op there.
    /// </summary>
    public static class BackgroundPower
    {
        static readonly bool IsWindows = RuntimeInformation.IsOSPlatform(OSPlatform.Windows);
        static readonly bool IsMac = RuntimeInformation.IsOSPlatform(OSPlatform.OSX);

        static IntPtr _hwnd;          // cached Windows main window
        static IntPtr _macActivity;   // macOS App-Nap-off activity token
        const ulong MacUserInitiatedAllowingIdleSystemSleep = 0x00EFFFFFUL;

        /// <summary>Turn OS background CPU throttling off (<paramref name="on"/>=true) or back to default.</summary>
        public static void KeepUnthrottled(bool on)
        {
            try
            {
                if (IsWindows) WinSetThrottle(!on);
                else if (IsMac) MacSetAppNap(!on);
            }
            catch { /* API unavailable on this OS version — ignore */ }
        }

        /// <summary>Wake a frozen (Windows) message pump so the editor runs a tick. No-op elsewhere.</summary>
        public static void WakePump()
        {
            if (!IsWindows) return;
            try
            {
                if (_hwnd == IntPtr.Zero) _hwnd = Process.GetCurrentProcess().MainWindowHandle;
                if (_hwnd != IntPtr.Zero) PostMessage(_hwnd, 0x0000 /*WM_NULL*/, IntPtr.Zero, IntPtr.Zero);
            }
            catch { _hwnd = IntPtr.Zero; }
        }

        // ---- Windows: EcoQoS ----

        static void WinSetThrottle(bool throttle)
        {
            // ControlMask picks EXECUTION_SPEED; StateMask=0 means "don't throttle", =1 restores default.
            var s = new PROCESS_POWER_THROTTLING_STATE
            {
                Version = 1,
                ControlMask = 0x1,                 // PROCESS_POWER_THROTTLING_EXECUTION_SPEED
                StateMask = throttle ? 0x1u : 0u,
            };
            SetProcessInformation(GetCurrentProcess(), 4 /*ProcessPowerThrottling*/, ref s, (uint)Marshal.SizeOf(s));
        }

        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_POWER_THROTTLING_STATE { public uint Version, ControlMask, StateMask; }

        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetProcessInformation(IntPtr h, int cls, ref PROCESS_POWER_THROTTLING_STATE info, uint len);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

        // ---- macOS: App Nap (via the Objective-C runtime) ----

        static void MacSetAppNap(bool nap)
        {
            IntPtr pi = Send(Cls("NSProcessInfo"), Sel("processInfo"));
            if (!nap)
            {
                if (_macActivity != IntPtr.Zero) return;
                IntPtr reason = SendStr(Cls("NSString"), Sel("stringWithUTF8String:"), "UnityVibeOS keep-alive");
                IntPtr token = SendActivity(pi, Sel("beginActivityWithOptions:reason:"), MacUserInitiatedAllowingIdleSystemSleep, reason);
                _macActivity = token != IntPtr.Zero ? Send(token, Sel("retain")) : IntPtr.Zero;
            }
            else if (_macActivity != IntPtr.Zero)
            {
                SendPtr(pi, Sel("endActivity:"), _macActivity);
                SendVoid(_macActivity, Sel("release"));
                _macActivity = IntPtr.Zero;
            }
        }

        const string Objc = "/usr/lib/libobjc.dylib";
        static IntPtr Cls(string n) => objc_getClass(n);
        static IntPtr Sel(string n) => sel_registerName(n);

        [DllImport(Objc, CharSet = CharSet.Ansi)] static extern IntPtr objc_getClass(string n);
        [DllImport(Objc, CharSet = CharSet.Ansi)] static extern IntPtr sel_registerName(string n);
        [DllImport(Objc, EntryPoint = "objc_msgSend")] static extern IntPtr Send(IntPtr s, IntPtr op);
        [DllImport(Objc, EntryPoint = "objc_msgSend")] static extern void SendVoid(IntPtr s, IntPtr op);
        [DllImport(Objc, EntryPoint = "objc_msgSend")] static extern void SendPtr(IntPtr s, IntPtr op, IntPtr a);
        [DllImport(Objc, EntryPoint = "objc_msgSend", CharSet = CharSet.Ansi)] static extern IntPtr SendStr(IntPtr s, IntPtr op, string a);
        [DllImport(Objc, EntryPoint = "objc_msgSend")] static extern IntPtr SendActivity(IntPtr s, IntPtr op, ulong opt, IntPtr r);
    }
}
