# Client compatibility matrix

| Behavior | React | WPF | Discord |
|---|---|---|---|
| Current source | `apps/web/src/` | `apps/desktop-wpf/` | `apps/discord-bot/src/` |
| Agent API channels | `chat`, `vision`, `ambient`, `emotion` | `chat`, `vision`, `ambient` | `chat`, `voice` |
| Text model | `llama3.1:latest` | `llama3.1:latest` | `llama3.1:latest` |
| Vision model | `qwen2.5vl:3b` | `qwen2.5vl:3b` | Not used |
| Prior-message context | 7 prior messages + current | 29 prior messages + current | Up to 20 in-process prior messages + current |
| Memory policy | Relevant notes, up to 8; falls back to 5 ranked/recent notes | All stored memories (up to 200) | No shared memory |
| AI personality | `apps/web/src/Personality.md` | `apps/desktop-wpf/Assets/Personality.md` | Same WPF personality source |
| Avatar behavior | `apps/web/src/LumiPersonality.ts`; not an AI prompt | Pet/WebView behavior in WPF and web assets | N/A |
| Conversation persistence | `sakura-main` via storage API 4317 | `sakura-main` via storage API 4317; temporary New Chat is not saved | Process memory, keyed separately by guild/user and text/voice |
| Reset behavior | Existing storage-backed conversation controls | Existing saved-history protections and temporary New Chat | `!lumi reset` clears text history only; voice history remains |
| Images | Request-only JPEG; not saved in conversation history | Request-only JPEG; not saved in conversation history | Not used |
| Speech output | Existing desktop bridge if present; optional browser bridge URL at 4318 is not implemented in this repository | Existing OmniVoice service on 8765 and local WAV playback | Existing OmniVoice 8765, PCM conversion, and Discord player |
| Speech input | Not implemented | Not implemented | Existing Whisper worker, wake aliases, and follow-up window |

## Agent API adapters

- React's `apps/web/src/agent-api.ts` uses `/api/v1/chat/stream` for chat and
  `/api/v1/chat` for ambient observations. Screenshot images are forwarded in
  the current request only. Emotion classification uses `/api/v1/emotion`;
  the server owns the fixed prompt, model, and label set.
- WPF's `apps/desktop-wpf/Services/AgentApiClient.cs` consumes SSE for normal
  chat and JSON for ambient observations. Its client-side storage writes,
  history conflict checks, screenshot capture, pet messaging, and speech
  playback remain separate.
- Discord's `apps/discord-bot/src/agent-api.js` makes non-streaming requests.
  The bot retains its in-process map, existing channel/guild/user keys, and
  text-only reset behavior. Voice requests use the `voice` channel and text
  requests use the `chat` channel.

The API does not store transcripts. Clients continue to own their respective
history lifecycle and persistence. Server-side client policies independently
enforce context and memory behavior; callers cannot select a model or raise
their limits.

## Personality and prompt preservation

- React's AI personality remains `apps/web/src/Personality.md`, supplemented
  by the server-owned React runtime, vision, and ambient overlays.
- WPF and Discord continue to use only
  `apps/desktop-wpf/Assets/Personality.md`, with separate WPF vision/ambient
  overlays.
- The two personality files were not merged. `LumiPersonality.ts` remains
  avatar behavior and is not loaded as a model prompt.
- The matching runtime/vision/ambient prompt text was compared with the
  previously inline React and WPF instructions before switching those
  requests to server prompt assembly.

## Voice, assets, and storage safeguards

- Root `public/` is still Vite's public source and remains the source of the
  WPF WebView model/motion/vendor assets. Vite now emits to `apps/web/dist/`;
  the old root `dist/` output remains untouched.
- The WPF chat client still uses the existing storage API and write-conflict
  checks; its local speech service continues to target OmniVoice port 8765.
- Discord voice still performs recording, Whisper transcription, wake-word
  handling, text/voice history selection, synthesis, PCM conversion, and
  Discord playback. Only text-generation transport changed.
- `discord-bot/.env`, `discord-bot/.venv`, `omnivoice/.venv`, generated caches,
  recordings, root assets, and backups are intentionally retained in place.

## Verification limits

The React production build, WPF build, agent/storage regression suite, Discord
adapter test, and JavaScript syntax checks pass. No live Ollama, Discord login,
Whisper transcription, CUDA OmniVoice synthesis, WPF UI, or real pet interaction
was run in this environment; runtime parity for those integrations remains to
be verified with the local services and user interface available.
