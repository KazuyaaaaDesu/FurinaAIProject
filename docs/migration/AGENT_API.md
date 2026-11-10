# Lumi Agent API v1

## Transport and common rules

- Base URL: `http://127.0.0.1:4319/api/v1`
- JSON UTF-8 request and response bodies.
- Version is in the URL (`v1`) and each response envelope carries
  `"apiVersion": "1.0"`.
- API server binds to loopback only. Browser CORS is restricted to the
  explicit local origins in `shared/config/agent.json`; arbitrary origins are
  rejected. Native clients without an `Origin` header can call loopback.
- Maximum request body: 2 MiB. Maximum individual image: 1 MiB decoded.
- Request IDs are UUIDs. Session and conversation IDs are opaque bounded
  strings; clients must not use them to select models or permissions.
- Errors use `{ "apiVersion":"1.0", "error": { "code", "message", "details?" } }`.
  `details` contains safe validation information, never secrets or prompts.
- Requests have a configurable deadline (default 120 seconds). Client
  disconnect and explicit cancellation abort the upstream Ollama request.
- The JSON Schema Draft 2020-12 contracts for chat, health, capabilities,
  emotion classification, skill, tool, cancellation, error, and SSE payloads
  are in `shared/contracts/agent-api.schema.json`. Runtime request
  validation rejects unknown fields and response envelopes are checked before
  being sent.

## Endpoints

### Health and capabilities

`GET /health`

```json
{
  "apiVersion": "1.0",
  "status": "ok",
  "service": "lumi-agent-api",
  "capabilities": {
    "chat": true,
    "streaming": true,
    "vision": true,
    "emotion": true,
    "cancellation": true,
    "skills": true,
    "registeredTools": true
  }
}
```

`GET /api/v1/capabilities` returns configured client IDs, supported channels,
streaming/vision/emotion support, body limits and the API version. It does not disclose
secrets or unrestricted local paths.

### Avatar emotion classification

`POST /api/v1/emotion` accepts a bounded assistant reply for the React avatar's
existing emotion classification. The server owns the fixed classification
prompt, model selection, JSON output format, and allowed emotion labels; callers
cannot submit prompts or select models. This endpoint does not persist text.

Request: `{ "requestId": "<uuid>", "clientId": "react", "sessionId": "<opaque-id>", "text": "<assistant reply>" }`

Response: `{ "apiVersion": "1.0", "requestId": "<uuid>", "clientId": "react", "sessionId": "<opaque-id>", "emotion": "neutral" }`

Only the React client is authorized for this endpoint. Valid emotion labels
are `neutral`, `happy`, `pout`, `shy`, `smug`, `surprised`, and `sparkle`.

### Chat request

`POST /api/v1/chat` returns one complete JSON response.
`POST /api/v1/chat/stream` returns server-sent events.

Request:

```json
{
  "requestId": "4b9d1804-62aa-4ca5-a070-9e7d47977bc6",
  "clientId": "react",
  "channel": "chat",
  "conversationId": "sakura-main",
  "sessionId": "browser-session-id",
  "history": [
    { "role": "user", "content": "Prior user message" },
    { "role": "assistant", "content": "Prior assistant reply" }
  ],
  "message": {
    "text": "What is in this screenshot?",
    "images": [
      { "mimeType": "image/jpeg", "data": "base64-encoded-image" }
    ]
  },
  "activeSkillIds": ["vision-analysis"]
}
```

- Allowed clients: `react`, `wpf`, `discord`.
- Allowed channels: `chat`, `voice`, `ambient`, `vision`.
- `history` is prior user/assistant messages only; system messages and images
  in history are rejected. Policy limits it per client.
- Images are current-request inputs and are forwarded to Ollama as base64
  image data. Image presence selects that client's configured vision model.
- `activeSkillIds` references previously activated skills. The server loads
  instructions from its own skill registry; clients cannot submit instructions.
- The server loads personality, selects the model, retrieves memory, and builds
  system context. Clients cannot override those decisions.
- Agent chat does not persist messages; client adapters retain existing storage
  behavior.

Complete response:

```json
{
  "apiVersion": "1.0",
  "requestId": "4b9d1804-62aa-4ca5-a070-9e7d47977bc6",
  "conversationId": "sakura-main",
  "sessionId": "browser-session-id",
  "clientId": "react",
  "status": "completed",
  "message": { "role": "assistant", "content": "A concise answer." },
  "model": "llama3.1:latest",
  "finishReason": "stop"
}
```

### SSE stream

Response headers: `Content-Type: text/event-stream`,
`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.
Each event is UTF-8, ends with a blank line, and has a JSON `data:` field.

```text
event: meta
data: {"apiVersion":"1.0","requestId":"...","conversationId":"...","sessionId":"...","clientId":"react","model":"llama3.1:latest"}

event: delta
data: {"requestId":"...","text":"A concise"}

event: delta
data: {"requestId":"...","text":" answer."}

event: done
data: {"apiVersion":"1.0","requestId":"...","status":"completed","finishReason":"stop"}

```

On failure after stream start:

```text
event: error
data: {"apiVersion":"1.0","requestId":"...","error":{"code":"OLLAMA_UNAVAILABLE","message":"The local model service is unavailable."}}

```

On cancellation:

```text
event: cancelled
data: {"apiVersion":"1.0","requestId":"...","status":"cancelled"}

```

An event stream ends after exactly one terminal event (`done`, `error`, or
`cancelled`). No user prompt, memory contents, image data, or model internals
are emitted as event metadata.

### Cancellation

`POST /api/v1/requests/{requestId}/cancel`

```json
{
  "clientId": "react",
  "sessionId": "browser-session-id"
}
```

The server aborts only a request with that ID owned by the same client/session.
Response:

```json
{
  "apiVersion": "1.0",
  "requestId": "4b9d1804-62aa-4ca5-a070-9e7d47977bc6",
  "status": "cancellation_requested"
}
```

Unknown IDs return a structured `REQUEST_NOT_FOUND`; mismatched ownership
returns `REQUEST_FORBIDDEN`. A client disconnect also cancels the upstream call.

### Skill discovery and activation

- `GET /api/v1/skills?clientId=react` returns skill ID, name, description,
  required tool IDs, and whether the skill is allowed for that client. It
  omits executable content.
- `POST /api/v1/skills/{skillId}/activate` takes
  `{ "clientId":"react", "sessionId":"...", "enabled":true }`.
- Unknown/disabled skills return `SKILL_NOT_FOUND` or `SKILL_FORBIDDEN`.
- Activation is scoped to the client/session and in-memory for this initial
  service. Restart clears activation.
- Skill instructions are loaded only from server-owned `SKILL.md` files.
  `requiredToolIds` is descriptive metadata; it never grants tool access.

### Tool discovery and invocation

- `GET /api/v1/tools` returns tool ID, description, JSON input schema,
  `readOnly`, allowed clients, timeout, and `confirmationRequired`.
- `POST /api/v1/tools/{toolId}/invoke` request:

```json
{
  "requestId": "60dfdaef-e800-437b-b586-a6d17b337e91",
  "clientId": "wpf",
  "sessionId": "desktop-session",
  "arguments": {},
  "authorization": { "confirmed": true }
}
```

- Server registry and policy decide whether the client can invoke the tool.
- A tool requiring confirmation rejects missing/false confirmation.
- Tool errors are structured as `TOOL_NOT_FOUND`, `TOOL_FORBIDDEN`,
  `TOOL_CONFIRMATION_REQUIRED`, `TOOL_ARGUMENTS_INVALID`,
  `TOOL_TIMEOUT`, or `TOOL_FAILED`.
- No tool can write files, run a process, invoke a shell, or evaluate code.

## Status codes

`200` success; `400` malformed/schema-invalid input; `401` reserved for future
authentication; `403` forbidden client/session/tool; `404` unknown route/resource;
`409` duplicate active request ID; `413` body/image too large; `415` unsupported
content type; `422` invalid state (such as a skill unavailable to a client);
`429` configured concurrency limit reached; `500` unexpected internal error;
`502` upstream Ollama/storage failure; `504` upstream deadline exceeded.

## Compatibility

Storage API calls continue to use port 4317 and existing endpoints. OmniVoice
continues to use port 8765 and the existing request/response shapes. The agent
does not proxy, rename, or own either service. Migrated clients use the agent
API for model generation while retaining their existing direct storage and
speech integrations.
