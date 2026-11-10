# Lumi revised architecture

## Current repository layout

```text
apps/
  web/                 React/Vite app; build output is apps/web/dist/
  desktop-wpf/         WPF app, pet windows, and client adapters
  discord-bot/src/     Discord text/voice client and agent API adapter
core/agent/            Client policies, sessions, skills/tools, Ollama orchestration
services/
  agent-api/           Loopback HTTP/SSE API on 127.0.0.1:4319
  storage/             Existing storage API on 127.0.0.1:4317
  speech/
    omnivoice/         Existing synthesis server, reference audio, and voice actions
    whisper/           Existing Whisper worker
shared/
  contracts/           Versioned API and tool JSON Schemas
  config/              Models, client policies, limits, and prompt locations
  personality/         Runtime overlays for React and WPF channels
skills/                Declarative SKILL.md documents
assets/                 Existing root asset tree retained
public/                 Existing root Vite/WebView asset source retained
data/                   Canonical storage data retained at root
backups/                Existing backups retained at root
tests/                  Agent and isolated integration regressions
docs/migration/          Architecture, API, compatibility, plan, and status
scripts/                 Migration baseline and path-safety checks
```

`FurinaAIProject/` remains a separate nested Git repository. The old
`discord-bot/` and `omnivoice/` directories retain their ignored local
environments, caches, recordings, and configuration. The old WPF directory
retains its tracked `OmniVoiceService.cs_backup` and ignored build output.
Those are intentionally not treated as source copies to clean up. Root `dist/`
is preserved; Vite writes the new build to `apps/web/dist/`.

## Responsibilities and communication

- **React** sends chat, screenshot vision, ambient observations, and avatar
  emotion requests to the agent API. It continues to use storage directly for
  conversation and memory UI operations, the existing pet display code, and
  the optional speech bridge URL. This repository does not include a bridge
  server implementation.
- **WPF** sends chat, screenshot vision, and ambient requests to the agent API.
  It continues to use storage directly for conversation persistence and
  memory management, and retains its local OmniVoice process/playback service.
- **Discord** sends separate text and voice conversations to the agent API.
  Its history remains process-local and separately keyed; `!lumi reset` still
  deletes only text history. Whisper remains a fixed child worker, and Discord
  voice playback continues to use OmniVoice and the existing PCM pipeline.
- **Agent core** applies client/channel policy, selects text or vision models,
  loads the correct personality and runtime overlay, retrieves memories through
  the storage HTTP API, assembles prompts, invokes Ollama, and propagates
  cancellation.
- **Agent API** validates requests, owns HTTP/SSE lifecycle and error
  handling, exposes health/capability/skill/tool endpoints, and enforces the
  tool allowlist. It does not own conversation persistence or speech.
- **Storage** retains the existing routes, formats, root `data/` files, and
  port 4317. Tests use an isolated temporary directory rather than the
  repository data.
- **Ollama** remains the local model provider on port 11434. Model selection
  and generation settings are server-owned in `shared/config/agent.json`.
- **OmniVoice** stays on port 8765. Its server and tracked voice assets moved;
  its ignored Python environment remains at `omnivoice/.venv`.

## Startup and ports

Start storage and the agent API in separate terminals before clients:

```powershell
npm run storage
npm run agent-api
```

Then start `npm run dev`, `npm run desktop`, or `npm run discord` as needed.
Discord voice also requires `npm run omnivoice`. The Discord Whisper worker
starts lazily using the preserved `discord-bot/.venv`. Client launchers do not
silently start duplicate service instances.

| Service | Bind | Compatibility |
|---|---|---|
| Storage | `127.0.0.1:4317` | Existing API and root data paths |
| Agent API | `127.0.0.1:4319` | `/api/v1`, versioned JSON and SSE |
| OmniVoice | `127.0.0.1:8765` | Existing `/health` and `/synthesize` formats |
| Ollama | `127.0.0.1:11434` | Existing local model service |

## Client policies

- React: 7 prior messages plus the current message; server-side relevant-memory
  selection; storage-backed conversation; React personality source.
- WPF: 29 prior messages plus the current message; all saved memories; existing
  storage conflict checks and temporary-chat reset semantics; WPF personality.
- Discord: up to 20 in-process history messages plus the current message; no
  shared memory or transcript persistence; distinct text/voice keys and WPF
  personality.

The React and WPF/Discord personality sources remain distinct. Runtime/channel
overlays are supplemental and do not replace either personality file.
`LumiPersonality.ts` remains avatar behavior, not an AI prompt.

## Skills and tools

Skills are Markdown instructions with constrained metadata and cannot execute
code or grant permissions. The server validates required tool IDs and enforces
per-client access independently. The current tool registry is explicit and
read-only; it contains no shell, process, terminal, arbitrary filesystem,
filesystem-write, or generic URL execution tool.

## Asset and data boundaries

- Root `public/` is served/copied by Vite and is not relocated or duplicated.
- Existing pet PNG, Live2D, VRM, motion, and WPF WebView behavior are preserved.
- Root `assets/`, root `dist/`, models, recordings, backups, `.env`, and local
  Python environments are retained.
- Root `data/` remains canonical. Conversation and memory file contents were
  not read during migration; storage tests use temporary paths.
- `FurinaAIProject/` remains at the root and was not traversed or changed as
  part of application relocation.

## Security boundaries

- Agent API binds to loopback and uses explicit allowed browser origins.
- Request bodies, image sizes, client/session IDs, and tool arguments are
  bounded and validated.
- Skills cannot escalate permission; authorization derives from server policy.
- No arbitrary command execution is available to the agent runtime.
- The Discord token remains in the existing ignored environment file.
- Requests and logs do not intentionally include prompts, images, or secrets.
