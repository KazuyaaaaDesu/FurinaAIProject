using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Windows;
using System.Windows.Input;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using MessageBox = System.Windows.MessageBox;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Interop;

namespace Fufuu.Wpf.Pet;

/// <summary>
/// Transparent WPF shell for the React/PIXI Live2D and Three.js VRM viewers.
/// Handles WebView2 diagnostics, global hotkeys, mouse tracking, roaming,
/// window positioning, settings, and communication with the JavaScript pet stage.
/// </summary>
public partial class DesktopPetWindow : Window
{
    public static DesktopPetWindow? Instance { get; private set; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(
        IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private const int HotKeyId = 9000;
    private const int ClickThroughHotKeyId = 9001;
    private const int WmHotKey = 0x0312;

    private const uint ModAlt = 0x0001;
    private const uint ModControl = 0x0002;
    private const uint ModifierCtrlAlt = ModControl | ModAlt;
    private const uint KeyT = 0x54;
    private const uint KeyI = 0x49;

    private const int GwlExStyle = -20;
    private const int WsExTransparent = 0x00000020;
    private const int WsExLayered = 0x00080000;

    [DllImport("user32.dll", EntryPoint = "GetWindowLong", SetLastError = true)]
    private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLong", SetLastError = true)]
    private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    private static IntPtr GetWindowLongPtr(IntPtr hwnd, int index) => IntPtr.Size == 8
        ? GetWindowLongPtr64(hwnd, index) : new IntPtr(GetWindowLong32(hwnd, index));

    private static IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value) => IntPtr.Size == 8
        ? SetWindowLongPtr64(hwnd, index, value) : new IntPtr(SetWindowLong32(hwnd, index, value.ToInt32()));

    private IntPtr _windowHandle;
    private HwndSource? _source;
    private bool _hotkeyRegistered;
    private bool _clickThroughHotkeyRegistered;
    private bool _hiddenForMouseAvoidance;
    private bool _applyingVisibility;

    private static readonly JsonSerializerOptions WebJsonOptions =
        new(JsonSerializerDefaults.Web);

    private static readonly string DiagnosticLogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Lumi",
        "desktop-pet-debug.log");

    private readonly string _settingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Lumi",
        "desktop-pet.json");

    private DesktopStageSettings _settings;
    private readonly PetBehaviorController _behavior = new();

    private bool _webReady;
    private bool _initializationStarted;
    private bool _isClosing;

    private long? _reactionToken;
    private DispatcherTimer? _reactionTimer;

    private readonly DispatcherTimer _roamTimer =
        new() { Interval = TimeSpan.FromMilliseconds(16) };

    private int _roamDirection = -1;

    // Reference position used by the X/Y settings.
    private double _baseLeft;
    private double _baseTop;
    private bool _basePositionInitialized;

    // Prevents programmatic movement from being treated as a user reposition.
    private bool _applyingWindowPosition;

    public DesktopPetWindow()
    {
        InitializeComponent();
        Instance = this;

        _settings = DesktopStageSettings.Load(_settingsPath);

        Width = _settings.Width * _settings.CharacterScale;
        Height = _settings.Height * _settings.CharacterScale;
        Topmost = _settings.AlwaysOnTop;

        PlaceNearPrimaryWorkArea();

        _baseLeft = Left;
        _baseTop = Top;
        _basePositionInitialized = true;

        ApplyWindowPosition();

        Loaded += InitializePetAsync;
        Loaded += OnWindowLoaded;
        Unloaded += OnWindowUnloaded;

        Closing += (_, _) =>
        {
            _isClosing = true;
            SaveSettings();
        };

        _behavior.BehaviorChanged += behavior =>
        {
            if (_isClosing)
                return;

            SendToWeb(new
            {
                type = "behavior",
                behavior = behavior.ToString().ToLowerInvariant()
            });
        };

        _roamTimer.Tick += (_, _) =>
        {
            if (_isClosing || (!IsVisible && !_hiddenForMouseAvoidance))
                return;

            MoveAlongWorkArea();
            PollGlobalMouse();
            UpdateMouseAvoidance();
        };

        LogDiagnostic("DesktopPetWindow constructed.");
        LogDiagnostic(
            $"Settings: mode={_settings.DisplayMode}, " +
            $"size={Width}x{Height}, " +
            $"X={_settings.CharacterX}, Y={_settings.CharacterY}, " +
            $"roaming={_settings.RoamingEnabled}");
    }

    private void OnWindowLoaded(object sender, RoutedEventArgs e)
    {
        if (_isClosing)
            return;

        _windowHandle = new WindowInteropHelper(this).Handle;
        _source = HwndSource.FromHwnd(_windowHandle);
        _source?.AddHook(HwndHook);

        _hotkeyRegistered = RegisterHotKey(
            _windowHandle, HotKeyId, ModifierCtrlAlt, KeyT);
        _clickThroughHotkeyRegistered = RegisterHotKey(
            _windowHandle, ClickThroughHotKeyId, ModifierCtrlAlt, KeyI);
        ApplyClickThroughStyle();

        if (_clickThroughHotkeyRegistered)
            LogDiagnostic("Global hotkey registered: Ctrl + Alt + I (click-through).");
        else
            LogDiagnostic($"Failed to register Ctrl + Alt + I. Win32 error: {Marshal.GetLastWin32Error()}.");

        if (_hotkeyRegistered)
        {
            LogDiagnostic("Global hotkey registered: Ctrl + Alt + T.");
        }
        else
        {
            LogDiagnostic(
                $"Failed to register Ctrl + Alt + T. " +
                $"Win32 error: {Marshal.GetLastWin32Error()}. " +
                "Another application may already be using this shortcut.");
        }
    }

    private void OnWindowUnloaded(object sender, RoutedEventArgs e)
    {
        UnregisterGlobalHotkey();
    }

    private void UnregisterGlobalHotkey()
    {
        if (_hotkeyRegistered && _windowHandle != IntPtr.Zero)
        {
            if (UnregisterHotKey(_windowHandle, HotKeyId))
                LogDiagnostic("Global hotkey unregistered.");
            else
                LogDiagnostic(
                    $"Failed to unregister global hotkey. " +
                    $"Win32 error: {Marshal.GetLastWin32Error()}.");

            _hotkeyRegistered = false;
        }

        if (_clickThroughHotkeyRegistered && _windowHandle != IntPtr.Zero)
        {
            UnregisterHotKey(_windowHandle, ClickThroughHotKeyId);
            _clickThroughHotkeyRegistered = false;
        }

        _source?.RemoveHook(HwndHook);
        _source = null;
        _windowHandle = IntPtr.Zero;
    }

    private IntPtr HwndHook(
        IntPtr hwnd,
        int msg,
        IntPtr wParam,
        IntPtr lParam,
        ref bool handled)
    {
        if (msg == WmHotKey)
        {
            var id = wParam.ToInt32();
            if (id == HotKeyId)
            {
                LogDiagnostic("Global hotkey pressed: Ctrl + Alt + T.");
                SendToWeb(new { type = "toggle-toolbar" });
                handled = true;
            }
            else if (id == ClickThroughHotKeyId)
            {
                SetClickThrough(!_settings.ClickThroughEnabled, persist: true);
                handled = true;
            }
        }

        return IntPtr.Zero;
    }

    private async void InitializePetAsync(object? sender, RoutedEventArgs e)
    {
        if (_initializationStarted)
            return;

        _initializationStarted = true;

        try
        {
            var webRoot = Path.Combine(AppContext.BaseDirectory, "Web");
            var entry = Path.Combine(webRoot, "PetStage.html");

            LogDiagnostic($"Application base directory: {AppContext.BaseDirectory}");
            LogDiagnostic($"Web root: {webRoot}");
            LogDiagnostic($"Pet stage entry: {entry}");
            LogDiagnostic($"Pet stage exists: {File.Exists(entry)}");

            if (!File.Exists(entry))
            {
                var message =
                    "The pet viewer bundle was not found. Build the React " +
                    "project first with `npm run build`, then rebuild WPF.\n\n" +
                    "Expected: " + entry;

                LogDiagnostic(message);

                MessageBox.Show(
                    this, message, "Lumi Desktop Pet",
                    MessageBoxButton.OK, MessageBoxImage.Information);

                Close();
                return;
            }

            await PetWebView.EnsureCoreWebView2Async();

            if (_isClosing)
                return;

            var webFolder = Path.Combine(
                AppDomain.CurrentDomain.BaseDirectory, "Web");

            PetWebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "lumi.local",
                webFolder,
                CoreWebView2HostResourceAccessKind.Allow);

            var core = PetWebView.CoreWebView2;

            if (core is null)
                throw new InvalidOperationException(
                    "WebView2 initialized without a CoreWebView2 instance.");

            LogDiagnostic(
                $"WebView2 initialized. Version: {core.Environment.BrowserVersionString}");

            var consoleReceiver =
                core.GetDevToolsProtocolEventReceiver("Runtime.consoleAPICalled");

            consoleReceiver.DevToolsProtocolEventReceived += (_, args) =>
                LogDiagnostic($"JS CONSOLE: {args.ParameterObjectAsJson}");

            var exceptionReceiver =
                core.GetDevToolsProtocolEventReceiver("Runtime.exceptionThrown");

            exceptionReceiver.DevToolsProtocolEventReceived += (_, args) =>
                LogDiagnostic($"JS EXCEPTION: {args.ParameterObjectAsJson}");

            await core.CallDevToolsProtocolMethodAsync("Runtime.enable", "{}");

            LogDiagnostic("JavaScript diagnostics enabled.");

            core.WebResourceResponseReceived += (_, args) =>
            {
                try
                {
                    var response = args.Response;

                    if (response is not null && response.StatusCode >= 400)
                    {
                        LogDiagnostic(
                            $"HTTP {response.StatusCode}: {args.Request.Uri}");
                    }
                }
                catch (Exception ex)
                {
                    LogDiagnostic($"Resource diagnostic error: {ex.Message}");
                }
            };

            core.ProcessFailed += (_, args) =>
                LogDiagnostic($"WEBVIEW PROCESS FAILED: {args.ProcessFailedKind}");

            core.WebMessageReceived += (_, args) =>
            {
                try
                {
                    var message = args.TryGetWebMessageAsString();
                    LogDiagnostic($"Web message received: {message}");
                    HandleWebMessage(message);
                }
                catch (Exception ex)
                {
                    LogDiagnostic($"Web message handling error: {ex}");
                }
            };

            core.NavigationStarting += (_, args) =>
                LogDiagnostic($"Navigation starting: {args.Uri}");

            core.NavigationCompleted += (_, args) =>
            {
                LogDiagnostic(
                    $"Navigation completed: success={args.IsSuccess}, " +
                    $"error={args.WebErrorStatus}, URL={PetWebView.Source}");

                LogDiagnostic(args.IsSuccess
                    ? "WebView navigation succeeded."
                    : "WebView navigation failed. Check the diagnostic log.");
            };

            var target = new Uri("https://lumi.local/PetStage.html");
            LogDiagnostic($"Navigating to: {target}");
            PetWebView.Source = target;
        }
        catch (Exception ex)
        {
            LogDiagnostic($"WebView initialization exception: {ex}");

            MessageBox.Show(
                this,
                "Couldn't initialize the Lumi character surface:\n" +
                ex.Message + "\n\nDiagnostic log:\n" + DiagnosticLogPath,
                "Lumi Desktop Pet",
                MessageBoxButton.OK,
                MessageBoxImage.Error);

            Close();
        }
    }

    private void HandleWebMessage(string message)
    {
        try
        {
            using var doc = JsonDocument.Parse(message);
            var root = doc.RootElement;

            if (!root.TryGetProperty("type", out var typeElement))
                return;

            switch (typeElement.GetString())
            {
                case "ready":
                    LogDiagnostic("Pet stage reported ready.");
                    _webReady = true;
                    SendSettings();

                    if (!_roamTimer.IsEnabled)
                        _roamTimer.Start();

                    if (_settings.RoamingEnabled)
                    {
                        _behavior.SetBase(PetBehavior.Walking);
                        SendToWeb(new { type = "play-motion", motionId = "walking" });
                    }
                    break;

                case "set-mode":
                    if (root.TryGetProperty("mode", out var modeElement))
                    {
                        var requestedMode = modeElement.GetString();

                        if (requestedMode is "png" or "2d" or "3d")
                        {
                            LogDiagnostic($"Setting mode to: {requestedMode}");
                            SetMode(requestedMode);
                        }
                    }
                    break;

                case "toggle-roam":
                    LogDiagnostic("Toggling roaming state.");
                    Roam_Click(this, new RoutedEventArgs());
                    break;

                case "update-settings":
                    LogDiagnostic("Updating stage settings from React toolbar.");
                    break;

                case "open-chat":
                    LogDiagnostic("Open Chat requested from pet toolbar.");

                    System.Windows.Application.Current.Dispatcher.Invoke(() =>
                    {
                        try
                        {
                            var app = System.Windows.Application.Current;

                            var mainWindow = app.Windows
                                .OfType<MainWindow>()
                                .FirstOrDefault();

                            if (mainWindow is null)
                            {
                                mainWindow = new MainWindow();
                                app.MainWindow = mainWindow;
                                mainWindow.Show();
                            }
                            else
                            {
                                if (!mainWindow.IsVisible)
                                    mainWindow.Show();

                                if (mainWindow.WindowState == WindowState.Minimized)
                                    mainWindow.WindowState = WindowState.Normal;

                                mainWindow.Activate();
                            }

                            mainWindow.Activate();
                            mainWindow.Focus();
                            LogDiagnostic("Main chat window opened or focused.");
                        }
                        catch (Exception ex)
                        {
                            LogDiagnostic($"Failed to open chat window: {ex}");

                            MessageBox.Show(
                                this,
                                "Lumi couldn't open the chat window.\n\n" + ex.Message,
                                "Lumi",
                                MessageBoxButton.OK,
                                MessageBoxImage.Error);
                        }
                    });
                    break;

                case "close":
                    LogDiagnostic("Close requested from web interface.");
                    Close();
                    break;

                case "open-control-menu":
                    Dispatcher.Invoke(() =>
                    {
                        var existingWindow = System.Windows.Application.Current.Windows
                            .OfType<FufuuControlWindow>()
                            .FirstOrDefault();

                        if (existingWindow is null)
                        {
                            var controlWindow = new FufuuControlWindow(this)
                            {
                                Owner = this
                            };
                            controlWindow.Show();
                        }
                        else
                        {
                            existingWindow.Activate();
                        }
                    });
                    break;

                case "pet-click":
                    LogDiagnostic("Pet clicked.");
                    Speak("Yes?", 2500);

                    _reactionTimer?.Stop();
                    _reactionTimer = null;

                    if (_reactionToken is long previousToken)
                    {
                        _behavior.FinishTemporary(previousToken);
                        _reactionToken = null;
                    }

                    var reactionToken = _behavior.BeginMotion(
                        new MotionDefinition(
                            "wave",
                            "Wave",
                            "/motions/furina-wave.vrma",
                            false,
                            MotionCategory.Greeting,
                            30,
                            MotionReturnBehavior.Previous));

                    _reactionToken = reactionToken;

                    SendToWeb(new { type = "play-motion", motionId = "wave" });

                    _reactionTimer = new DispatcherTimer
                    {
                        Interval = TimeSpan.FromSeconds(2.8)
                    };

                    _reactionTimer.Tick += (_, _) =>
                    {
                        _reactionTimer?.Stop();
                        _reactionTimer = null;

                        if (_reactionToken == reactionToken && reactionToken.HasValue)
                        {
                            _reactionToken = null;
                            _behavior.FinishTemporary(reactionToken.Value);
                        }
                    };

                    _reactionTimer.Start();
                    break;

                case "drag-start":
                    try
                    {
                        DragMove();

                        // A manual drag establishes a new reference position.
                        _baseLeft = Left;
                        _baseTop = Top;
                        _basePositionInitialized = true;
                    }
                    catch (InvalidOperationException ex)
                    {
                        LogDiagnostic($"DragMove ignored: {ex.Message}");
                    }
                    break;

                case "motion-finished":
                    if (root.TryGetProperty("token", out var tokenElement) &&
                        tokenElement.TryGetInt64(out var value))
                    {
                        _reactionTimer?.Stop();
                        _reactionTimer = null;

                        if (_reactionToken == value)
                            _reactionToken = null;

                        _behavior.FinishTemporary(value);
                    }
                    break;

                default:
                    LogDiagnostic($"Unhandled web message type: {typeElement.GetString()}");
                    break;
            }
        }
        catch (JsonException ex)
        {
            LogDiagnostic($"Invalid JSON from pet stage: {ex.Message}");
        }
        catch (Exception ex)
        {
            LogDiagnostic($"Pet stage message processing error: {ex}");
        }
    }

    public void Speak(string text, int durationMs = 4000)
    {
        SendToWeb(new
        {
            type = "speak",
            text,
            duration = durationMs
        });
    }

    public void SpeakSequence(string fullText, int durationPerSentenceMs = 4500)
    {
        var sentences = System.Text.RegularExpressions.Regex
            .Split(fullText, @"(?<=[.!?])\s+")
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .ToList();

        if (sentences.Count == 0)
        {
            Speak(fullText, durationPerSentenceMs);
            return;
        }

        _ = Task.Run(async () =>
        {
            foreach (var sentence in sentences)
            {
                if (_isClosing)
                    break;

                await System.Windows.Application.Current.Dispatcher.InvokeAsync(
                    () => Speak(sentence, durationPerSentenceMs));

                await Task.Delay(durationPerSentenceMs + 600);
            }
        });
    }

    public void SendToWeb(object payload)
    {
        if (!_webReady || PetWebView.CoreWebView2 is null)
        {
            LogDiagnostic(
                "Skipped web message because WebView isn't ready. " +
                $"Ready={_webReady}, " +
                $"payload={JsonSerializer.Serialize(payload, WebJsonOptions)}");
            return;
        }

        var json = JsonSerializer.Serialize(payload, WebJsonOptions);

        try
        {
            PetWebView.CoreWebView2.PostWebMessageAsJson(json);
            LogDiagnostic($"Sent to pet stage: {json}");
        }
        catch (Exception ex)
        {
            LogDiagnostic($"Failed to send message to pet stage: {ex.Message}");
        }
    }

    private void SetClickThrough(bool enabled, bool persist)
    {
        _settings = _settings with { ClickThroughEnabled = enabled };
        ApplyClickThroughStyle();
        if (persist) SaveSettings();
        LogDiagnostic($"Click-through mode: {enabled}.");
    }

    private void ApplyClickThroughStyle()
    {
        if (_windowHandle == IntPtr.Zero)
            return;

        try
        {
            var style = GetWindowLongPtr(_windowHandle, GwlExStyle).ToInt64();
            style |= WsExLayered;
            if (_settings.ClickThroughEnabled)
                style |= WsExTransparent;
            else
                style &= ~((long)WsExTransparent);
            SetWindowLongPtr(_windowHandle, GwlExStyle, new IntPtr(style));
        }
        catch (Exception ex)
        {
            LogDiagnostic($"Could not apply click-through style: {ex.Message}");
        }
    }

    private void UpdateMouseAvoidance()
    {
        if (!_settings.MouseAvoidanceEnabled || _settings.ClickThroughEnabled || _isClosing)
        {
            if (_hiddenForMouseAvoidance) RestoreAfterMouseAvoidance();
            return;
        }

        try
        {
            var point = System.Windows.Forms.Cursor.Position;
            var inside = point.X >= Left && point.X < Left + ActualWidth &&
                         point.Y >= Top && point.Y < Top + ActualHeight;
            if (inside && IsVisible)
            {
                _hiddenForMouseAvoidance = true;
                _applyingVisibility = true;
                Hide();
                _applyingVisibility = false;
            }
            else if (!inside && _hiddenForMouseAvoidance)
            {
                RestoreAfterMouseAvoidance();
            }
        }
        catch (Exception ex)
        {
            LogDiagnostic($"Mouse avoidance error: {ex.Message}");
        }
    }

    private void RestoreAfterMouseAvoidance()
    {
        if (!_hiddenForMouseAvoidance) return;
        _hiddenForMouseAvoidance = false;
        _applyingVisibility = true;
        Show();
        Topmost = _settings.AlwaysOnTop;
        _applyingVisibility = false;
    }

    private void SendSettings()
    {
        LogDiagnostic(
            $"Sending settings. DisplayMode={_settings.DisplayMode}, " +
            $"X={_settings.CharacterX}, Y={_settings.CharacterY}");

        SendToWeb(new
        {
            type = "settings",
            settings = _settings
        });
    }

    public DesktopStageSettings Settings => _settings;

    public void ApplySettings(DesktopStageSettings next)
    {
        if (!next.IsValid())
            throw new ArgumentException(
                "The pet preferences are invalid.", nameof(next));

        // Keep the same reference position while changing window dimensions.
        var oldWidth = Width;
        var oldHeight = Height;

        _settings = next;

        Width = _settings.Width * _settings.CharacterScale;
        Height = _settings.Height * _settings.CharacterScale;

        // Preserve the current top-left position as the baseline. X/Y are then
        // applied to the whole WPF window by ApplyWindowPosition().
        if (!_basePositionInitialized)
        {
            _baseLeft = Left;
            _baseTop = Top;
            _basePositionInitialized = true;
        }
        else
        {
            _baseLeft += (oldWidth - Width) / 2.0;
            _baseTop += (oldHeight - Height) / 2.0;
        }

        ApplyWindowPosition();

        Topmost = _settings.AlwaysOnTop;
        ApplyClickThroughStyle();
        if (!_settings.MouseAvoidanceEnabled && _hiddenForMouseAvoidance)
            RestoreAfterMouseAvoidance();

        SaveSettings();
        SendSettings();

        LogDiagnostic(
            $"Pet preferences applied. Mode={_settings.DisplayMode}, " +
            $"Scale={_settings.CharacterScale}, " +
            $"X={_settings.CharacterX}, Y={_settings.CharacterY}, " +
            $"WindowSize={Width}x{Height}");
    }

    private void Mode2D_Click(object sender, RoutedEventArgs e) => SetMode("2d");

    private void Mode3D_Click(object sender, RoutedEventArgs e) => SetMode("3d");

    private void SetMode(string mode)
    {
        LogDiagnostic($"Changing display mode to: {mode}");

        _settings = _settings with { DisplayMode = mode };

        SaveSettings();
        SendSettings();
    }

    private void Roam_Click(object sender, RoutedEventArgs e)
    {
        _settings = _settings with
        {
            RoamingEnabled = !_settings.RoamingEnabled
        };

        LogDiagnostic($"Roaming toggled: {_settings.RoamingEnabled}");

        SaveSettings();
        SendSettings();

        if (_settings.RoamingEnabled)
        {
            _behavior.SetBase(PetBehavior.Walking);
            SendToWeb(new { type = "play-motion", motionId = "walking" });
        }
        else
        {
            _behavior.SetBase(PetBehavior.Idle);
            SendToWeb(new { type = "play-motion", motionId = "idle" });
        }
    }

    private void PollGlobalMouse()
    {
        if ((!IsVisible && !_hiddenForMouseAvoidance) || PetWebView.CoreWebView2 is null)
            return;

        try
        {
            var screenPoint = System.Windows.Forms.Cursor.Position;

            SendToWeb(new
            {
                type = "mouse-move",
                x = screenPoint.X,
                y = screenPoint.Y
            });
        }
        catch (Exception ex)
        {
            LogDiagnostic($"Mouse polling error: {ex.Message}");
        }
    }

    private void MoveAlongWorkArea()
    {
        if (!_settings.RoamingEnabled || !IsVisible)
            return;

        var displays = DesktopStageSettings.GetDisplays();
        var display = displays.FirstOrDefault(x => x.IsPrimary)
            ?? displays.FirstOrDefault();

        if (display is null)
            return;

        var min = display.WorkArea.Left;
        var max = display.WorkArea.Right - Width;

        if (max <= min)
            return;

        var step = Math.Max(0.5, _settings.WalkingSpeed * 8.0);

        Left += _roamDirection * step;

        if (Left <= min)
        {
            Left = min;
            _roamDirection = 1;

            SendToWeb(new { type = "play-motion", motionId = "walking" });
        }
        else if (Left >= max)
        {
            Left = max;
            _roamDirection = -1;

            SendToWeb(new { type = "play-motion", motionId = "walking" });
        }
    }

    private void PlaceNearPrimaryWorkArea()
    {
        var displays = DesktopStageSettings.GetDisplays();
        var screen = displays.FirstOrDefault(x => x.IsPrimary)
            ?? displays.FirstOrDefault();

        if (screen is null)
        {
            Left = 40;
            Top = 80;
            return;
        }

        Left = screen.WorkArea.Right - Width - 24;
        Top = screen.WorkArea.Bottom - Height - 24;
    }

    /// <summary>
    /// Applies the X/Y offsets to the WPF window itself, not the renderer.
    /// X/Y range is -1 to 1, with zero meaning the default anchored position.
    /// </summary>
    private void ApplyWindowPosition()
    {
        var displays = DesktopStageSettings.GetDisplays();
        var display = displays.FirstOrDefault(x => x.IsPrimary)
            ?? displays.FirstOrDefault();

        if (display is null)
            return;

        var area = display.WorkArea;

        // Keep the baseline inside the working area even if scale changed.
        var maxLeft = Math.Max(area.Left, area.Right - Width);
        var maxTop = Math.Max(area.Top, area.Bottom - Height);

        _baseLeft = Math.Clamp(_baseLeft, area.Left, maxLeft);
        _baseTop = Math.Clamp(_baseTop, area.Top, maxTop);

        // Normalize the offsets against available travel distance.
        var availableX = Math.Max(0, area.Width - Width);
        var availableY = Math.Max(0, area.Height - Height);

        var offsetX = _settings.CharacterX * availableX;
        var offsetY = _settings.CharacterY * availableY;

        var targetLeft = Math.Clamp(
            _baseLeft + offsetX, area.Left, maxLeft);

        var targetTop = Math.Clamp(
            _baseTop + offsetY, area.Top, maxTop);

        _applyingWindowPosition = true;

        try
        {
            Left = targetLeft;
            Top = targetTop;
        }
        finally
        {
            _applyingWindowPosition = false;
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        UnregisterGlobalHotkey();

        if (Instance == this)
            Instance = null;

        _isClosing = true;
        _webReady = false;

        _roamTimer.Stop();

        _reactionTimer?.Stop();
        _reactionTimer = null;

        base.OnClosed(e);
    }

    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    private void Window_KeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == System.Windows.Input.Key.Escape)
            Close();
    }

    private void SaveSettings()
    {
        try
        {
            var directory = Path.GetDirectoryName(_settingsPath);

            if (!string.IsNullOrEmpty(directory))
                Directory.CreateDirectory(directory);

            _settings.Save(_settingsPath);
        }
        catch (Exception ex) when (
            ex is IOException or UnauthorizedAccessException)
        {
            LogDiagnostic($"Could not save settings: {ex.Message}");
            System.Diagnostics.Debug.WriteLine(ex);
        }
    }

    private static void LogDiagnostic(string message)
    {
        try
        {
            var directory = Path.GetDirectoryName(DiagnosticLogPath);

            if (!string.IsNullOrEmpty(directory))
                Directory.CreateDirectory(directory);

            File.AppendAllText(
                DiagnosticLogPath,
                $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] " +
                $"{message}{Environment.NewLine}");
        }
        catch (IOException)
        {
            // Diagnostics must never crash the pet window.
        }
        catch (UnauthorizedAccessException)
        {
            // Diagnostics must never crash the pet window.
        }
    }
}