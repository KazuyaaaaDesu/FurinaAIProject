# Lumi migration status

## Completed

- Captured and rechecked baseline Git state and required ports with
  `scripts/check-migration-baseline.ps1`. Ports 4317, 4319, and 8765 were
  available at the checks performed.
- Migrated tracked storage, web, WPF, Discord, Whisper, and OmniVoice source to
  the target service/app locations. See `IMPLEMENTATION_PLAN.md` for the
  old-path to new-path map and integration details.
- Implemented the shared agent core, separate client policies, versioned
  loopback API, client adapters, declarative skills, and read-only registered
  tools.
- Updated workspace scripts and build configuration. Root `public/` remains
  the Vite public directory; the web build is isolated in `apps/web/dist/`.
- Updated architecture, API, skills/security, client-compatibility,
  implementation-plan, and root README documentation.
- No cleanup or source/asset deletion was performed.

## Preservation guarantees and boundaries

- `data/conversations.json` was already modified in the working tree. Its
  contents were never read, and it was not staged or changed.
- `data/memory.json` contents were not read or changed.
- `backups/`, root `public/`, root `dist/`, credentials, recordings, model
  files, and the nested `FurinaAIProject/` repository were left in place.
- The two personality sources remain separate:
  `apps/web/src/Personality.md` and
  `apps/desktop-wpf/Assets/Personality.md`.
- The tracked WPF `OmniVoiceService.cs_backup` and ignored build/environment
  directories in legacy locations were retained.
- Storage remains on 4317 with root `data/` as canonical storage; OmniVoice
  remains on 8765; the agent API uses loopback port 4319.

## Validation completed

| Check | Result |
|---|---|
| `node --test` | 26 passed, 0 failed |
| `npm run build --workspace @lumi/web` | Passed; output isolated to `apps/web/dist/` |
| `dotnet build apps\desktop-wpf\Fufuu.Wpf.csproj` | Passed; no warnings or errors |
| `node --check` for agent API, core, and Discord JavaScript | Passed |
| `scripts/check-migration-baseline.ps1` | Passed; ports available and protected data contents not read |

The web build reports an existing large pet-stage JavaScript chunk. No
conversation or memory content was used in tests; the storage integration test
uses a temporary directory.

`npm run lint` is not clean: it reports 10 findings in the relocated,
pre-existing React viewer files (`Live2DViewer.tsx`, `PetStageHost.tsx`,
`SpriteViewer.tsx`, and `VRMViewer.tsx`). These files were relocated unchanged;
the findings were not altered as unrelated behavior/refactor work. The root
lint config now excludes local `.venv` trees so it does not lint vendored
Python package templates.

## Not verified with live services

- Ollama text or vision generation.
- Discord login and end-to-end voice interaction.
- Whisper transcription using the local model/environment.
- CUDA OmniVoice synthesis and playback.
- WPF UI, WebView interaction, pet animations/display modes, or real desktop
  microphone/speaker behavior.
- End-to-end service startup and shutdown as one managed process.

Mocks and compile/build checks are not claimed as substitutes for these live
checks. Local services are started separately; storage and agent API must be
available before clients, and OmniVoice is additionally required for Discord
voice.

## Remaining risks and decisions

- Confirm a local integration window and test accounts/devices for the
  unverified model, Discord, speech, and GUI flows.
- Decide whether to add a supervisor/launcher for the separately started
  services; current client launchers do not start dependent services.
- Discord's prior environment-selected model is superseded by server-owned
  model selection in `shared/config/agent.json`. The ignored `.env` was not
  read or changed.
- The React app retains its optional speech bridge URL on port 4318; this
  repository does not implement a bridge server.
- Keep API exposure loopback-only unless an authentication design is approved.
