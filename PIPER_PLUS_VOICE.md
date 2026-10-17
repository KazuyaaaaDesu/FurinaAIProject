# Fufuu Piper Plus voice integration

This project now includes an optional Piper Plus voice toggle in the chat header. Voice is OFF by default; enable **Voice ON** to speak new completed Ollama replies. The existing chat, speech bubble, and Ollama setup remain unchanged.

## Expected local layout

The Electron main process expects these files:

```text
D:\AI\PiperPlus\
  piper-plus\bin\piper-plus.exe
  models\tsukuyomi-chan-6lang-fp16.onnx
  models\config.json
```

If Piper Plus is installed elsewhere, set `FUFUU_PIPER_ROOT` in the environment before launching Electron; it should point to the folder containing `piper-plus\` and `models\`.

## How it works

- Electron invokes the Piper Plus CLI to generate a temporary WAV file.
- Windows PowerShell's `System.Media.SoundPlayer` plays that WAV.
- A newer utterance interrupts current synthesis/playback.
- Turning voice off stops current playback.
- Temporary WAV files are deleted after playback.

## Run

From the project folder, install dependencies if needed and run:

```powershell
npm install
npm run desktop
```

Then enable **Voice ON** in the chat header. If synthesis fails, the chat shows the returned error. This initial integration speaks after a complete reply; sentence streaming and lip-sync can be added next.
