
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Fufuu.Wpf.Services;
using Fufuu.Wpf.Pet;
using System.Windows.Interop;
// Explicit WPF aliases avoid conflicts with WinForms/System.Drawing.
using MessageBox = System.Windows.MessageBox;
using Brushes = System.Windows.Media.Brushes;
using Color = System.Windows.Media.Color;
using ColorConverter = System.Windows.Media.ColorConverter;
using HorizontalAlignment = System.Windows.HorizontalAlignment;

namespace Fufuu.Wpf;

public partial class MainWindow : Window
{
    private static readonly HttpClient Http = new()
    {
        Timeout = TimeSpan.FromSeconds(60)
    };

    private const string AgentApiHealthEndpoint =
        "http://127.0.0.1:4319/health";

    private const string StorageEndpoint =
        "http://127.0.0.1:4317/api/conversations";

    private const string MemoryEndpoint =
        "http://127.0.0.1:4317/api/memories";

    private const string SavedConversationId = "sakura-main";

    private const int RecentMessagesForAgent = 30;
    private static readonly string AgentSessionId =
        Guid.NewGuid().ToString("D");

    private static readonly TimeSpan VisionMinimumDelay =
        TimeSpan.FromSeconds(8);

    private static readonly TimeSpan VisionMaximumDelay =
        TimeSpan.FromSeconds(12);

    private static readonly TimeSpan VisionRemarkCooldown =
        TimeSpan.FromSeconds(15);

    private readonly List<ChatMessage> _messages = new();
    private readonly AgentApiClient _agentApi = new();
    private readonly OmniVoiceService _voice = new();
    private DesktopPetWindow? _desktopPetWindow;

    private List<string> _savedMemories = new();

    private JsonObject? _conversationStore;
    private JsonObject? _activeConversation;
    private string? _activeConversationId = SavedConversationId;

    private bool _isSending;
    private bool _historyLoaded;
    private bool _historyLoadFailed;
    private bool _voiceEnabled;
    private bool _isCapturingScreen;
    private bool _isVisionStarting;
    private bool _isClosed;

    private string _voiceLanguage = "auto";
    private string? _pendingScreenshotBase64;

    private long _voiceRequestId;

    private CancellationTokenSource? _visionCancellation;
    private Task? _visionTask;
    private CancellationTokenSource? _chatCancellation;

    private string? _lastVisionFrameHash;
    private string? _lastVisionRemark;
    private DateTime _lastVisionRemarkUtc = DateTime.MinValue;

    public MainWindow()
    {
        InitializeComponent();

        Loaded += async (_, _) =>
        {
            await LoadMemoriesAsync();

            await LoadConversationAsync();
            await CheckAgentApiAsync();

            UpdateVisionButton();
        };

        MessageInput.Focus();
    }

    private void Window_KeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == System.Windows.Input.Key.Escape)
        {
            Close();
        }
    }

    // ------------------------------------------------------------
    // Voice
    // ------------------------------------------------------------

    private void VoiceButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        _voiceEnabled = !_voiceEnabled;

        if (_voiceEnabled)
        {
            VoiceButton.Content = "?   Voice: ON";
            FooterStatus.Text = "Voice enabled - OmniVoice";
        }
        else
        {
            Interlocked.Increment(ref _voiceRequestId);
            _voice.Stop();

            VoiceButton.Content = "?   Voice: OFF";
            FooterStatus.Text = "Voice disabled.";
        }
    }


    private async Task SpeakReplyAsync(string text, long voiceId)
    {
        try
        {
            string speechText = PrepareSpeechText(text);

            if (string.IsNullOrWhiteSpace(speechText))
                return;

            await _voice.SpeakAsync(speechText, _voiceLanguage);

            if (!_isClosed &&
                voiceId == Interlocked.Read(ref _voiceRequestId) &&
                _voiceEnabled)
            {
                FooterStatus.Text = "Voice ready - OmniVoice";
            }
        }
        catch (Exception ex)
        {
            if (!_isClosed &&
                voiceId == Interlocked.Read(ref _voiceRequestId) &&
                _voiceEnabled)
            {
                FooterStatus.Text = "Voice error: " + ex.Message;

                System.Diagnostics.Debug.WriteLine(
                    $"Lumi voice failed: {ex}");
            }
        }
    }

    private static string PrepareSpeechText(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return string.Empty;

        text = System.Text.RegularExpressions.Regex.Replace(
            text,
            @"\*([^*]+)\*",
            match =>
            {
                string action = match.Groups[1].Value
                    .Trim()
                    .ToLowerInvariant();

                return action switch
                {
                    "chuckles" or "chuckle" => "Heh-heh.",
                    "laughs" or "laugh" => "Ha-ha!",
                    "giggles" or "giggle" => "Hehe.",
                    "sighs" or "sigh" => "Sigh...",
                    "gasps" or "gasp" => "Ah!",
                    "clears throat" => "Ahem.",

                    // Visual actions should not be spoken.
                    "smiles" or "smile" => "",
                    "blushes" or "blush" => "",
                    "looks away" => "",
                    "rolls eyes" => "",
                    "shrugs" or "shrug" => "",
                    "nods" or "nod" => "",

                    // Unknown stage directions are omitted.
                    _ => ""
                };
            },
            System.Text.RegularExpressions.RegexOptions.IgnoreCase
        );

        return text.Trim();
    }


    // ------------------------------------------------------------
    // Memory and personality
    // ------------------------------------------------------------

    private async void MemoriesButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        var window = new MemoryManagerWindow
        {
            Owner = this
        };

        window.ShowDialog();

        await LoadMemoriesAsync();
    }

    private async Task LoadMemoriesAsync()
    {
        try
        {
            using var response = await Http.GetAsync(MemoryEndpoint);
            response.EnsureSuccessStatusCode();

            var json = await response.Content.ReadAsStringAsync();

            if (JsonNode.Parse(json) is not JsonObject store ||
                store["version"]?.GetValue<int>() != 1 ||
                store["memories"] is not JsonArray memories)
            {
                throw new InvalidOperationException(
                    "The memory store has an unexpected format.");
            }

            _savedMemories = memories
                .OfType<JsonObject>()
                .Select(memory =>
                    memory["content"]?.GetValue<string>())
                .Where(content =>
                    !string.IsNullOrWhiteSpace(content))
                .Select(content => content!)
                .ToList();

            FooterStatus.Text =
                $"Loaded {_savedMemories.Count} saved memories.";
        }
        catch (Exception ex)
        {
            _savedMemories = new();

            System.Diagnostics.Debug.WriteLine(
                $"Lumi memory load failed: {ex.Message}");

            FooterStatus.Text =
                "Memory unavailable; continuing without saved memories.";
        }
    }

    // ------------------------------------------------------------
    // Connection
    // ------------------------------------------------------------

    private async Task CheckAgentApiAsync()
    {
        try
        {
            using var response =
                await Http.GetAsync(AgentApiHealthEndpoint);

            ConnectionStatus.Text = response.IsSuccessStatusCode
                ? "Lumi agent API connected"
                : "Lumi agent API responded, but needs attention";

            ConnectionStatus.Foreground =
                response.IsSuccessStatusCode
                    ? Brushes.LightGreen
                    : Brushes.Khaki;
        }
        catch
        {
            ConnectionStatus.Text =
                "Lumi agent API offline - start the agent service";

            ConnectionStatus.Foreground = Brushes.Salmon;
        }
    }

    // ------------------------------------------------------------
    // Saved conversation loading and safe saving
    // ------------------------------------------------------------

    private async Task LoadConversationAsync()
    {
        _historyLoaded = false;
        _historyLoadFailed = false;
        _conversationStore = null;
        _activeConversation = null;

        try
        {
            using var response = await Http.GetAsync(StorageEndpoint);
            response.EnsureSuccessStatusCode();

            var json = await response.Content.ReadAsStringAsync();

            if (JsonNode.Parse(json) is not JsonObject store ||
                store["version"]?.GetValue<int>() != 1 ||
                store["conversations"] is not JsonArray conversations)
            {
                throw new InvalidOperationException(
                    "The conversation store has an unexpected format.");
            }

            var conversation = conversations
                .OfType<JsonObject>()
                .FirstOrDefault(c =>
                    string.Equals(
                        c["id"]?.GetValue<string>(),
                        SavedConversationId,
                        StringComparison.Ordinal));

            if (conversation is null ||
                conversation["messages"] is not JsonArray savedMessages)
            {
                throw new InvalidOperationException(
                    $"Couldn't find conversation '{SavedConversationId}'.");
            }

            _conversationStore = store;
            _activeConversation = conversation;
            _activeConversationId = SavedConversationId;

            _messages.Clear();

            MessagesPanel.Children.Clear();

            foreach (var item in savedMessages.OfType<JsonObject>())
            {
                var role = item["role"]?.GetValue<string>();
                var content = item["content"]?.GetValue<string>();

                if (string.IsNullOrWhiteSpace(role) ||
                    content is null)
                {
                    continue;
                }

                _messages.Add(new ChatMessage(role, content));

                if (role == "user")
                {
                    AddMessageBubble(
                        "You",
                        content,
                        isUser: true);
                }
                else if (role == "assistant")
                {
                    AddMessageBubble(
                        "Lumi",
                        content,
                        isUser: false);
                }
            }

            _historyLoaded = true;

            FooterStatus.Text =
                $"Loaded saved history - {savedMessages.Count} messages - " +
                $"{_savedMemories.Count} memories";
        }
        catch (Exception ex)
        {
            _historyLoadFailed = true;
            _activeConversation = null;
            _conversationStore = null;

            FooterStatus.Text =
                "History wasn't loaded. Saved history is protected.";

            MessageBox.Show(
                "Lumi couldn't load the existing conversation. Saving " +
                "to it has been disabled for this session.\n\n" +
                ex.Message,
                "Conversation History");
        }
    }

    private async Task SaveMessageAsync(
        string role,
        string content)
    {
        // Temporary New Chat sessions never modify saved history.
        if (_activeConversationId is null)
            return;

        if (!_historyLoaded ||
            _historyLoadFailed ||
            _conversationStore is null ||
            _activeConversation is null ||
            _activeConversation["messages"] is not JsonArray activeMessages)
        {
            throw new InvalidOperationException(
                "Saved history isn't loaded. No changes were saved.");
        }

        // Re-read the current file before writing to detect external changes.
        using var getResponse = await Http.GetAsync(StorageEndpoint);
        getResponse.EnsureSuccessStatusCode();

        var latestJson =
            await getResponse.Content.ReadAsStringAsync();

        if (JsonNode.Parse(latestJson) is not JsonObject latestStore ||
            latestStore["version"]?.GetValue<int>() != 1 ||
            latestStore["conversations"] is not JsonArray latestConversations)
        {
            throw new InvalidOperationException(
                "The latest conversation store has an unexpected format.");
        }

        var latestConversation = latestConversations
            .OfType<JsonObject>()
            .FirstOrDefault(c =>
                string.Equals(
                    c["id"]?.GetValue<string>(),
                    _activeConversationId,
                    StringComparison.Ordinal));

        if (latestConversation?["messages"] is not JsonArray latestMessages)
        {
            throw new InvalidOperationException(
                "The saved conversation is missing. No changes were saved.");
        }

        if (latestMessages.ToJsonString() !=
            activeMessages.ToJsonString())
        {
            throw new InvalidOperationException(
                "Saved history changed in another app. This save was " +
                "cancelled to reduce the risk of overwriting newer messages.");
        }

        latestMessages.Add(new JsonObject
        {
            ["role"] = role,
            ["content"] = content
        });

        latestConversation["updatedAt"] =
            DateTime.UtcNow.ToString("O");

        using var putRequest = new HttpRequestMessage(
            HttpMethod.Put,
            StorageEndpoint)
        {
            Content = new StringContent(
                latestStore.ToJsonString(),
                Encoding.UTF8,
                "application/json")
        };

        using var putResponse = await Http.SendAsync(putRequest);
        putResponse.EnsureSuccessStatusCode();

        _conversationStore = latestStore;
        _activeConversation = latestConversation;
    }

    // ------------------------------------------------------------
    // Manual screenshot capture
    // ------------------------------------------------------------

    private async void CaptureScreenButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        if (_isCapturingScreen || _isClosed)
            return;

        _isCapturingScreen = true;
        CaptureScreenButton.IsEnabled = false;

        FooterStatus.Text = "Capturing primary screen";

        try
        {
            // The service returns JPEG image data encoded as Base64.
            var screenshot = await Task.Run(
                () => ScreenCaptureService.CapturePrimaryScreenAsBase64(
                    maxWidth: 1280,
                    quality: 70L));

            if (_isClosed)
                return;

            _pendingScreenshotBase64 = screenshot;

            FooterStatus.Text =
                "Screenshot ready - type a question and send it";
        }
        catch (Exception ex)
        {
            FooterStatus.Text =
                "Screen capture failed: " + ex.Message;

            MessageBox.Show(
                "Lumi couldn't capture the primary screen.\n\n" +
                ex.Message,
                "Screen Capture",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }
        finally
        {
            _isCapturingScreen = false;

            if (!_isClosed)
                CaptureScreenButton.IsEnabled = true;
        }
    }

    // ------------------------------------------------------------
    // Vision Mode toggle
    // ------------------------------------------------------------

    private async void VisionModeButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        if (_isClosed || _isVisionStarting)
            return;

        if (_visionModeEnabled())
        {
            await StopVisionModeAsync();
            return;
        }

        await StartVisionModeAsync();
    }

    private bool _visionModeEnabled()
    {
        return _visionCancellation is not null &&
               !_visionCancellation.IsCancellationRequested;
    }

    private async Task StartVisionModeAsync()
    {
        if (_isVisionStarting || _isClosed)
            return;

        if (_historyLoadFailed ||
            (_activeConversationId is not null && !_historyLoaded))
        {
            MessageBox.Show(
                "Conversation history isn't available yet. Wait for the " +
                "history load to finish before starting Vision Mode.",
                "Vision Mode");

            return;
        }

        _isVisionStarting = true;
        UpdateVisionButton();

        try
        {
            FooterStatus.Text =
                "Starting Vision Mode - preparing screen capture";

            // Take a baseline image so the initial screen isn't immediately
            // reported as a new observation.
            var initialFrame = await Task.Run(
                () => ScreenCaptureService.CapturePrimaryScreenAsBase64(
                    maxWidth: 640,
                    quality: 55L));

            if (_isClosed)
                return;

            _lastVisionFrameHash = ComputeImageHash(initialFrame);
            _lastVisionRemark = null;
            _lastVisionRemarkUtc = DateTime.MinValue;

            _visionCancellation?.Dispose();
            _visionCancellation = new CancellationTokenSource();

            var token = _visionCancellation.Token;

            _visionTask = RunVisionLoopAsync(token);

            UpdateVisionButton();

            FooterStatus.Text =
                "Vision Mode ON - local screen observations enabled";
        }
        catch (Exception ex)
        {
            _visionCancellation?.Cancel();
            _visionCancellation?.Dispose();
            _visionCancellation = null;
            _visionTask = null;

            UpdateVisionButton();

            FooterStatus.Text =
                "Couldn't start Vision Mode: " + ex.Message;
        }
        finally
        {
            _isVisionStarting = false;
            UpdateVisionButton();
        }
    }

    private async Task StopVisionModeAsync()
    {
        var cancellation = _visionCancellation;
        var runningTask = _visionTask;

        _visionCancellation = null;
        _visionTask = null;

        try
        {
            cancellation?.Cancel();

            if (runningTask is not null)
            {
                try
                {
                    await runningTask;
                }
                catch (OperationCanceledException)
                {
                    // Expected when Vision Mode is turned off.
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine(
                        $"Vision Mode shutdown: {ex.Message}");
                }
            }
        }
        finally
        {
            cancellation?.Dispose();

            _lastVisionFrameHash = null;
            _lastVisionRemark = null;
            _lastVisionRemarkUtc = DateTime.MinValue;

            UpdateVisionButton();

            if (!_isClosed)
            {
                FooterStatus.Text = "Vision Mode OFF";
            }
        }
    }

    private void UpdateVisionButton()
    {
        if (_isClosed)
            return;

        if (VisionModeButton is null)
            return;

        VisionModeButton.Content =
            _visionModeEnabled()
                ? "?   Vision Mode: ON"
                : "?   Vision Mode: OFF";

        VisionModeButton.IsEnabled = !_isVisionStarting;
    }

    // ------------------------------------------------------------
    // Vision Mode observation loop
    // ------------------------------------------------------------

    private async Task RunVisionLoopAsync(
        CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var delay = GetRandomVisionDelay();

                await Task.Delay(delay, cancellationToken);

                if (cancellationToken.IsCancellationRequested)
                    break;

                // Don't inspect the screen while a message is being sent.
                // This also avoids competing writes to saved history.
                if (_isSending || _isCapturingScreen || _isClosed)
                    continue;

                string screenshot;

                try
                {
                    screenshot = await Task.Run(
                        () => ScreenCaptureService
                            .CapturePrimaryScreenAsBase64(
                                maxWidth: 640,
                                quality: 55L),
                        cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine(
                        $"Vision capture failed: {ex.Message}");

                    continue;
                }

                cancellationToken.ThrowIfCancellationRequested();

                var frameHash = ComputeImageHash(screenshot);

                // Don't send unchanged frames to the vision model.
                if (string.Equals(
                    frameHash,
                    _lastVisionFrameHash,
                    StringComparison.Ordinal))
                {
                    continue;
                }

                _lastVisionFrameHash = frameHash;

                // A normal chat might have started while the screenshot
                // was being captured.
                if (_isSending || _isClosed)
                    continue;

                string? remark;

                try
                {
                    remark = await GetVisionRemarkAsync(
                        screenshot,
                        cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine(
                        $"Vision request failed: {ex.Message}");

                    continue;
                }

                cancellationToken.ThrowIfCancellationRequested();

                if (string.IsNullOrWhiteSpace(remark) ||
                    IsNoComment(remark))
                {
                    continue;
                }

                remark = remark.Trim();

                if (remark.Length == 0)
                    continue;

                if (string.Equals(
                    remark,
                    _lastVisionRemark,
                    StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (DateTime.UtcNow - _lastVisionRemarkUtc <
                    VisionRemarkCooldown)
                {
                    continue;
                }

                // All UI updates and persistence happen on the WPF UI thread.
                await Dispatcher.InvokeAsync(async () =>
                {
                    if (cancellationToken.IsCancellationRequested ||
                        _isClosed ||
                        !_visionModeEnabled() ||
                        _isSending)
                    {
                        return;
                    }

                    _lastVisionRemark = remark;
                    _lastVisionRemarkUtc = DateTime.UtcNow;

                    _messages.Add(
                        new ChatMessage("assistant", remark));
                    AddMessageBubble(
                        "Lumi",
                        remark,
                        isUser: false);

                    try
                    {
                        await SaveMessageAsync("assistant", remark);

                        FooterStatus.Text =
                            "Vision Mode ON - observation added";
                    }
                    catch (Exception ex)
                    {
                        FooterStatus.Text =
                            "Vision remark shown, but history save failed: " +
                            ex.Message;
                    }

                    // Show the observation in the floating pet's speech bubble.
                    DesktopPetWindow.Instance?.SpeakSequence(remark, 5000);

                    // Play the observation aloud only when OmniVoice is enabled.
                    if (_voiceEnabled && !_isClosed)
                    {
                        var voiceId = Interlocked.Increment(
                            ref _voiceRequestId);

                        _ = SpeakReplyAsync(remark, voiceId);
                    }
                });
            }
        }
        catch (OperationCanceledException)
        {
            // Expected when Vision Mode is disabled.
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine(
                $"Vision loop failed: {ex}");
        }
    }

    private async Task<string?> GetVisionRemarkAsync(
        string screenshotBase64,
        CancellationToken cancellationToken)
    {
        return await _agentApi.ChatAsync(
            "wpf",
            "ambient",
            _activeConversationId,
            AgentSessionId,
            Array.Empty<AgentChatTurn>(),
            "Look at the current desktop and decide whether there is one " +
            "brief, useful, non-sensitive observation worth sharing.",
            screenshotBase64,
            cancellationToken);
    }

    private static TimeSpan GetRandomVisionDelay()
    {
        var minimumMilliseconds =
            (int)VisionMinimumDelay.TotalMilliseconds;

        var maximumMilliseconds =
            (int)VisionMaximumDelay.TotalMilliseconds;

        return TimeSpan.FromMilliseconds(
            Random.Shared.Next(
                minimumMilliseconds,
                maximumMilliseconds + 1));
    }

    private static string ComputeImageHash(string base64)
    {
        var bytes = Convert.FromBase64String(base64);
        var hash = SHA256.HashData(bytes);

        return Convert.ToHexString(hash);
    }

    private static bool IsNoComment(string text)
    {
        return string.Equals(
            text.Trim().Trim('"', '\'', '.', ' ', '\r', '\n'),
            "NO_COMMENT",
            StringComparison.OrdinalIgnoreCase);
    }

    // ------------------------------------------------------------
    // Chat input and model requests
    // ------------------------------------------------------------

    private async void SendButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        await SendMessageAsync();
    }

    private async void MessageInput_KeyDown(
        object sender,
        System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == Key.Enter &&
            Keyboard.Modifiers != ModifierKeys.Shift)
        {
            e.Handled = true;
            await SendMessageAsync();
        }
    }

    private async Task SendMessageAsync()
    {
        var text = MessageInput.Text.Trim();

        if (_isSending || text.Length == 0 || _isClosed)
            return;

        if (_activeConversationId is not null &&
            (!_historyLoaded || _historyLoadFailed))
        {
            MessageBox.Show(
                "Saved history isn't loaded, so Lumi won't send messages " +
                "to that conversation. Use New Chat for a temporary session.",
                "History Unavailable");

            return;
        }

        // Consume the screenshot once. It is not stored in ChatMessage
        // or in the saved conversation JSON.
        var screenshot = _pendingScreenshotBase64;
        _pendingScreenshotBase64 = null;

        _isSending = true;
        SendButton.IsEnabled = false;
        MessageInput.Clear();

        FooterStatus.Text = screenshot is null
            ? "Lumi is thinking"
            : "Lumi is analyzing your screenshot";

        _messages.Add(new ChatMessage("user", text));

        AddMessageBubble(
            "You",
            screenshot is null
                ? text
                : text + "\n\n[Screen capture attached]",
            isUser: true);

        Border? replyBlock = null;
        var replyText = new StringBuilder();
        var assistantSaved = false;

        try
        {
            // Only text is persisted. Image data stays local to this request.
            await SaveMessageAsync("user", text);

            replyBlock = AddMessageBubble(
                "Lumi",
                "Thinking...",
                isUser: false);

            var recentMessages = _messages
                .Where(m => m.Role != "system")
                .TakeLast(RecentMessagesForAgent)
                .ToList();

            var history = recentMessages
                .Take(Math.Max(0, recentMessages.Count - 1))
                .Select(message => new AgentChatTurn(
                    message.Role,
                    message.Content));
            _chatCancellation = new CancellationTokenSource();
            await _agentApi.StreamChatAsync(
                "wpf",
                screenshot is null ? "chat" : "vision",
                _activeConversationId,
                AgentSessionId,
                history,
                text,
                screenshot,
                delta =>
                {
                    replyText.Append(delta);
                    if (replyBlock is not null)
                        UpdateBubbleText(replyBlock, replyText.ToString());
                },
                _chatCancellation.Token);

            var finalReply = replyText.ToString().Trim();

            if (finalReply.Length == 0)
            {
                finalReply =
                    "Hmm... I didn't get a reply that time. Try again?";
            }

            await SaveMessageAsync("assistant", finalReply);
            assistantSaved = true;

            _messages.Add(
                new ChatMessage("assistant", finalReply));

            if (replyBlock is not null)
            {
                UpdateBubbleText(replyBlock, finalReply);
            }

            FooterStatus.Text = _activeConversationId is null
                ? $"Temporary chat - {_savedMemories.Count} memories loaded"
                : $"History saved - {_savedMemories.Count} memories loaded";

            // Display Lumi's reply in the floating desktop pet's speech bubble.
            DesktopPetWindow.Instance?.SpeakSequence(finalReply, 5000);

            // Play audio only when the OmniVoice toggle is enabled.
            if (_voiceEnabled)
            {
                var voiceId = Interlocked.Increment(
                    ref _voiceRequestId);

                _ = SpeakReplyAsync(finalReply, voiceId);
            }
        }
        catch (Exception ex)
        {
            if (replyBlock is not null)
            {
                var partial = replyText.ToString();

                UpdateBubbleText(
                    replyBlock,
                    partial.Length > 0
                        ? partial + "\n\n(Response or save failed.)"
                        : "I couldn't complete that request.");
            }

            FooterStatus.Text =
                "Request/history save failed: " + ex.Message;

            if (!assistantSaved)
            {
                ConnectionStatus.Text = "Request or storage error";
                ConnectionStatus.Foreground = Brushes.Khaki;
            }
        }
        finally
        {
            _chatCancellation?.Dispose();
            _chatCancellation = null;
            _isSending = false;

            if (!_isClosed)
            {
                SendButton.IsEnabled = true;
                MessageInput.Focus();
                MessagesScroll.ScrollToEnd();
            }
        }
    }

    // ------------------------------------------------------------
    // Chat display
    // ------------------------------------------------------------

    private Border AddMessageBubble(
        string name,
        string text,
        bool isUser)
    {
        var stack = new StackPanel();

        stack.Children.Add(new TextBlock
        {
            Text = name + "  �  " + DateTime.Now.ToString("HH:mm"),
            Foreground = new SolidColorBrush(
                (Color)ColorConverter.ConvertFromString(
                    isUser ? "#E7AFD9" : "#D7B9F0")),
            FontSize = 10,
            FontWeight = FontWeights.SemiBold,
            Margin = new Thickness(0, 0, 0, 7)
        });

        var body = new TextBlock
        {
            Text = text,
            Foreground = Brushes.WhiteSmoke,
            FontSize = 13,
            TextWrapping = TextWrapping.Wrap,
            LineHeight = 20
        };

        stack.Children.Add(body);

        var border = new Border
        {
            Background = new SolidColorBrush(
                (Color)ColorConverter.ConvertFromString(
                    isUser ? "#302039" : "#211A2C")),
            BorderBrush = new SolidColorBrush(
                (Color)ColorConverter.ConvertFromString(
                    isUser ? "#6A466E" : "#493958")),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(
                13, 13, isUser ? 3 : 13, isUser ? 13 : 3),
            Padding = new Thickness(14),
            Margin = new Thickness(
                isUser ? 45 : 0,
                0,
                isUser ? 0 : 45,
                14),
            HorizontalAlignment = isUser
                ? HorizontalAlignment.Right
                : HorizontalAlignment.Left,
            MaxWidth = 590,
            Child = stack
        };

        MessagesPanel.Children.Add(border);
        MessagesScroll.ScrollToEnd();

        return border;
    }

    private static void UpdateBubbleText(
        Border border,
        string text)
    {
        if (border.Child is StackPanel stack &&
            stack.Children.Count > 1 &&
            stack.Children[1] is TextBlock body)
        {
            body.Text = text;
        }
    }

    // ------------------------------------------------------------
    // New chat
    // ------------------------------------------------------------

    private void NewChatButton_Click(
        object sender,
        RoutedEventArgs e)
    {
        if (_isSending)
            return;

        _activeConversationId = null;
        _activeConversation = null;

        _pendingScreenshotBase64 = null;

        _messages.Clear();

        MessagesPanel.Children.Clear();

        AddMessageBubble(
            "Lumi",
            "Oh? You're here. What is it? ?",
            isUser: false);

        FooterStatus.Text =
            $"New temporary chat - {_savedMemories.Count} memories loaded.";

        MessageInput.Focus();
    }

    // ------------------------------------------------------------
    // Desktop pet window
    // ------------------------------------------------------------

    private void DesktopPetButton_Click(object sender, RoutedEventArgs e)
    {
        if (_desktopPetWindow is null)
        {
            _desktopPetWindow = new DesktopPetWindow();
            _desktopPetWindow.Closed += (_, _) => _desktopPetWindow = null;
            _desktopPetWindow.Show();
        }
        else if (!_desktopPetWindow.IsVisible)
        {
            _desktopPetWindow.Show();
            _desktopPetWindow.Activate();
        }
        else
        {
            _desktopPetWindow.Activate();
        }
    }

    // ------------------------------------------------------------
    // Window controls
    // ------------------------------------------------------------

    private void TitleBar_MouseLeftButtonDown(
        object sender,
        MouseButtonEventArgs e)
    {
        if (e.ButtonState == MouseButtonState.Pressed)
        {
            try
            {
                DragMove();
            }
            catch (InvalidOperationException)
            {
                // Window is no longer movable.
            }
        }
    }

    private void MinimizeButton_Click(
        object sender,
        RoutedEventArgs e) =>
        WindowState = WindowState.Minimized;

    private void CloseButton_Click(
        object sender,
        RoutedEventArgs e) =>
        Close();

    protected override void OnClosed(EventArgs e)
    {
        _isClosed = true;

        try
        {
            _chatCancellation?.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // The chat request has already completed.
        }

        Interlocked.Increment(ref _voiceRequestId);
        _voice.Dispose();

        var cancellation = _visionCancellation;

        _visionCancellation = null;
        _visionTask = null;

        try
        {
            cancellation?.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // The cancellation source has already been disposed.
        }

        // The running loop observes cancellation and exits. Don't block
        // the UI thread while the window is closing.
        cancellation?.Dispose();

        _pendingScreenshotBase64 = null;

        base.OnClosed(e);
    }

    private sealed record ChatMessage(
        string Role,
        string Content);
}
