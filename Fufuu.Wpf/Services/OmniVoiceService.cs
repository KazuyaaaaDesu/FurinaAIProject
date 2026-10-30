using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Fufuu.Wpf.Services;

public sealed class OmniVoiceService : IDisposable
{
    private const string PythonPath = @"D:\AI\LocalCompanion\omnivoice\.venv\Scripts\python.exe";
    private const string ServerScript = @"D:\AI\LocalCompanion\omnivoice\omnivoice_server.py";
    private const string BaseUrl = "http://127.0.0.1:8765";

    // Keep chunks large enough for natural prosody, but small enough to reduce
    // the time before the first audio is ready.
    private const int MaxChunkCharacters = 260;

    private static readonly HttpClient Http = new() { Timeout = Timeout.InfiniteTimeSpan };
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly object _sync = new();
    private CancellationTokenSource? _activeSpeech;
    private Process? _serverProcess;
    private bool _disposed;

    public async Task SpeakAsync(string text, string language = "auto", double rate = 0.65)
    {
        text = CleanText(text);
        if (string.IsNullOrWhiteSpace(text))
            return;

        Stop();

        var cancellation = new CancellationTokenSource();
        lock (_sync)
        {
            if (_disposed)
            {
                cancellation.Dispose();
                return;
            }

            _activeSpeech = cancellation;
        }

        var entered = false;
        try
        {
            await _gate.WaitAsync(cancellation.Token);
            entered = true;

            await EnsureServerAsync(cancellation.Token);

            List<string> chunks = SplitIntoChunks(text, MaxChunkCharacters);
            if (chunks.Count == 0)
                return;

            // Generate chunk 1. Once it is ready, request chunk 2 before
            // playing chunk 1. GPU synthesis and WAV playback then overlap.
            string? currentWav = await GenerateWavAsync(chunks[0], cancellation.Token);

            try
            {
                for (int i = 0; i < chunks.Count; i++)
                {
                    cancellation.Token.ThrowIfCancellationRequested();

                    Task<string?>? nextGeneration = null;
                    if (i + 1 < chunks.Count)
                    {
                        nextGeneration = GenerateWavAsync(
                            chunks[i + 1],
                            cancellation.Token);
                    }

                    if (currentWav is not null)
                    {
                        try
                        {
                            await PlayWavAsync(currentWav, cancellation.Token);
                        }
                        finally
                        {
                            TryDelete(currentWav);
                        }
                    }

                    currentWav = null;

                    if (nextGeneration is not null)
                    {
                        currentWav = await nextGeneration;
                    }
                }
            }
            finally
            {
                if (currentWav is not null)
                    TryDelete(currentWav);
            }
        }
        catch (OperationCanceledException)
        {
            // Expected when the user stops speech or starts a newer reply.
        }
        finally
        {
            if (entered)
                _gate.Release();

            lock (_sync)
            {
                if (ReferenceEquals(_activeSpeech, cancellation))
                    _activeSpeech = null;
            }

            cancellation.Dispose();
        }
    }

    private async Task<string?> GenerateWavAsync(string text, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();

        using var request = new HttpRequestMessage(HttpMethod.Post, BaseUrl + "/synthesize")
        {
            Content = new StringContent(
                JsonSerializer.Serialize(new { text }),
                Encoding.UTF8,
                "application/json")
        };

        using var response = await Http.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            token);

        if (!response.IsSuccessStatusCode)
        {
            var error = await response.Content.ReadAsStringAsync(token);
            throw new InvalidOperationException(
                $"OmniVoice service returned {(int)response.StatusCode}: {error}");
        }

        byte[] wav = await response.Content.ReadAsByteArrayAsync(token);
        token.ThrowIfCancellationRequested();

        string path = Path.Combine(
            Path.GetTempPath(),
            $"lumi-omnivoice-{Guid.NewGuid():N}.wav");

        try
        {
            await File.WriteAllBytesAsync(path, wav, token);

            if (new FileInfo(path).Length <= 44)
                throw new InvalidOperationException("OmniVoice returned an invalid WAV.");

            return path;
        }
        catch
        {
            TryDelete(path);
            throw;
        }
    }

    private async Task EnsureServerAsync(CancellationToken token)
    {
        if (await IsReadyAsync(token))
            return;

        lock (_sync)
        {
            if (_disposed)
                throw new ObjectDisposedException(nameof(OmniVoiceService));

            if (_serverProcess is not { HasExited: false })
            {
                if (!File.Exists(PythonPath))
                    throw new FileNotFoundException("Python not found", PythonPath);

                if (!File.Exists(ServerScript))
                    throw new FileNotFoundException("OmniVoice server script not found", ServerScript);

                _serverProcess = Process.Start(new ProcessStartInfo
                {
                    FileName = PythonPath,
                    WorkingDirectory = Path.GetDirectoryName(ServerScript)!,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    ArgumentList = { ServerScript }
                }) ?? throw new InvalidOperationException("Could not start OmniVoice service.");
            }
        }

        var deadline = DateTime.UtcNow.AddMinutes(5);
        while (DateTime.UtcNow < deadline)
        {
            token.ThrowIfCancellationRequested();

            if (await IsReadyAsync(token))
                return;

            lock (_sync)
            {
                if (_serverProcess is { HasExited: true } process)
                {
                    int code = process.ExitCode;
                    _serverProcess = null;
                    throw new InvalidOperationException(
                        $"OmniVoice service exited with code {code}. Run the Python script manually to inspect startup errors.");
                }
            }

            await Task.Delay(1000, token);
        }

        throw new TimeoutException("OmniVoice did not become ready within five minutes.");
    }

    private static async Task<bool> IsReadyAsync(CancellationToken token)
    {
        try
        {
            using var response = await Http.GetAsync(BaseUrl + "/health", token);
            if (!response.IsSuccessStatusCode)
                return false;

            using var document = JsonDocument.Parse(
                await response.Content.ReadAsStringAsync(token));

            return document.RootElement.TryGetProperty("status", out var status)
                && status.GetString() == "ready";
        }
        catch (HttpRequestException)
        {
            return false;
        }
        catch (TaskCanceledException) when (!token.IsCancellationRequested)
        {
            return false;
        }
    }

    public void Stop()
    {
        CancellationTokenSource? active;
        lock (_sync)
            active = _activeSpeech;

        try
        {
            active?.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // The speech operation completed at the same time.
        }
    }

    private static async Task PlayWavAsync(string wavPath, CancellationToken token)
    {
        string script =
            "$ErrorActionPreference = 'Stop'; " +
            "$p = New-Object System.Media.SoundPlayer('" +
            wavPath.Replace("'", "''") +
            "'); try { $p.Load(); $p.PlaySync() } finally { $p.Dispose() }";

        string encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
                ArgumentList = { "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded }
            }
        };

        try
        {
            if (!process.Start())
                throw new InvalidOperationException("WAV playback could not start.");

            Task<string> stderrTask = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync(token);
            string stderr = await stderrTask;

            if (process.ExitCode != 0)
                throw new InvalidOperationException("WAV playback failed: " + stderr);
        }
        catch (OperationCanceledException)
        {
            try
            {
                if (!process.HasExited)
                    process.Kill(entireProcessTree: true);
            }
            catch
            {
                // Best-effort termination of playback.
            }

            throw;
        }
    }

    private static List<string> SplitIntoChunks(string text, int maxCharacters)
    {
        var chunks = new List<string>();
        if (string.IsNullOrWhiteSpace(text))
            return chunks;

        // Prefer sentence boundaries. If a single sentence is too long,
        // split at clause punctuation, then at the nearest word boundary.
        string[] sentences = Regex.Split(
            text,
            @"(?<=[.!?])\s+(?=[\p{Lu}\d""'])");

        var current = new StringBuilder();

        foreach (string rawSentence in sentences)
        {
            string sentence = rawSentence.Trim();
            if (sentence.Length == 0)
                continue;

            if (sentence.Length > maxCharacters)
            {
                if (current.Length > 0)
                {
                    chunks.Add(current.ToString().Trim());
                    current.Clear();
                }

                foreach (string part in SplitLongSentence(sentence, maxCharacters))
                    chunks.Add(part);

                continue;
            }

            int extraLength = current.Length == 0 ? sentence.Length : sentence.Length + 1;
            if (current.Length > 0 && current.Length + extraLength > maxCharacters)
            {
                chunks.Add(current.ToString().Trim());
                current.Clear();
            }

            if (current.Length > 0)
                current.Append(' ');

            current.Append(sentence);
        }

        if (current.Length > 0)
            chunks.Add(current.ToString().Trim());

        return chunks;
    }

    private static IEnumerable<string> SplitLongSentence(string sentence, int maxCharacters)
    {
        string[] clauses = Regex.Split(sentence, @"(?<=[,;:])\s+");
        var current = new StringBuilder();

        foreach (string rawClause in clauses)
        {
            string clause = rawClause.Trim();
            if (clause.Length == 0)
                continue;

            if (clause.Length > maxCharacters)
            {
                if (current.Length > 0)
                {
                    yield return current.ToString().Trim();
                    current.Clear();
                }

                string remaining = clause;
                while (remaining.Length > maxCharacters)
                {
                    int splitAt = remaining.LastIndexOf(' ', maxCharacters);
                    if (splitAt < maxCharacters / 2)
                        splitAt = maxCharacters;

                    yield return remaining[..splitAt].Trim();
                    remaining = remaining[splitAt..].Trim();
                }

                if (remaining.Length > 0)
                    current.Append(remaining);

                continue;
            }

            int needed = current.Length == 0 ? clause.Length : clause.Length + 1;
            if (current.Length > 0 && current.Length + needed > maxCharacters)
            {
                yield return current.ToString().Trim();
                current.Clear();
            }

            if (current.Length > 0)
                current.Append(' ');

            current.Append(clause);
        }

        if (current.Length > 0)
            yield return current.ToString().Trim();
    }

    private static string CleanText(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
            return string.Empty;

        text = text.Trim();
        text = Regex.Replace(text, @"```[\s\S]*?```", " ");
        text = Regex.Replace(text, @"`([^`]+)`", "$1");
        text = Regex.Replace(text, @"https?://\S+", "link");
        text = Regex.Replace(text, @"\s+", " ");

        return text.Length > 1200 ? text[..1200] : text;
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
                File.Delete(path);
        }
        catch
        {
            // Temporary-file cleanup is best effort.
        }
    }

    public void Dispose()
    {
        Process? server;

        lock (_sync)
        {
            if (_disposed)
                return;

            _disposed = true;
            server = _serverProcess;
            _serverProcess = null;
        }

        Stop();

        try
        {
            if (server is { HasExited: false })
                server.Kill(entireProcessTree: true);
        }
        catch
        {
            // Best-effort server shutdown.
        }
    }
}
