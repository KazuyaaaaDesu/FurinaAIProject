# Lumi Local Companion

Lumi is a local AI companion with React/Vite, a WPF desktop client, and a
Discord bot. Text and vision requests now use the shared agent API; storage,
desktop speech, Discord voice, and the pet renderer remain separate services.

## Start services

Use separate terminals from the repository root:

```powershell
npm run storage
npm run agent-api
npm run dev
```

The web development server is Vite. Its configured static assets remain in the
root `public/` directory. A production web build is written to
`apps/web/dist/`; the root `dist/` output is retained separately.

For the WPF desktop app, start storage and the agent API, then run:

```powershell
npm run desktop
```

For Discord, start the agent API and OmniVoice, then run:

```powershell
npm run omnivoice
npm run discord
```

The existing ignored `discord-bot/.env` and `discord-bot/.venv` are still used
by the bot and its Whisper worker. The existing ignored `omnivoice/.venv` is
still used to start the relocated OmniVoice server. These local environments
and configuration files are intentionally not moved or replaced.

## Services and ports

| Service | Default address | Purpose |
|---|---|---|
| Storage API | `127.0.0.1:4317` | Existing conversation and memory API; canonical JSON data stays in root `data/` |
| Agent API | `127.0.0.1:4319` | Versioned `/api/v1` chat, vision, streaming, session, skill/tool, and emotion APIs |
| Optional browser speech bridge | `127.0.0.1:4318` | Configurable React bridge URL; this repository does not include its server |
| OmniVoice | `127.0.0.1:8765` | Existing speech synthesis API for WPF and Discord |
| Ollama | `127.0.0.1:11434` | Local text and vision model provider, called by the agent service |

Model names and per-client generation options are in
`shared/config/agent.json`. The API binds to loopback and does not expose
arbitrary command execution.

The React speech bridge URL on port 4318 is optional and external to this
repository. Desktop speech remains WPF-owned; Discord voice uses OmniVoice.

## Configuration

- Keep the Discord token in the existing ignored `discord-bot/.env`; never
  commit it.
- `VITE_AGENT_API_URL` may override the web client API base URL.
- `LUMI_AGENT_API_URL` may override the Discord client API base URL.
- `LUMI_WHISPER_PYTHON` may select a Whisper Python executable.
- `LUMI_OMNIVOICE_PYTHON` may select an OmniVoice Python executable.
- `LUMI_REPOSITORY_ROOT` may identify the repository root for WPF speech path
  discovery when the app is launched outside the source tree.

The WPF personality remains separate from the React personality. `LumiPersonality.ts`
is avatar behavior, not an AI prompt. Conversation and memory JSON remain at
their canonical root `data/` paths.

## Build and test

```powershell
npm install
npm run build
npm run lint
npm test
dotnet build .\apps\desktop-wpf\Fufuu.Wpf.csproj
```

The storage integration test uses a temporary data directory and does not
touch repository conversation or memory files.
