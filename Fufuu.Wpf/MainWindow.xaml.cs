using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.IO;

namespace Fufuu.Wpf;

public partial class MainWindow : Window
{
    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };
    private const string OllamaEndpoint = "http://localhost:11434/api/chat";
    private const string ModelName = "llama3.1:latest";
    private readonly List<ChatMessage> _messages = new();
    private readonly string _systemPrompt;
    private bool _isSending;

    public MainWindow()
    {
        InitializeComponent();
        _systemPrompt = LoadPersonality();
        _messages.Add(new ChatMessage("system", _systemPrompt));
        Loaded += async (_, _) => await CheckOllamaAsync();
        MessageInput.Focus();
    }

    private static string LoadPersonality()
    {
        var path = Path.Combine(
            AppContext.BaseDirectory,
            "Assets",
            "Personality.md");

        if (File.Exists(path))
        {
            var prompt = File.ReadAllText(path);

            MessageBox.Show(
                $"Loaded personality from:\n{path}\n\n" +
                $"Characters: {prompt.Length}",
                "Fufuu Personality Check");

            return prompt;
        }

        MessageBox.Show(
            $"Personality file not found:\n{path}\n\nUsing fallback prompt.",
            "Fufuu Personality Check");

        return "You are Fufuu, a warm, playful local AI companion. " +
               "Speak naturally in first person as Fufuu. " +
               "Never describe yourself as an AI assistant being tested. " +
               "Be kind, playful, and respect the user's privacy.";
    }

    private async Task CheckOllamaAsync()
    {
        try
        {
            using var response = await Http.GetAsync("http://localhost:11434/api/tags");
            ConnectionStatus.Text = response.IsSuccessStatusCode
                ? $"Ollama connected · {ModelName}"
                : "Ollama responded, but needs attention";
            ConnectionStatus.Foreground = response.IsSuccessStatusCode ? Brushes.LightGreen : Brushes.Khaki;
        }
        catch
        {
            ConnectionStatus.Text = "Ollama offline · start Ollama to chat";
            ConnectionStatus.Foreground = Brushes.Salmon;
        }
    }

    private async void SendButton_Click(object sender, RoutedEventArgs e) => await SendMessageAsync();

    private async void MessageInput_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && Keyboard.Modifiers != ModifierKeys.Shift)
        {
            e.Handled = true;
            await SendMessageAsync();
        }
    }

    private async Task SendMessageAsync()
    {
        var text = MessageInput.Text.Trim();
        if (_isSending || text.Length == 0) return;

        _isSending = true;
        SendButton.IsEnabled = false;
        MessageInput.Clear();
        FooterStatus.Text = "Fufuu is thinking…";
        _messages.Add(new ChatMessage("user", text));
        AddMessageBubble("You", text, isUser: true);
        var replyBlock = AddMessageBubble("Fufuu", "…", isUser: false);
        var replyText = new StringBuilder();

        try
        {
            var payload = new
            {
                model = ModelName,
                stream = true,
                messages = _messages.Select(m => new { role = m.Role, content = m.Content }).ToArray()
            };
            using var request = new HttpRequestMessage(HttpMethod.Post, OllamaEndpoint)
            {
                Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json")
            };
            using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
            response.EnsureSuccessStatusCode();
            await using var stream = await response.Content.ReadAsStreamAsync();
            using var reader = new StreamReader(stream);

            string? line;
            while ((line = await reader.ReadLineAsync()) != null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;

                using var json = JsonDocument.Parse(line);
                var root = json.RootElement;

                if (root.TryGetProperty("error", out var error))
                    throw new InvalidOperationException(
                        error.GetString() ?? "Ollama returned an error.");

                if (root.TryGetProperty("message", out var message) &&
                    message.TryGetProperty("content", out var content))
                {
                    replyText.Append(content.GetString());
                    UpdateBubbleText(replyBlock, replyText.ToString());
                }

                if (root.TryGetProperty("done", out var done) && done.GetBoolean())
                    break;
            }

            var finalReply = replyText.ToString().Trim();
            if (finalReply.Length == 0) finalReply = "Hmm… I didn't get a reply that time. Try again?";
            _messages.Add(new ChatMessage("assistant", finalReply));
            UpdateBubbleText(replyBlock, finalReply);
            FooterStatus.Text = "Connected locally · chat is not yet linked to your existing history file.";
        }
        catch (Exception ex)
        {
            var message = "I couldn't reach Ollama. Make sure Ollama is running and the model '" + ModelName + "' is installed.\n\nDetails: " + ex.Message;
            UpdateBubbleText(replyBlock, message);
            FooterStatus.Text = "Couldn't connect to Ollama.";
            ConnectionStatus.Text = "Ollama connection error";
            ConnectionStatus.Foreground = Brushes.Salmon;
        }
        finally
        {
            _isSending = false;
            SendButton.IsEnabled = true;
            MessageInput.Focus();
            MessagesScroll.ScrollToEnd();
        }
    }

    private Border AddMessageBubble(string name, string text, bool isUser)
    {
        var stack = new StackPanel();
        stack.Children.Add(new TextBlock
        {
            Text = name + "  ·  " + DateTime.Now.ToString("HH:mm"),
            Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString(isUser ? "#E7AFD9" : "#D7B9F0")),
            FontSize = 10,
            FontWeight = FontWeights.SemiBold,
            Margin = new Thickness(0, 0, 0, 7)
        });
        var body = new TextBlock { Text = text, Foreground = Brushes.WhiteSmoke, FontSize = 13, TextWrapping = TextWrapping.Wrap, LineHeight = 20 };
        stack.Children.Add(body);
        var border = new Border
        {
            Background = new SolidColorBrush((Color)ColorConverter.ConvertFromString(isUser ? "#302039" : "#211A2C")),
            BorderBrush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(isUser ? "#6A466E" : "#493958")),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(13, 13, isUser ? 3 : 13, isUser ? 13 : 3),
            Padding = new Thickness(14),
            Margin = new Thickness(isUser ? 45 : 0, 0, isUser ? 0 : 45, 14),
            HorizontalAlignment = isUser ? HorizontalAlignment.Right : HorizontalAlignment.Left,
            MaxWidth = 590,
            Child = stack
        };
        MessagesPanel.Children.Add(border);
        MessagesScroll.ScrollToEnd();
        return border;
    }

    private static void UpdateBubbleText(Border border, string text)
    {
        if (border.Child is StackPanel stack && stack.Children.Count > 1 && stack.Children[1] is TextBlock body)
            body.Text = text;
    }

    private void NewChatButton_Click(object sender, RoutedEventArgs e)
    {
        if (_isSending) return;
        _messages.Clear();
        _messages.Add(new ChatMessage("system", _systemPrompt));
        MessagesPanel.Children.Clear();
        AddMessageBubble("Fufuu", "Oh? You're here. What is it? ♡", isUser: false);
        FooterStatus.Text = "New in-memory chat started. Your existing conversations were not changed.";
        MessageInput.Focus();
    }

    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ButtonState == MouseButtonState.Pressed)
        {
            try { DragMove(); } catch (InvalidOperationException) { }
        }
    }

    private void MinimizeButton_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void CloseButton_Click(object sender, RoutedEventArgs e) => Close();

    private sealed record ChatMessage(string Role, string Content);
}
