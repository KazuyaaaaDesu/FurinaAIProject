using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Fufuu.Wpf.Services;

public sealed class AgentApiClient
{
    private static readonly Uri BaseUri = new("http://127.0.0.1:4319/");
    private static readonly HttpClient Http = new()
    {
        Timeout = TimeSpan.FromSeconds(130)
    };

    private static readonly JsonSerializerOptions JsonOptions =
        new(JsonSerializerDefaults.Web);

    public async Task<bool> IsHealthyAsync(
        CancellationToken cancellationToken = default)
    {
        using var response = await Http.GetAsync(
            new Uri(BaseUri, "health"),
            cancellationToken);
        return response.IsSuccessStatusCode;
    }

    public async Task<string> ChatAsync(
        string clientId,
        string channel,
        string? conversationId,
        string sessionId,
        IEnumerable<AgentChatTurn> history,
        string text,
        string? imageBase64 = null,
        CancellationToken cancellationToken = default)
    {
        using var request = CreateRequest(
            "chat",
            clientId,
            channel,
            conversationId,
            sessionId,
            history,
            text,
            imageBase64);
        using var response = await Http.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);

        if (!response.IsSuccessStatusCode)
            throw await CreateApiExceptionAsync(response, cancellationToken);

        await using var stream =
            await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(
            stream,
            cancellationToken: cancellationToken);

        var root = document.RootElement;
        if (!root.TryGetProperty("apiVersion", out var version) ||
            version.GetString() != "1.0" ||
            !root.TryGetProperty("message", out var message) ||
            !message.TryGetProperty("content", out var content) ||
            content.ValueKind != JsonValueKind.String)
        {
            throw new InvalidDataException(
                "The Lumi agent API returned an invalid chat response.");
        }

        return content.GetString() ?? string.Empty;
    }

    public async Task StreamChatAsync(
        string clientId,
        string channel,
        string? conversationId,
        string sessionId,
        IEnumerable<AgentChatTurn> history,
        string text,
        string? imageBase64,
        Action<string> onDelta,
        CancellationToken cancellationToken = default)
    {
        using var request = CreateRequest(
            "chat/stream",
            clientId,
            channel,
            conversationId,
            sessionId,
            history,
            text,
            imageBase64);
        using var response = await Http.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);

        if (!response.IsSuccessStatusCode)
            throw await CreateApiExceptionAsync(response, cancellationToken);

        await using var stream =
            await response.Content.ReadAsStreamAsync(cancellationToken);
        using var reader = new StreamReader(stream);
        var eventName = string.Empty;
        var data = new StringBuilder();
        var completed = false;

        void DispatchEvent()
        {
            if (data.Length == 0)
            {
                eventName = string.Empty;
                return;
            }

            using var document = JsonDocument.Parse(data.ToString());
            var payload = document.RootElement;
            switch (eventName)
            {
                case "delta":
                    if (payload.TryGetProperty("text", out var textValue) &&
                        textValue.ValueKind == JsonValueKind.String)
                    {
                        onDelta(textValue.GetString() ?? string.Empty);
                    }
                    break;
                case "done":
                    completed = true;
                    break;
                case "cancelled":
                    throw new OperationCanceledException(
                        "The Lumi request was cancelled.",
                        cancellationToken);
                case "error":
                    var message = payload
                        .GetProperty("error")
                        .GetProperty("message")
                        .GetString();
                    throw new InvalidOperationException(
                        message ?? "The Lumi agent API stream failed.");
            }

            eventName = string.Empty;
            data.Clear();
        }

        while (await reader.ReadLineAsync(cancellationToken) is { } line)
        {
            if (line.Length == 0)
            {
                DispatchEvent();
            }
            else if (line.StartsWith("event:", StringComparison.Ordinal))
            {
                eventName = line["event:".Length..].Trim();
            }
            else if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                if (data.Length > 0) data.Append('\n');
                data.Append(line["data:".Length..].TrimStart());
            }
        }

        DispatchEvent();
        if (!completed)
            throw new InvalidDataException(
                "The Lumi agent API stream ended before completion.");
    }

    private static HttpRequestMessage CreateRequest(
        string path,
        string clientId,
        string channel,
        string? conversationId,
        string sessionId,
        IEnumerable<AgentChatTurn> history,
        string text,
        string? imageBase64)
    {
        var message = new Dictionary<string, object?>
        {
            ["text"] = text
        };
        if (imageBase64 is not null)
        {
            message["images"] = new[]
            {
                new { mimeType = "image/jpeg", data = imageBase64 }
            };
        }

        var payload = new Dictionary<string, object?>
        {
            ["requestId"] = Guid.NewGuid().ToString("D"),
            ["clientId"] = clientId,
            ["channel"] = channel,
            ["sessionId"] = sessionId,
            ["history"] = history.Select(turn => new
            {
                role = turn.Role,
                content = turn.Content
            }),
            ["message"] = message
        };
        if (!string.IsNullOrWhiteSpace(conversationId))
            payload["conversationId"] = conversationId;

        return new HttpRequestMessage(
            HttpMethod.Post,
            new Uri(BaseUri, $"api/v1/{path}"))
        {
            Content = new StringContent(
                JsonSerializer.Serialize(payload, JsonOptions),
                Encoding.UTF8,
                "application/json")
        };
    }

    private static async Task<HttpRequestException> CreateApiExceptionAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        string? message = null;
        try
        {
            using var document = JsonDocument.Parse(body);
            message = document.RootElement
                .GetProperty("error")
                .GetProperty("message")
                .GetString();
        }
        catch (JsonException)
        {
        }
        catch (KeyNotFoundException)
        {
        }

        return new HttpRequestException(
            message ?? $"The Lumi agent API returned HTTP {(int)response.StatusCode}.",
            null,
            response.StatusCode);
    }
}

public sealed record AgentChatTurn(string Role, string Content);
