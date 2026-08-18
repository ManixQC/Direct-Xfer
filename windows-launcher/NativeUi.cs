using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace DirectXfer.WindowsLauncher
{
    internal enum NativeBalloonIcon : uint
    {
        None = 0,
        Info = 1,
        Warning = 2,
        Error = 3
    }

    internal static class NativeUi
    {
        private const uint MbOk = 0x00000000;
        private const uint MbYesNo = 0x00000004;
        private const uint MbIconError = 0x00000010;
        private const uint MbIconQuestion = 0x00000020;
        private const uint MbIconWarning = 0x00000030;
        private const uint MbIconInformation = 0x00000040;
        private const int IdYes = 6;

        internal static void Info(IntPtr owner, string title, string text)
        {
            NativeMethods.MessageBoxW(owner, text ?? string.Empty, title ?? "Direct-Xfer", MbOk | MbIconInformation);
        }

        internal static void Warning(IntPtr owner, string title, string text)
        {
            NativeMethods.MessageBoxW(owner, text ?? string.Empty, title ?? "Direct-Xfer", MbOk | MbIconWarning);
        }

        internal static void Error(IntPtr owner, string title, string text)
        {
            NativeMethods.MessageBoxW(owner, text ?? string.Empty, title ?? "Direct-Xfer", MbOk | MbIconError);
        }

        internal static bool Confirm(IntPtr owner, string title, string text, bool warning)
        {
            var icon = warning ? MbIconWarning : MbIconQuestion;
            return NativeMethods.MessageBoxW(owner, text ?? string.Empty, title ?? "Direct-Xfer", MbYesNo | icon) == IdYes;
        }

        internal static string PickFolder(IntPtr owner, string title, string initial)
        {
            const uint BifReturnOnlyFsDirs = 0x0001;
            const uint BifEditBox = 0x0010;
            const uint BifNewDialogStyle = 0x0040;
            const int BffmInitialized = 1;
            const uint BffmSetSelectionW = 0x0400 + 103;

            var displayName = Marshal.AllocHGlobal(32768 * sizeof(char));
            NativeMethods.BrowseCallbackProc? callback = null;
            var oleResult = NativeMethods.OleInitialize(IntPtr.Zero);
            var oleInitialized = oleResult >= 0;
            try
            {
                var initialPath = !string.IsNullOrWhiteSpace(initial) ? initial : string.Empty;
                callback = (hwnd, msg, lParam, data) =>
                {
                    if (msg == BffmInitialized && !string.IsNullOrWhiteSpace(initialPath))
                        NativeMethods.SendMessageStringW(hwnd, BffmSetSelectionW, new IntPtr(1), initialPath);
                    return 0;
                };

                var info = new NativeMethods.BROWSEINFOW
                {
                    hwndOwner = owner,
                    pidlRoot = IntPtr.Zero,
                    pszDisplayName = displayName,
                    lpszTitle = title ?? string.Empty,
                    ulFlags = BifReturnOnlyFsDirs | BifEditBox | (oleInitialized ? BifNewDialogStyle : 0u),
                    lpfn = callback,
                    lParam = IntPtr.Zero,
                    iImage = 0
                };
                var pidl = NativeMethods.SHBrowseForFolderW(ref info);
                if (pidl == IntPtr.Zero) return initial;
                try
                {
                    var path = new StringBuilder(32768);
                    return NativeMethods.SHGetPathFromIDListEx(pidl, path, (uint)path.Capacity, 0) && path.Length > 0
                        ? path.ToString()
                        : initial;
                }
                finally
                {
                    Marshal.FreeCoTaskMem(pidl);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(displayName);
                if (oleInitialized) NativeMethods.OleUninitialize();
                GC.KeepAlive(callback);
            }
        }

        internal static void ShowPasswordDialog(
            IntPtr owner,
            IntPtr icon,
            string title,
            string intro,
            string account,
            string passwordLabel,
            string password,
            string saveText,
            string copyText,
            string okText)
        {
            using var dialog = new NativePasswordDialog(owner, icon, title, intro, account, passwordLabel, password, saveText, copyText, okText);
            dialog.ShowModal();
        }

        internal static bool SetClipboardText(IntPtr owner, string text)
        {
            const uint GmemMoveable = 0x0002;
            const uint CfUnicodeText = 13;
            var opened = false;
            for (var attempt = 0; attempt < 8 && !opened; attempt++)
            {
                opened = NativeMethods.OpenClipboard(owner);
                if (!opened) Thread.Sleep(25);
            }
            if (!opened) return false;
            IntPtr memory = IntPtr.Zero;
            try
            {
                if (!NativeMethods.EmptyClipboard()) return false;
                var bytes = Encoding.Unicode.GetBytes((text ?? string.Empty) + "\0");
                memory = NativeMethods.GlobalAlloc(GmemMoveable, new UIntPtr((uint)bytes.Length));
                if (memory == IntPtr.Zero) return false;
                var target = NativeMethods.GlobalLock(memory);
                if (target == IntPtr.Zero) return false;
                try { Marshal.Copy(bytes, 0, target, bytes.Length); }
                finally { NativeMethods.GlobalUnlock(memory); }
                if (NativeMethods.SetClipboardData(CfUnicodeText, memory) == IntPtr.Zero) return false;
                memory = IntPtr.Zero; // Clipboard owns it after SetClipboardData succeeds.
                return true;
            }
            finally
            {
                if (memory != IntPtr.Zero) NativeMethods.GlobalFree(memory);
                NativeMethods.CloseClipboard();
            }
        }
    }

    internal sealed class NativeMenuBuilder : IDisposable
    {
        private const uint MfString = 0x0000;
        private const uint MfGrayEd = 0x0001;
        private const uint MfDisabled = 0x0002;
        private const uint MfPopup = 0x0010;
        private const uint MfSeparator = 0x0800;
        private readonly bool _owns;
        private bool _disposed;

        internal NativeMenuBuilder() : this(NativeMethods.CreatePopupMenu(), true)
        {
            if (Handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        private NativeMenuBuilder(IntPtr handle, bool owns)
        {
            Handle = handle;
            _owns = owns;
        }

        internal IntPtr Handle { get; }

        internal void AddItem(int commandId, string text, bool enabled = true)
        {
            var flags = MfString | (enabled ? 0u : MfGrayEd | MfDisabled);
            if (!NativeMethods.AppendMenuW(Handle, flags, new UIntPtr((uint)commandId), text ?? string.Empty))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        internal NativeMenuBuilder AddSubMenu(string text, bool enabled = true)
        {
            var childHandle = NativeMethods.CreatePopupMenu();
            if (childHandle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var flags = MfPopup | MfString | (enabled ? 0u : MfGrayEd | MfDisabled);
            if (!NativeMethods.AppendMenuW(Handle, flags, unchecked((UIntPtr)(ulong)childHandle.ToInt64()), text ?? string.Empty))
            {
                NativeMethods.DestroyMenu(childHandle);
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return new NativeMenuBuilder(childHandle, false);
        }

        internal void AddSeparator()
        {
            if (!NativeMethods.AppendMenuW(Handle, MfSeparator, UIntPtr.Zero, string.Empty))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            if (_owns && Handle != IntPtr.Zero) NativeMethods.DestroyMenu(Handle);
        }
    }

    internal sealed class NativeTrayIcon : IDisposable
    {
        private const uint WmNull = 0x0000;
        private const uint WmClose = 0x0010;
        private const uint WmDestroy = 0x0002;
        private const uint WmLButtonUp = 0x0202;
        private const uint WmRButtonUp = 0x0205;
        private const uint WmContextMenu = 0x007B;
        private const uint WmApp = 0x8000;
        private const uint TrayCallbackMessage = WmApp + 17;
        private const uint DispatchMessage = WmApp + 18;
        private const uint NimAdd = 0x00000000;
        private const uint NimModify = 0x00000001;
        private const uint NimDelete = 0x00000002;
        private const uint NifMessage = 0x00000001;
        private const uint NifIcon = 0x00000002;
        private const uint NifTip = 0x00000004;
        private const uint NifInfo = 0x00000010;
        private const uint TpmRightButton = 0x0002;
        private const uint TpmReturnCmd = 0x0100;
        private const uint WsExToolWindow = 0x00000080;
        private readonly NativeMethods.WndProc _wndProc;
        private readonly ConcurrentQueue<Action> _queue = new();
        private readonly string _windowClass;
        private readonly uint _taskbarCreatedMessage;
        private string _tooltip;
        private IntPtr _hwnd;
        private IntPtr _icon;
        private bool _ownsIcon;
        private bool _visible;
        private bool _disposed;

        internal NativeTrayIcon(string tooltip)
        {
            _tooltip = tooltip ?? string.Empty;
            _taskbarCreatedMessage = NativeMethods.RegisterWindowMessageW("TaskbarCreated");
            _windowClass = "DirectXferNativeTray_" + Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture);
            _wndProc = WindowProc;
            var wc = new NativeMethods.WNDCLASSEXW
            {
                cbSize = (uint)Marshal.SizeOf<NativeMethods.WNDCLASSEXW>(),
                lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wndProc),
                hInstance = NativeMethods.GetModuleHandleW(null),
                hCursor = NativeMethods.LoadCursorW(IntPtr.Zero, new IntPtr(32512)),
                lpszClassName = _windowClass
            };
            if (NativeMethods.RegisterClassExW(ref wc) == 0)
                throw new Win32Exception(Marshal.GetLastWin32Error());

            _hwnd = NativeMethods.CreateWindowExW(WsExToolWindow, _windowClass, "Direct-Xfer", 0,
                0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
            if (_hwnd == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

            _icon = LoadApplicationIcon(out _ownsIcon);
            if (!AddTrayIcon()) throw new Win32Exception(Marshal.GetLastWin32Error());
            _visible = true;
        }

        internal IntPtr WindowHandle => _hwnd;
        internal IntPtr IconHandle => _icon;
        internal Action? LeftClick { get; set; }
        internal Func<NativeMenuBuilder>? MenuFactory { get; set; }
        internal Action<int>? CommandInvoked { get; set; }

        internal void UpdateTooltip(string tooltip)
        {
            _tooltip = tooltip ?? string.Empty;
            if (!_visible || _hwnd == IntPtr.Zero) return;
            var data = CreateNotifyData(NifTip, _tooltip);
            NativeMethods.Shell_NotifyIconW(NimModify, ref data);
        }

        internal void ShowBalloon(string title, string text, NativeBalloonIcon icon)
        {
            if (!_visible || _hwnd == IntPtr.Zero) return;
            var data = CreateNotifyData(NifInfo, string.Empty);
            data.szInfoTitle = Truncate(title, 63);
            data.szInfo = Truncate(text, 255);
            data.dwInfoFlags = (uint)icon;
            NativeMethods.Shell_NotifyIconW(NimModify, ref data);
        }

        internal void Post(Action action)
        {
            if (action == null || _disposed || _hwnd == IntPtr.Zero) return;
            _queue.Enqueue(action);
            NativeMethods.PostMessageW(_hwnd, DispatchMessage, IntPtr.Zero, IntPtr.Zero);
        }

        internal void Hide()
        {
            if (!_visible || _hwnd == IntPtr.Zero) return;
            var data = CreateNotifyData(0, string.Empty);
            NativeMethods.Shell_NotifyIconW(NimDelete, ref data);
            _visible = false;
        }

        internal void Exit()
        {
            if (_hwnd != IntPtr.Zero) NativeMethods.PostMessageW(_hwnd, WmClose, IntPtr.Zero, IntPtr.Zero);
        }

        internal int RunMessageLoop()
        {
            var previous = SynchronizationContext.Current;
            SynchronizationContext.SetSynchronizationContext(new NativeWindowSynchronizationContext(this));
            try
            {
                NativeMethods.MSG message;
                while (true)
                {
                    var result = NativeMethods.GetMessageW(out message, IntPtr.Zero, 0, 0);
                    if (result == 0) return unchecked((int)message.wParam.ToInt64());
                    if (result < 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                    NativeMethods.TranslateMessage(ref message);
                    NativeMethods.DispatchMessageW(ref message);
                }
            }
            finally
            {
                SynchronizationContext.SetSynchronizationContext(previous);
            }
        }

        private IntPtr WindowProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
        {
            try
            {
                if (_taskbarCreatedMessage != 0 && msg == _taskbarCreatedMessage)
                {
                    if (_visible) AddTrayIcon();
                    return IntPtr.Zero;
                }
                if (msg == TrayCallbackMessage)
                {
                    var notification = unchecked((uint)lParam.ToInt64());
                    if (notification == WmLButtonUp) LeftClick?.Invoke();
                    else if (notification == WmRButtonUp || notification == WmContextMenu) ShowContextMenu();
                    return IntPtr.Zero;
                }
                if (msg == DispatchMessage)
                {
                    while (_queue.TryDequeue(out var action))
                    {
                        try { action(); } catch { }
                    }
                    return IntPtr.Zero;
                }
                if (msg == WmClose)
                {
                    Hide();
                    if (_hwnd != IntPtr.Zero) NativeMethods.DestroyWindow(_hwnd);
                    return IntPtr.Zero;
                }
                if (msg == WmDestroy)
                {
                    _hwnd = IntPtr.Zero;
                    NativeMethods.PostQuitMessage(0);
                    return IntPtr.Zero;
                }
            }
            catch { }
            return NativeMethods.DefWindowProcW(hwnd, msg, wParam, lParam);
        }

        private bool AddTrayIcon()
        {
            if (_hwnd == IntPtr.Zero) return false;
            var data = CreateNotifyData(NifMessage | NifIcon | NifTip, _tooltip);
            return NativeMethods.Shell_NotifyIconW(NimAdd, ref data);
        }

        private void ShowContextMenu()
        {
            var factory = MenuFactory;
            if (factory == null || _hwnd == IntPtr.Zero) return;
            using var menu = factory();
            if (!NativeMethods.GetCursorPos(out var point)) return;
            NativeMethods.SetForegroundWindow(_hwnd);
            var command = NativeMethods.TrackPopupMenuEx(menu.Handle, TpmRightButton | TpmReturnCmd,
                point.X, point.Y, _hwnd, IntPtr.Zero);
            NativeMethods.PostMessageW(_hwnd, WmNull, IntPtr.Zero, IntPtr.Zero);
            if (command != 0) CommandInvoked?.Invoke(unchecked((int)command));
        }

        private NativeMethods.NOTIFYICONDATAW CreateNotifyData(uint flags, string tooltip)
        {
            return new NativeMethods.NOTIFYICONDATAW
            {
                cbSize = (uint)Marshal.SizeOf<NativeMethods.NOTIFYICONDATAW>(),
                hWnd = _hwnd,
                uID = 1,
                uFlags = flags,
                uCallbackMessage = TrayCallbackMessage,
                hIcon = _icon,
                szTip = Truncate(tooltip, 127),
                szInfo = string.Empty,
                szInfoTitle = string.Empty
            };
        }

        private static string Truncate(string? value, int max)
        {
            var text = value ?? string.Empty;
            return text.Length <= max ? text : text.Substring(0, max);
        }

        private static IntPtr LoadApplicationIcon(out bool owned)
        {
            owned = false;
            try
            {
                if (NativeMethods.ExtractIconExW(Program.ExecutablePath, 0, out var large, out var small, 1) > 0)
                {
                    var selected = small != IntPtr.Zero ? small : large;
                    if (small != IntPtr.Zero && large != IntPtr.Zero && large != selected) NativeMethods.DestroyIcon(large);
                    if (large != IntPtr.Zero && small != IntPtr.Zero && small != selected) NativeMethods.DestroyIcon(small);
                    if (selected != IntPtr.Zero)
                    {
                        owned = true;
                        return selected;
                    }
                }
            }
            catch { }
            return NativeMethods.LoadIconW(IntPtr.Zero, new IntPtr(32512)); // IDI_APPLICATION
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            Hide();
            if (_hwnd != IntPtr.Zero)
            {
                NativeMethods.DestroyWindow(_hwnd);
                _hwnd = IntPtr.Zero;
            }
            if (_ownsIcon && _icon != IntPtr.Zero) NativeMethods.DestroyIcon(_icon);
            _icon = IntPtr.Zero;
            try { NativeMethods.UnregisterClassW(_windowClass, NativeMethods.GetModuleHandleW(null)); } catch { }
        }
    }

    internal sealed class NativeWindowSynchronizationContext : SynchronizationContext
    {
        private readonly NativeTrayIcon _window;
        internal NativeWindowSynchronizationContext(NativeTrayIcon window) { _window = window; }
        public override void Post(SendOrPostCallback d, object? state) { _window.Post(() => d(state)); }
        public override SynchronizationContext CreateCopy() { return new NativeWindowSynchronizationContext(_window); }
    }

    internal sealed class NativePasswordDialog : IDisposable
    {
        private const uint WmClose = 0x0010;
        private const uint WmDestroy = 0x0002;
        private const uint WmCommand = 0x0111;
        private const uint WmSetFont = 0x0030;
        private const uint WmSetIcon = 0x0080;
        private const uint EmSetSel = 0x00B1;
        private const uint WsCaption = 0x00C00000;
        private const uint WsSysMenu = 0x00080000;
        private const uint WsChild = 0x40000000;
        private const uint WsVisible = 0x10000000;
        private const uint WsTabStop = 0x00010000;
        private const uint WsExClientEdge = 0x00000200;
        private const uint WsExAppWindow = 0x00040000;
        private const uint EsAutoHScroll = 0x0080;
        private const uint EsReadOnly = 0x0800;
        private const uint BsDefaultPushButton = 0x0001;
        private const int SwShow = 5;
        private const int DefaultGuiFont = 17;
        private const int IdCopy = 1001;
        private const int IdOk = 1;
        private static readonly Dictionary<IntPtr, NativePasswordDialog> Instances = new();
        private static readonly object ClassSync = new();
        private static NativeMethods.WndProc? _classProc;
        private static string? _className;
        private readonly IntPtr _owner;
        private readonly string _password;
        private readonly IntPtr _icon;
        private IntPtr _hwnd;
        private IntPtr _passwordEdit;
        private IntPtr _font;
        private bool _ownsFont;
        private bool _closed;

        internal NativePasswordDialog(IntPtr owner, IntPtr icon, string title, string intro, string account, string passwordLabel,
            string password, string saveText, string copyText, string okText)
        {
            _owner = owner;
            _password = password ?? string.Empty;
            _icon = icon;
            EnsureClass();

            var dpi = owner != IntPtr.Zero ? NativeMethods.GetDpiForWindow(owner) : NativeMethods.GetDpiForSystem();
            if (dpi == 0) dpi = 96;
            int Scale(int value) => Math.Max(1, (int)Math.Round(value * (dpi / 96.0)));
            var width = Scale(680);
            var height = Scale(300);
            var x = Scale(100);
            var y = Scale(100);
            if (owner != IntPtr.Zero && NativeMethods.GetWindowRect(owner, out var ownerRect) &&
                ownerRect.Right > ownerRect.Left && ownerRect.Bottom > ownerRect.Top)
            {
                x = ownerRect.Left + Math.Max(0, (ownerRect.Right - ownerRect.Left - width) / 2);
                y = ownerRect.Top + Math.Max(0, (ownerRect.Bottom - ownerRect.Top - height) / 2);
            }
            else if (NativeMethods.SystemParametersInfoW(48, 0, out var work, 0))
            {
                x = work.Left + Math.Max(0, (work.Right - work.Left - width) / 2);
                y = work.Top + Math.Max(0, (work.Bottom - work.Top - height) / 2);
            }

            _hwnd = NativeMethods.CreateWindowExW(WsExAppWindow, _className!, title ?? "Direct-Xfer",
                WsCaption | WsSysMenu, x, y, width, height, owner, IntPtr.Zero, NativeMethods.GetModuleHandleW(null), IntPtr.Zero);
            if (_hwnd == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            lock (Instances) Instances[_hwnd] = this;
            if (_icon != IntPtr.Zero)
            {
                NativeMethods.SendMessageW(_hwnd, WmSetIcon, new IntPtr(0), _icon);
                NativeMethods.SendMessageW(_hwnd, WmSetIcon, new IntPtr(1), _icon);
            }

            _font = NativeMethods.CreateFontW(-Scale(12), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, "Segoe UI");
            _ownsFont = _font != IntPtr.Zero;
            if (_font == IntPtr.Zero) _font = NativeMethods.GetStockObject(DefaultGuiFont);
            CreateStatic(intro, Scale(20), Scale(18), Scale(630), Scale(34), _font);
            CreateStatic(account, Scale(20), Scale(58), Scale(630), Scale(24), _font);
            CreateStatic(passwordLabel, Scale(20), Scale(88), Scale(630), Scale(22), _font);
            _passwordEdit = NativeMethods.CreateWindowExW(WsExClientEdge, "EDIT", _password,
                WsChild | WsVisible | WsTabStop | EsAutoHScroll | EsReadOnly, Scale(20), Scale(112), Scale(630), Scale(26),
                _hwnd, new IntPtr(2001), NativeMethods.GetModuleHandleW(null), IntPtr.Zero);
            ApplyFont(_passwordEdit, _font);
            CreateStatic(saveText, Scale(20), Scale(150), Scale(630), Scale(42), _font);
            var copy = NativeMethods.CreateWindowExW(0, "BUTTON", copyText ?? "Copy",
                WsChild | WsVisible | WsTabStop, Scale(20), Scale(210), Scale(220), Scale(34), _hwnd, new IntPtr(IdCopy), NativeMethods.GetModuleHandleW(null), IntPtr.Zero);
            ApplyFont(copy, _font);
            var ok = NativeMethods.CreateWindowExW(0, "BUTTON", okText ?? "OK",
                WsChild | WsVisible | WsTabStop | BsDefaultPushButton, Scale(550), Scale(210), Scale(100), Scale(34),
                _hwnd, new IntPtr(IdOk), NativeMethods.GetModuleHandleW(null), IntPtr.Zero);
            ApplyFont(ok, _font);
        }

        internal void ShowModal()
        {
            if (_owner != IntPtr.Zero) NativeMethods.EnableWindow(_owner, false);
            try
            {
                NativeMethods.ShowWindow(_hwnd, SwShow);
                NativeMethods.UpdateWindow(_hwnd);
                if (_passwordEdit != IntPtr.Zero)
                {
                    NativeMethods.SetFocus(_passwordEdit);
                    NativeMethods.SendMessageW(_passwordEdit, EmSetSel, IntPtr.Zero, new IntPtr(-1));
                }
                NativeMethods.MSG message;
                while (!_closed)
                {
                    var result = NativeMethods.GetMessageW(out message, IntPtr.Zero, 0, 0);
                    if (result == 0)
                    {
                        NativeMethods.PostQuitMessage(unchecked((int)message.wParam.ToInt64()));
                        break;
                    }
                    if (result < 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                    if (_hwnd != IntPtr.Zero && NativeMethods.IsDialogMessageW(_hwnd, ref message)) continue;
                    NativeMethods.TranslateMessage(ref message);
                    NativeMethods.DispatchMessageW(ref message);
                }
            }
            finally
            {
                if (_owner != IntPtr.Zero)
                {
                    NativeMethods.EnableWindow(_owner, true);
                    NativeMethods.SetForegroundWindow(_owner);
                }
            }
        }

        private void CreateStatic(string text, int x, int y, int width, int height, IntPtr font)
        {
            var control = NativeMethods.CreateWindowExW(0, "STATIC", text ?? string.Empty,
                WsChild | WsVisible, x, y, width, height, _hwnd, IntPtr.Zero, NativeMethods.GetModuleHandleW(null), IntPtr.Zero);
            ApplyFont(control, font);
        }

        private static void ApplyFont(IntPtr hwnd, IntPtr font)
        {
            if (hwnd != IntPtr.Zero && font != IntPtr.Zero) NativeMethods.SendMessageW(hwnd, WmSetFont, font, new IntPtr(1));
        }

        private static void EnsureClass()
        {
            lock (ClassSync)
            {
                if (_className != null) return;
                _className = "DirectXferPasswordDialog_" + Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture);
                _classProc = StaticWindowProc;
                var wc = new NativeMethods.WNDCLASSEXW
                {
                    cbSize = (uint)Marshal.SizeOf<NativeMethods.WNDCLASSEXW>(),
                    lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_classProc),
                    hInstance = NativeMethods.GetModuleHandleW(null),
                    hCursor = NativeMethods.LoadCursorW(IntPtr.Zero, new IntPtr(32512)),
                    hbrBackground = new IntPtr(6), // COLOR_WINDOW + 1
                    lpszClassName = _className
                };
                if (NativeMethods.RegisterClassExW(ref wc) == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }

        private static IntPtr StaticWindowProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
        {
            NativePasswordDialog? dialog;
            lock (Instances) Instances.TryGetValue(hwnd, out dialog);
            if (dialog == null) return NativeMethods.DefWindowProcW(hwnd, msg, wParam, lParam);
            if (msg == WmCommand)
            {
                var id = unchecked((int)(wParam.ToInt64() & 0xFFFF));
                if (id == IdCopy)
                {
                    NativeUi.SetClipboardText(hwnd, dialog._password);
                    if (dialog._passwordEdit != IntPtr.Zero)
                    {
                        NativeMethods.SetFocus(dialog._passwordEdit);
                        NativeMethods.SendMessageW(dialog._passwordEdit, EmSetSel, IntPtr.Zero, new IntPtr(-1));
                    }
                    return IntPtr.Zero;
                }
                if (id == IdOk)
                {
                    NativeMethods.DestroyWindow(hwnd);
                    return IntPtr.Zero;
                }
            }
            if (msg == WmClose)
            {
                NativeMethods.DestroyWindow(hwnd);
                return IntPtr.Zero;
            }
            if (msg == WmDestroy)
            {
                dialog._closed = true;
                dialog._hwnd = IntPtr.Zero;
                lock (Instances) Instances.Remove(hwnd);
                return IntPtr.Zero;
            }
            return NativeMethods.DefWindowProcW(hwnd, msg, wParam, lParam);
        }

        public void Dispose()
        {
            if (_hwnd != IntPtr.Zero)
            {
                NativeMethods.DestroyWindow(_hwnd);
                _hwnd = IntPtr.Zero;
            }
            if (_ownsFont && _font != IntPtr.Zero) NativeMethods.DeleteObject(_font);
            _font = IntPtr.Zero;
            _ownsFont = false;
        }
    }

    internal static class NativeMethods
    {
        internal delegate IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
        internal delegate int BrowseCallbackProc(IntPtr hwnd, uint msg, IntPtr lParam, IntPtr lpData);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct WNDCLASSEXW
        {
            internal uint cbSize;
            internal uint style;
            internal IntPtr lpfnWndProc;
            internal int cbClsExtra;
            internal int cbWndExtra;
            internal IntPtr hInstance;
            internal IntPtr hIcon;
            internal IntPtr hCursor;
            internal IntPtr hbrBackground;
            [MarshalAs(UnmanagedType.LPWStr)] internal string? lpszMenuName;
            [MarshalAs(UnmanagedType.LPWStr)] internal string? lpszClassName;
            internal IntPtr hIconSm;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct NOTIFYICONDATAW
        {
            internal uint cbSize;
            internal IntPtr hWnd;
            internal uint uID;
            internal uint uFlags;
            internal uint uCallbackMessage;
            internal IntPtr hIcon;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] internal string szTip;
            internal uint dwState;
            internal uint dwStateMask;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] internal string szInfo;
            internal uint uVersion;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] internal string szInfoTitle;
            internal uint dwInfoFlags;
            internal Guid guidItem;
            internal IntPtr hBalloonIcon;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct POINT { internal int X; internal int Y; }

        [StructLayout(LayoutKind.Sequential)]
        internal struct RECT { internal int Left; internal int Top; internal int Right; internal int Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        internal struct MSG
        {
            internal IntPtr hwnd;
            internal uint message;
            internal IntPtr wParam;
            internal IntPtr lParam;
            internal uint time;
            internal POINT pt;
            internal uint lPrivate;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct BROWSEINFOW
        {
            internal IntPtr hwndOwner;
            internal IntPtr pidlRoot;
            internal IntPtr pszDisplayName;
            [MarshalAs(UnmanagedType.LPWStr)] internal string lpszTitle;
            internal uint ulFlags;
            internal BrowseCallbackProc? lpfn;
            internal IntPtr lParam;
            internal int iImage;
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int MessageBoxW(IntPtr hWnd, string lpText, string lpCaption, uint uType);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern ushort RegisterClassExW(ref WNDCLASSEXW lpwcx);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern uint RegisterWindowMessageW(string lpString);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool UnregisterClassW(string lpClassName, IntPtr hInstance);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateWindowExW(uint dwExStyle, string lpClassName, string lpWindowName, uint dwStyle, int X, int Y, int nWidth, int nHeight, IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);
        [DllImport("user32.dll")] internal static extern IntPtr DefWindowProcW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool DestroyWindow(IntPtr hWnd);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] internal static extern void PostQuitMessage(int nExitCode);
        [DllImport("user32.dll", SetLastError = true)] internal static extern int GetMessageW(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
        [DllImport("user32.dll")] internal static extern bool TranslateMessage(ref MSG lpMsg);
        [DllImport("user32.dll")] internal static extern IntPtr DispatchMessageW(ref MSG lpMsg);
        [DllImport("user32.dll")] internal static extern bool IsDialogMessageW(IntPtr hDlg, ref MSG lpMsg);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool GetCursorPos(out POINT lpPoint);
        [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(IntPtr hwnd);
        [DllImport("user32.dll")] internal static extern uint GetDpiForSystem();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern bool SystemParametersInfoW(uint uiAction, uint uiParam, out RECT pvParam, uint fWinIni);
        [DllImport("user32.dll")] internal static extern bool EnableWindow(IntPtr hWnd, bool bEnable);
        [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] internal static extern bool UpdateWindow(IntPtr hWnd);
        [DllImport("user32.dll")] internal static extern IntPtr SetFocus(IntPtr hWnd);
        [DllImport("user32.dll")] internal static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")] internal static extern IntPtr SendMessageStringW(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr CreatePopupMenu();
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool AppendMenuW(IntPtr hMenu, uint uFlags, UIntPtr uIDNewItem, string lpNewItem);
        [DllImport("user32.dll")] internal static extern bool DestroyMenu(IntPtr hMenu);
        [DllImport("user32.dll", SetLastError = true)] internal static extern uint TrackPopupMenuEx(IntPtr hMenu, uint uFlags, int x, int y, IntPtr hwnd, IntPtr lptpm);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr LoadIconW(IntPtr hInstance, IntPtr lpIconName);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr LoadCursorW(IntPtr hInstance, IntPtr lpCursorName);
        [DllImport("user32.dll")] internal static extern bool DestroyIcon(IntPtr hIcon);
        [DllImport("gdi32.dll")] internal static extern IntPtr GetStockObject(int fnObject);
        [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr CreateFontW(int cHeight, int cWidth, int cEscapement, int cOrientation, int cWeight, uint bItalic, uint bUnderline, uint bStrikeOut, uint iCharSet, uint iOutPrecision, uint iClipPrecision, uint iQuality, uint iPitchAndFamily, string pszFaceName);
        [DllImport("gdi32.dll")] internal static extern bool DeleteObject(IntPtr ho);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool OpenClipboard(IntPtr hWndNewOwner);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool EmptyClipboard();
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool CloseClipboard();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr GetModuleHandleW(string? lpModuleName);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr GlobalLock(IntPtr hMem);
        [DllImport("kernel32.dll")] internal static extern bool GlobalUnlock(IntPtr hMem);
        [DllImport("kernel32.dll")] internal static extern IntPtr GlobalFree(IntPtr hMem);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] internal static extern uint ExtractIconExW(string szFileName, int nIconIndex, out IntPtr phiconLarge, out IntPtr phiconSmall, uint nIcons);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr SHBrowseForFolderW(ref BROWSEINFOW lpbi);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] internal static extern bool SHGetPathFromIDListEx(IntPtr pidl, StringBuilder pszPath, uint cchPath, uint uOpts);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] internal static extern bool Shell_NotifyIconW(uint dwMessage, ref NOTIFYICONDATAW lpData);
        [DllImport("ole32.dll")] internal static extern int OleInitialize(IntPtr pvReserved);
        [DllImport("ole32.dll")] internal static extern void OleUninitialize();
    }
}
