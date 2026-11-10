# Lumi migration map and implementation status

## Path migration map

| Existing tracked path | Current destination/action | Dependency handling and preserved behavior |
|---|---|---|
| `src/**` | `apps/web/src/**` | Relative imports preserved. `Personality.md` remains the React AI personality; `LumiPersonality.ts` remains avatar behavior. |
| `index.html`, `PetStage.html`, `vite.config.ts` | `apps/web/` | Vite uses root `public/`, repository-root environment files, and outputs to `apps/web/dist/`. Pet-stage entry and URLs remain unchanged. |
| `tsconfig.app.json`, `tsconfig.node.json` | `apps/web/` | Root `tsconfig.json` remains the build-reference aggregator and references both new paths. |
| Tracked WPF project/source/assets in `Fufuu.Wpf/` | `apps/desktop-wpf/` | WPF namespaces and relative XAML/resource paths preserved. The project includes `apps/web/dist/` for WebView packaging. OmniVoice paths now resolve from the repository root. |
| `Fufuu.Wpf/Services/OmniVoiceService.cs_backup` | Retained at old path | Tracked backup intentionally left in place and unchanged. Ignored `bin/obj` output also remains. |
| `discord-bot/bot.js`, `discord-bot/voice.js` | `apps/discord-bot/src/` | Discord imports remain local. The bot loads the existing ignored `discord-bot/.env` before dynamically importing voice/API modules, preserving environment configuration. |
| `discord-bot/whisper_worker.py` | `services/speech/whisper/whisper_worker.py` | Discord voice resolves the new tracked worker path and continues to use the existing ignored `discord-bot/.venv`. |
| `server/server.js` | `services/storage/server.js` | Repository-root calculation preserves canonical `data/`; defaults remain port 4317. Test-only environment overrides isolate storage tests. |
| `omnivoice/omnivoice_server.py`, `lumi-reference.wav`, tracked `voice-actions/**` | `services/speech/omnivoice/` | Reference audio is resolved relative to the script. WPF uses the migrated server/actions and retained `omnivoice/.venv`; Discord still uses port 8765. |
| Root `public/**`, `assets/**`, `data/**`, `backups/**` | Retained at root | No relocation or replacement. The conversation/memory file contents were not read. |
| Root `dist/**` | Retained at root | No build writes here; the new Vite output and WPF WebView input are `apps/web/dist/`. |
| `voice-tests/**` and untracked/ignored recordings | Retained | Not relocated or deleted; no dependency evidence justified a move. |
| `FurinaAIProject/` | Retained as nested repository | Separate Git boundary; not moved or modified. |
| Root ignored Python environments, caches, Discord `.env`, `node_modules`, and build output | Retained | Never treated as source or swept into tracked directory moves. |

## Dependency-ordered stages

| Stage | Files created or changed | Integration and verification |
|---|---|---|
| 1. Baseline protection | Updated `scripts/check-migration-baseline.ps1` | Checks Git status without reading protected contents and fails if port 4319 is occupied. Verified after moves; ports 4317, 4319, and 8765 were available. |
| 2. Startup and package boundaries | Root `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`, `README.md`; new `apps/web/package.json`, `apps/discord-bot/package.json`, `services/agent-api/package.json`, `services/storage/package.json` | npm workspaces preserve existing dependency versions; Vite and WPF build paths are relocated. Removed the unused Electron dependency/script after confirming no Electron runtime source exists; `desktop` now runs WPF. |
| 3. Shared contracts and agent core | `shared/contracts/agent-api.schema.json`, `shared/contracts/tool.schema.json`, `shared/config/agent.json`, `shared/personality/**`; `core/agent/{agent,policies,session-manager,skill-registry,tool-registry}.js` | Server owns prompt assembly, client policies, model selection, memory retrieval, skill loading, and tool authorization. Client limits/personality sources remain distinct. |
| 4. Agent API | `services/agent-api/server.js`; `docs/migration/AGENT_API.md`; `tests/agent/api.test.js` | `/api/v1` JSON/SSE chat, image forwarding, cancellation, emotion classification, skills/tools, health/capabilities, and structured errors run on loopback 4319. API tests mock Ollama/storage; live model integration remains unverified. |
| 5. Skills and tools | `skills/general-assistant/SKILL.md`, `skills/vision-analysis/SKILL.md`; registry and security tests | Declarative instructions only; registered read-only handlers; unknown tool IDs and client permission escalation are rejected. No shell, terminal, process, arbitrary filesystem, or filesystem-write tool is exposed. |
| 6. Storage service | `services/storage/server.js`; `tests/integration/storage.test.js` | Migrated with `git mv`. Existing routes/formats and port 4317 remain; default data path is root `data/`. The integration test points to a temporary directory. |
| 7. Web application | Relocated `apps/web/src/**`, `apps/web/{index.html,PetStage.html,vite.config.ts,tsconfig.app.json,tsconfig.node.json}`; new `apps/web/src/agent-api.ts` | Chat/SSE, vision, ambient, and emotion use the agent API. Storage-backed conversation/memory UI, speech bridge behavior, pet views, and root `public/` URLs remain. Production build passes. |
| 8. WPF application | Relocated tracked WPF source/assets to `apps/desktop-wpf/`; new `Services/AgentApiClient.cs`; updated `Fufuu.Wpf.csproj` | Chat/SSE, vision, and ambient requests use the agent API. Storage writes/conflict checks, memory manager, screenshots, WebView messages, pet modes, and local speech remain. Final WPF build passes with no warnings or errors. |
| 9. Discord and Whisper | Relocated `bot.js`, `voice.js` to `apps/discord-bot/src/`; new `agent-api.js`; relocated Whisper worker; new `tests/integration/discord-agent.test.js` | Text and voice use distinct session/history keys and API channels. `!lumi reset` still deletes text history only. Bot voice, wake-word, Whisper, and OmniVoice internals remain in their existing implementation. Syntax and adapter tests pass. |
| 10. OmniVoice compatibility | Relocated tracked OmniVoice server, reference audio, and voice actions; updated WPF service and server reference path | Existing health/synthesis routes, WAV format, port 8765, voice action behavior, and local Python environment path are retained. Live CUDA synthesis was not run. |
| 11. Assets, docs, scripts, tests | Updated migration docs and root README; workspace manifests and baseline guard | Root `public/`, assets, data, backups, recordings, nested repository, ignored environments, and old root `dist/` remain. No cleanup/deletions were performed. |

## Files created for the architecture and adapters

- `apps/web/package.json`
- `apps/web/src/agent-api.ts`
- `apps/discord-bot/package.json`
- `apps/discord-bot/src/agent-api.js`
- `apps/desktop-wpf/Services/AgentApiClient.cs`
- `services/agent-api/package.json`
- `services/storage/package.json`
- `tests/integration/discord-agent.test.js`
- `tests/integration/storage.test.js`
- `tests/agent/**`
- `core/agent/**`
- `shared/**`
- `skills/**`
- `docs/migration/**`
- `scripts/check-migration-baseline.ps1`

## Tests and unresolved runtime verification

Verified:

```text
node --test                                      26 passed, 0 failed
npm run build --workspace @lumi/web             passed
dotnet build apps/desktop-wpf/Fufuu.Wpf.csproj  passed (0 warnings, 0 errors)
node --check on agent and Discord JavaScript     passed
scripts/check-migration-baseline.ps1             passed
```

The web build reports the existing large pet-stage JavaScript chunk. The lint
command still reports 10 errors in pre-existing React viewer files that were
relocated unchanged; local Python virtual environments are excluded from lint.
Live Ollama generation, Discord login, Whisper transcription, CUDA OmniVoice
synthesis, WPF UI interaction, and real WebView/pet behavior were not run.

No source or asset files were deleted. No `data/` or `backups/` contents were
read. The pre-existing `data/conversations.json` working-tree modification
remains present; `data/memory.json`, backups, root `public/`, and root `dist/`
were not modified.

## Remaining decisions and risks

- Keep all local services explicitly started in separate terminals; no
  launcher currently starts or supervises the full service set.
- The legacy Discord `.env` may contain `OLLAMA_MODEL`; model selection is now
  server-owned in `shared/config/agent.json`, and the bot does not use that
  override. The `.env` itself was not read or modified.
- Browser speech bridge port 4318 has no in-repository server implementation;
  that existing optional path is not replaced by this migration.
- Runtime parity still requires local model, speech, Discord, and GUI tests.
- No cleanup was attempted for root directories that may contain ignored
  environments, generated output, or tracked backup files.
