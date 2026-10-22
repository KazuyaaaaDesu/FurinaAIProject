
using System;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using MessageBox = System.Windows.MessageBox;

namespace Fufuu.Wpf;

public partial class MemoryManagerWindow : Window
{
    private static readonly HttpClient Http = new()
    {
        Timeout = TimeSpan.FromSeconds(30)
    };

    private const string Endpoint = "http://127.0.0.1:4317/api/memories";

    private readonly ObservableCollection<MemoryItem> _items = new();
    private string? _editingId;

    public MemoryManagerWindow()
    {
        InitializeComponent();
        MemoryList.ItemsSource = _items;

        Loaded += async (_, _) => await LoadMemoriesAsync();
    }

    private async Task<JsonObject> GetStoreAsync()
    {
        using var response = await Http.GetAsync(Endpoint);
        response.EnsureSuccessStatusCode();

        var json = await response.Content.ReadAsStringAsync();

        if (JsonNode.Parse(json) is not JsonObject store ||
            store["version"]?.GetValue<int>() != 1 ||
            store["memories"] is not JsonArray)
        {
            throw new InvalidOperationException(
                "The memory API returned an unexpected format.");
        }

        return store;
    }

    private async Task LoadMemoriesAsync()
    {
        try
        {
            var store = await GetStoreAsync();
            var memories = (JsonArray)store["memories"]!;

            _items.Clear();

            foreach (var entry in memories.OfType<JsonObject>())
            {
                var id = entry["id"]?.GetValue<string>();
                var content = entry["content"]?.GetValue<string>();
                var createdAt = entry["createdAt"]?.ToString() ?? "";

                if (string.IsNullOrWhiteSpace(id) ||
                    string.IsNullOrWhiteSpace(content))
                    continue;

                _items.Add(new MemoryItem(
                    id,
                    content,
                    createdAt));
            }

            CountText.Text = $"{_items.Count} saved memories";
            StatusText.Text = "Loaded from your local memory store.";
        }
        catch (Exception ex)
        {
            StatusText.Text = "Couldn't load memories: " + ex.Message;
        }
    }

    private void MemoryList_SelectionChanged(
        object sender, SelectionChangedEventArgs e)
    {
        if (MemoryList.SelectedItem is not MemoryItem item)
            return;

        _editingId = item.Id;
        MemoryInput.Text = item.Content;
        EditorTitle.Text = "Edit selected memory";
        SaveMemoryButton.Content = "Save changes";
        CancelEditButton.Visibility = Visibility.Visible;
    }

    private void CancelEditButton_Click(
        object sender, RoutedEventArgs e)
    {
        ResetEditor();
    }

    private void ResetEditor()
    {
        _editingId = null;
        MemoryList.SelectedItem = null;
        MemoryInput.Clear();
        EditorTitle.Text = "Add a memory";
        SaveMemoryButton.Content = "Save memory";
        CancelEditButton.Visibility = Visibility.Collapsed;
    }

    private async void SaveMemoryButton_Click(
        object sender, RoutedEventArgs e)
    {
        var content = MemoryInput.Text.Trim();

        if (content.Length == 0)
        {
            StatusText.Text = "Enter some memory text first.";
            return;
        }

        SaveMemoryButton.IsEnabled = false;

        try
        {
            // Fetch the latest store before changing it so other
            // memories and their metadata are retained.
            var store = await GetStoreAsync();
            var memories = (JsonArray)store["memories"]!;

            if (_editingId is not null)
            {
                var existing = memories
                    .OfType<JsonObject>()
                    .FirstOrDefault(m =>
                        m["id"]?.GetValue<string>() == _editingId);

                if (existing is null)
                {
                    StatusText.Text =
                        "This memory changed or was deleted elsewhere. Refresh and try again.";
                    return;
                }

                existing["content"] = content;
            }
            else
            {
                memories.Add(new JsonObject
                {
                    ["id"] = Guid.NewGuid().ToString(),
                    ["content"] = content,
                    ["createdAt"] = DateTime.UtcNow.ToString("O")
                });
            }

            await PutStoreAsync(store);
            ResetEditor();
            await LoadMemoriesAsync();
            StatusText.Text = "Memory saved.";
        }
        catch (Exception ex)
        {
            StatusText.Text = "Save failed: " + ex.Message;
        }
        finally
        {
            SaveMemoryButton.IsEnabled = true;
        }
    }

    private async void DeleteMemoryButton_Click(
        object sender, RoutedEventArgs e)
    {
        if (MemoryList.SelectedItem is not MemoryItem selected)
        {
            StatusText.Text = "Select a memory to delete.";
            return;
        }

        var answer = MessageBox.Show(
            this,
            $"Delete this memory?\n\n{selected.Content}",
            "Confirm memory deletion",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning);

        if (answer != MessageBoxResult.Yes)
            return;

        try
        {
            var store = await GetStoreAsync();
            var memories = (JsonArray)store["memories"]!;

            var existing = memories
                .OfType<JsonObject>()
                .FirstOrDefault(m =>
                    m["id"]?.GetValue<string>() == selected.Id);

            if (existing is null)
            {
                StatusText.Text =
                    "That memory no longer exists. Refresh the list.";
                return;
            }

            memories.Remove(existing);
            await PutStoreAsync(store);

            ResetEditor();
            await LoadMemoriesAsync();
            StatusText.Text = "Memory deleted.";
        }
        catch (Exception ex)
        {
            StatusText.Text = "Delete failed: " + ex.Message;
        }
    }

    private async Task PutStoreAsync(JsonObject store)
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, Endpoint)
        {
            Content = new StringContent(
                store.ToJsonString(),
                Encoding.UTF8,
                "application/json")
        };

        using var response = await Http.SendAsync(request);
        response.EnsureSuccessStatusCode();
    }

    private async void RefreshButton_Click(
        object sender, RoutedEventArgs e)
    {
        ResetEditor();
        await LoadMemoriesAsync();
    }

    private sealed record MemoryItem(
        string Id,
        string Content,
        string CreatedAt);
}
