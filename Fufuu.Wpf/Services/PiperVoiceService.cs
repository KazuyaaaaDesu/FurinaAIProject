
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Fufuu.Wpf.Services;

public sealed class PiperVoiceService : IDisposable
{
    private const string DefaultModel =
        @"D:\AI\PiperPlus\models\tsukuyomi-chan-6lang-fp16.onnx";

    private const string DefaultConfig =
        @"D:\AI\PiperPlus\models\config.json";

    private const string DefaultEngine =
        @"D:\AI\PiperPlus\piper-plus\bin\piper-plus.exe";

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly object _sync = new();

    private CancellationTokenSource? _activeSpeech;
    private Process? _activeProcess;
    private bool _disposed;

    public async Task SpeakAsync(
        string text,
        string language = "auto",
        double rate = 0.65)
    {
        text = CleanText(text);

        if (string.IsNullOrWhiteSpace(text))
            return;

        // A new request interrupts any previous speech.
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

        try
        {
            await _gate.WaitAsync(cancellation.Token);

            try
            {
                var engine = Environment.GetEnvironmentVariable(
                    "PIPER_PLUS_EXE") ?? DefaultEngine;

                var model = Environment.GetEnvironmentVariable(
                    "PIPER_PLUS_MODEL") ?? DefaultModel;

                var config = Environment.GetEnvironmentVariable(
                    "PIPER_PLUS_CONFIG") ?? DefaultConfig;

                if (!File.Exists(engine))
                    throw new FileNotFoundException(
                        "Piper Plus executable was not found.", engine);

                if (!File.Exists(model))
                    throw new FileNotFoundException(
                        "Piper Plus model was not found.", model);

                if (!File.Exists(config))
                    throw new FileNotFoundException(
                        "Piper Plus config was not found.", config);

                rate = Math.Clamp(rate, 0.5, 1.3);

                var chunks = SplitIntoChunks(text, 360);

                foreach (var chunk in chunks)
                {
                    cancellation.Token.ThrowIfCancellationRequested();

                    var wavPath = Path.Combine(
                        Path.GetTempPath(),
                        $"fufuu-voice-{Guid.NewGuid():N}.wav");

                    try
                    {
                        var japanese = language == "ja";

                        var synth = new ProcessStartInfo
                        {
                            FileName = engine,
                            UseShellExecute = false,
                            CreateNoWindow = true,
                            RedirectStandardOutput = true,
                            RedirectStandardError = true
                        };

                        synth.ArgumentList.Add("--model");
                        synth.ArgumentList.Add(model);
                        synth.ArgumentList.Add("--config");
                        synth.ArgumentList.Add(config);
                        synth.ArgumentList.Add("--language");
                        synth.ArgumentList.Add(
                            language is "ja" or "en" or "zh"
                                ? language
                                : "auto");
                        synth.ArgumentList.Add("--length_scale");
                        synth.ArgumentList.Add(
                            (japanese
                                ? 1.08
                                : Math.Clamp(1.08 / rate, 0.95, 1.65))
                            .ToString(
                                System.Globalization.CultureInfo.InvariantCulture));
                        synth.ArgumentList.Add("--noise_scale");
                        synth.ArgumentList.Add(japanese ? "0.60" : "0.70");
                        synth.ArgumentList.Add("--noise_w");
                        synth.ArgumentList.Add(japanese ? "0.75" : "0.80");
                        synth.ArgumentList.Add("--text");
                        synth.ArgumentList.Add(chunk);
                        synth.ArgumentList.Add("--output_file");
                        synth.ArgumentList.Add(wavPath);

                        using (var process = new Process { StartInfo = synth })
                        {
                            SetActiveProcess(process);

                            try
                            {
                                if (!process.Start())
                                    throw new InvalidOperationException(
                                        "Piper Plus could not start.");

                                var stderrTask =
                                    process.StandardError.ReadToEndAsync();

                                await process.WaitForExitAsync(
                                    cancellation.Token);

                                var stderr = await stderrTask;

                                if (process.ExitCode != 0)
                                    throw new InvalidOperationException(
                                        "Piper Plus failed: " + stderr);
                            }
                            finally
                            {
                                ClearActiveProcess(process);
                            }
                        }

                        cancellation.Token.ThrowIfCancellationRequested();

                        if (!File.Exists(wavPath) ||
                            new FileInfo(wavPath).Length <= 44)
                        {
                            throw new InvalidOperationException(
                                "Piper Plus did not produce a valid WAV file.");
                        }

                        await PlayWavAsync(
                            wavPath, cancellation.Token);
                    }
                    finally
                    {
                        try
                        {
                            if (File.Exists(wavPath))
                                File.Delete(wavPath);
                        }
                        catch
                        {
                            // Best-effort temporary-file cleanup.
                        }
                    }
                }
            }
            finally
            {
                _gate.Release();
            }
        }
        catch (OperationCanceledException)
        {
            // Expected when voice is toggled off or replaced.
        }
        finally
        {
            lock (_sync)
            {
                if (ReferenceEquals(_activeSpeech, cancellation))
                    _activeSpeech = null;
            }

            cancellation.Dispose();
        }
    }

    public void Stop()
    {
        CancellationTokenSource? cancellation;
        Process? process;

        lock (_sync)
        {
            cancellation = _activeSpeech;
            process = _activeProcess;
            _activeProcess = null;
        }

        try
        {
            cancellation?.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // The speech request has already finished.
        }

        try
        {
            if (process is { HasExited: false })
                process.Kill(entireProcessTree: true);
        }
        catch
        {
            // The process may have exited between checks.
        }
    }

    private async Task PlayWavAsync(
        string wavPath,
        CancellationToken cancellationToken)
    {
        // Use the built-in Windows WAV player. The script is encoded as
        // UTF-16LE Base64 so paths and text cannot break PowerShell quoting.
        var script =
            "$ErrorActionPreference = 'Stop'; " +
            "$p = New-Object System.Media.SoundPlayer('" +
            wavPath.Replace("'", "''") +
            "'); try { $p.Load(); $p.PlaySync() } finally { $p.Dispose() }";

        var encoded = Convert.ToBase64String(
            Encoding.Unicode.GetBytes(script));

        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            ArgumentList =
            {
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                encoded
            }
        };

        using var process = new Process { StartInfo = startInfo };

        SetActiveProcess(process);

        try
        {
            if (!process.Start())
                throw new InvalidOperationException(
                    "Windows audio playback could not start.");

            var stderrTask = process.StandardError.ReadToEndAsync();

            await process.WaitForExitAsync(cancellationToken);

            var stderr = await stderrTask;

            if (process.ExitCode != 0)
                throw new InvalidOperationException(
                    "WAV playback failed: " + stderr);
        }
        finally
        {
            ClearActiveProcess(process);
        }
    }

    private void SetActiveProcess(Process process)
    {
        lock (_sync)
            _activeProcess = process;
    }

    private void ClearActiveProcess(Process process)
    {
        lock (_sync)
        {
            if (ReferenceEquals(_activeProcess, process))
                _activeProcess = null;
        }
    }

    private static string CleanText(string text)
    {
        text = text.Trim();

        // Avoid reading Markdown code blocks and inline code aloud.
        text = System.Text.RegularExpressions.Regex.Replace(
            text, @"```[\s\S]*?```", " ");

        text = System.Text.RegularExpressions.Regex.Replace(
            text, @"`([^`]*)`", "$1");

        text = System.Text.RegularExpressions.Regex.Replace(
            text, @"https?://\S+", "link");

        text = System.Text.RegularExpressions.Regex.Replace(
            text, @"\s+", " ");

        return text.Length > 1200 ? text[..1200] : text;
    }

    private static string[] SplitIntoChunks(string text, int maxChars)
    {
        var result = new System.Collections.Generic.List<string>();

        while (text.Length > maxChars)
        {
            var split = text.LastIndexOfAny(
                new[] { '.', '!', '?', '。', '！', '？', ' ', '、', ',' },
                maxChars);

            if (split < maxChars / 2)
                split = maxChars;

            var chunk = text[..split].Trim();

            if (chunk.Length > 0)
                result.Add(chunk);

            text = text[split..].Trim();
        }

        if (text.Length > 0)
            result.Add(text);

        return result.ToArray();
    }

    public void Dispose()
    {
        lock (_sync)
        {
            if (_disposed)
                return;

            _disposed = true;
        }

        Stop();
        _gate.Dispose();
    }
}
