
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
/// settings, and communication with the JavaScript pet stage.
/// </summary>
public partial class DesktopPetWindow : Window
{
    public static DesktopPetWindow? Instance { get; private set; }

    // Win32 global hotkey support.
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(
        IntPtr hWnd,
        int id,
        uint fsModifiers,
        uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(
        IntPtr hWnd,
        int id);

    private const int HotKeyId = 9000;
    private const int WmHotKey = 0x0312;

    private const uint ModAlt = 0x0001;
    private const uint ModControl = 0x0002;
    private const uint ModifierCtrlAlt = ModControl | ModAlt;
    private const uint KeyT = 0x54;

    private IntPtr _windowHandle;
    private HwndSource? _source;
    private bool _hotkeyRegistered;

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

    // Approximately 60 updates per second.
    private readonly DispatcherTimer _roamTimer =
        new() { Interval = TimeSpan.FromMilliseconds(16) };

    private int _roamDirection = -1;

    public DesktopPetWindow()
    {
        InitializeComponent();
        Instance = this;

        _settings = DesktopStageSettings.Load(_settingsPath);

        Width = _settings.Width;
        Height = _settings.Height;
        Topmost = _settings.AlwaysOnTop;

        PlaceNearPrimaryWorkArea();

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

        // Update roaming and global mouse position on every timer tick.
        _roamTimer.Tick += (_, _) =>
        {
            if (_isClosing || !IsVisible)
                return;

            MoveAlongWorkArea();
            PollGlobalMouse();
        };

        LogDiagnostic("DesktopPetWindow constructed.");

        LogDiagnostic(
            $"Settings: mode={_settings.DisplayMode}, " +
            $"size={Width}x{Height}, " +
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
            _windowHandle,
            HotKeyId,
            ModifierCtrlAlt,
            KeyT);

        if (_hotkeyRegistered)
        {
            LogDiagnostic(
                "Global hotkey registered: Ctrl + Alt + T.");
        }
        else
        {
            var error = Marshal.GetLastWin32Error();

            LogDiagnostic(
                $"Failed to register Ctrl + Alt + T. Win32 error: {error}. " +
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
            {
                LogDiagnostic("Global hotkey unregistered.");
            }
            else
            {
                LogDiagnostic(
                    $"Failed to unregister global hotkey. " +
                    $"Win32 error: {Marshal.GetLastWin32Error()}.");
            }

            _hotkeyRegistered = false;
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
        if (msg == WmHotKey && wParam.ToInt32() == HotKeyId)
        {
            LogDiagnostic(
                "Global hotkey pressed: Ctrl + Alt + T.");

            // Forward the toolbar toggle command to React.
            SendToWeb(new
            {
                type = "toggle-toolbar"
            });

            handled = true;
        }

        return IntPtr.Zero;
    }

    private async void InitializePetAsync(
        object? sender,
        RoutedEventArgs e)
    {
        if (_initializationStarted)
            return;

        _initializationStarted = true;

        try
        {
            var webRoot = Path.Combine(
                AppContext.BaseDirectory,
                "Web");

            var entry = Path.Combine(
                webRoot,
                "PetStage.html");

            LogDiagnostic(
                $"Application base directory: {AppContext.BaseDirectory}");

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
                    this,
                    message,
                    "Lumi Desktop Pet",
                    MessageBoxButton.OK,
                    MessageBoxImage.Information);

                Close();
                return;
            }

            await PetWebView.EnsureCoreWebView2Async();

            var webFolder = System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Web");
            PetWebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "lumi.local",
                webFolder,
                Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind.Allow
            );

            if (_isClosing)
                return;

            var core = PetWebView.CoreWebView2;

            if (core is null)
            {
                throw new InvalidOperationException(
                    "WebView2 initialized without a CoreWebView2 instance.");
            }

            LogDiagnostic(
                $"WebView2 initialized. Version: " +
                core.Environment.BrowserVersionString);

            var consoleReceiver =
                core.GetDevToolsProtocolEventReceiver(
                    "Runtime.consoleAPICalled");

            consoleReceiver.DevToolsProtocolEventReceived += (_, args) =>
            {
                LogDiagnostic($"JS CONSOLE: {args.ParameterObjectAsJson}");
            };

            var exceptionReceiver =
                core.GetDevToolsProtocolEventReceiver(
                    "Runtime.exceptionThrown");

            exceptionReceiver.DevToolsProtocolEventReceived += (_, args) =>
            {
                LogDiagnostic($"JS EXCEPTION: {args.ParameterObjectAsJson}");
            };

            await core.CallDevToolsProtocolMethodAsync(
                "Runtime.enable",
                "{}");

            LogDiagnostic("JavaScript diagnostics enabled.");

            core.WebResourceResponseReceived += (_, args) =>
            {
                try
                {
                    var response = args.Response;

                    if (response is not null &&
                        response.StatusCode >= 400)
                    {
                        LogDiagnostic(
                            $"HTTP {response.StatusCode}: " +
                            $"{args.Request.Uri}");
                    }
                }
                catch (Exception ex)
                {
                    LogDiagnostic(
                        $"Resource diagnostic error: {ex.Message}");
                }
            };

            core.ProcessFailed += (_, args) =>
            {
                LogDiagnostic(
                    $"WEBVIEW PROCESS FAILED: {args.ProcessFailedKind}");
            };

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
            {
                LogDiagnostic($"Navigation starting: {args.Uri}");
            };

            core.NavigationCompleted += (_, args) =>
            {
                LogDiagnostic(
                    $"Navigation completed: success={args.IsSuccess}, " +
                    $"error={args.WebErrorStatus}, URL={PetWebView.Source}");

                if (!args.IsSuccess)
                {
                    LogDiagnostic(
                        "WebView navigation failed. Check the diagnostic log.");
                }
                else
                {
                    LogDiagnostic("WebView navigation succeeded.");
                }
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
                ex.Message +
                "\n\nDiagnostic log:\n" + DiagnosticLogPath,
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

            var messageType = typeElement.GetString();

            switch (messageType)
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

                        SendToWeb(new
                        {
                            type = "play-motion",
                            motionId = "walking"
                        });
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
                    if (root.TryGetProperty("settings", out _))
                    {
                        LogDiagnostic(
                            "Updating stage settings from React toolbar.");
                    }
                    break;

                // NEW: Open or focus the main chat window.
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
                                {
                                    mainWindow.Show();
                                }

                                if (mainWindow.WindowState == WindowState.Minimized)
                                {
                                    mainWindow.WindowState = WindowState.Normal;
                                }

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
                                "Lumi couldn't open the chat window.\n\n" +
                                ex.Message,
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
                        // Check if control window is already open to avoid spamming multiple windows
                        var existingWindow = System.Windows.Application.Current.Windows
                            .OfType<FufuuControlWindow>()
                            .FirstOrDefault();

                        if (existingWindow == null)
                        {
                            var controlWindow = new FufuuControlWindow(this);
                            controlWindow.Owner = this;
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

                    SendToWeb(new
                    {
                        type = "play-motion",
                        motionId = "wave"
                    });

                    _reactionTimer = new DispatcherTimer
                    {
                        Interval = TimeSpan.FromSeconds(2.8)
                    };

                    _reactionTimer.Tick += (_, _) =>
                    {
                        _reactionTimer?.Stop();
                        _reactionTimer = null;

                        if (_reactionToken == reactionToken &&
                            reactionToken.HasValue)
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
                    LogDiagnostic(
                        $"Unhandled web message type: {messageType}");
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

    /// <summary>
    /// Sends a speech message to the React pet stage.
    /// </summary>
    public void Speak(string text, int durationMs = 4000)
    {
        SendToWeb(new
        {
            type = "speak",
            text,
            duration = durationMs
        });
    }

    /// <summary>
    /// Splits a long response into sentences and displays them sequentially.
    /// </summary>
    public void SpeakSequence(
        string fullText,
        int durationPerSentenceMs = 4500)
    {
        var sentences =
            System.Text.RegularExpressions.Regex.Split(
                fullText,
                @"(?<=[.!?])\s+")
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
            LogDiagnostic(
                $"Failed to send message to pet stage: {ex.Message}");
        }
    }

    private void SendSettings()
    {
        LogDiagnostic(
            $"Sending settings. DisplayMode={_settings.DisplayMode}");

        SendToWeb(new
        {
            type = "settings",
            settings = _settings
        });
    }

    private void Mode2D_Click(object sender, RoutedEventArgs e)
    {
        SetMode("2d");
    }

    private void Mode3D_Click(object sender, RoutedEventArgs e)
    {
        SetMode("3d");
    }

    private void SetMode(string mode)
    {
        LogDiagnostic($"Changing display mode to: {mode}");

        _settings = _settings with
        {
            DisplayMode = mode
        };

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

            SendToWeb(new
            {
                type = "play-motion",
                motionId = "walking"
            });
        }
        else
        {
            _behavior.SetBase(PetBehavior.Idle);

            SendToWeb(new
            {
                type = "play-motion",
                motionId = "idle"
            });
        }
    }

    private void PollGlobalMouse()
    {
        if (!IsVisible || PetWebView.CoreWebView2 is null)
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

        var step = Math.Max(
            0.5,
            _settings.WalkingSpeed * 8.0);

        Left += _roamDirection * step;

        if (Left <= min)
        {
            Left = min;
            _roamDirection = 1;

            SendToWeb(new
            {
                type = "play-motion",
                motionId = "walking"
            });
        }
        else if (Left >= max)
        {
            Left = max;
            _roamDirection = -1;

            SendToWeb(new
            {
                type = "play-motion",
                motionId = "walking"
            });
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

    private void Close_Click(object sender, RoutedEventArgs e)
    {
        Close();
    }

    private void Window_KeyDown(
        object sender,
        System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == System.Windows.Input.Key.Escape)
        {
            Close();
        }
    }

    private void SaveSettings()
    {
        try
        {
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

