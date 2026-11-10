import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentServer } from "../../services/agent-api/server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(await readFile(path.join(ROOT, "shared/config/agent.json"), "utf8"));
const REQUEST_ID = "4b9d1804-62aa-4ca5-a070-9e7d47977bc6";

function encodedChunk(value) {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

function mockFetchFactory({ onOllamaRequest, ollamaResponse } = {}) {
  return async (url, options = {}) => {
    if (url === `${config.storageUrl}/api/memories`) {
      return new Response(JSON.stringify({ version: 1, memories: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === `${config.ollamaUrl}/api/tags`) {
      return new Response(JSON.stringify({ models: [{ name: "llama3.1:latest" }] }), { status: 200 });
    }
    if (url === `${config.ollamaUrl}/api/chat`) {
      const body = JSON.parse(options.body);
      onOllamaRequest?.(body, options);
      return ollamaResponse
        ? ollamaResponse(body, options)
        : new Response(encodedChunk({
          message: { content: "A local reply." },
          done: true,
          done_reason: "stop",
        }), { status: 200 });
    }
    throw new Error(`Unexpected outbound URL: ${url}`);
  };
}

async function withServer(t, fetchImpl) {
  const service = await createAgentServer({ config, projectRoot: ROOT, fetchImpl });
  const address = await service.listen(0, "127.0.0.1");
  t.after(() => service.close());
  return `http://127.0.0.1:${address.port}`;
}

function chatPayload(overrides = {}) {
  return {
    requestId: REQUEST_ID,
    clientId: "react",
    channel: "chat",
    conversationId: "sakura-main",
    sessionId: "react-test",
    history: [],
    message: { text: "Hello." },
    ...overrides,
  };
}

test("health and capability endpoints report versioned API without changing legacy ports", async (t) => {
  const base = await withServer(t, mockFetchFactory());
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.apiVersion, "1.0");
  assert.equal(health.status, "ok");
  assert.equal(health.capabilities.emotion, true);
  const capabilities = await (await fetch(`${base}/api/v1/capabilities`)).json();
  assert.deepEqual(capabilities.clients.map((client) => client.id), ["react", "wpf", "discord"]);
  assert.equal(capabilities.features.emotion, true);
});

test("emotion classification is server-prompted, bounded, and available only to React", async (t) => {
  let observed;
  const base = await withServer(t, mockFetchFactory({
    onOllamaRequest: (body) => { observed = body; },
    ollamaResponse: () => new Response(encodedChunk({
      message: { content: '{"emotion":"happy"}' },
      done: true,
      done_reason: "stop",
    }), { status: 200 }),
  }));
  const payload = {
    requestId: "60dfdaef-e800-437b-b586-a6d17b337e91",
    clientId: "react",
    sessionId: "emotion-session",
    text: "That was wonderful!",
  };
  const response = await fetch(`${base}/api/v1/emotion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    apiVersion: "1.0",
    requestId: payload.requestId,
    clientId: "react",
    sessionId: "emotion-session",
    emotion: "happy",
  });
  assert.equal(observed.model, config.clientModels.react.text);
  assert.equal(observed.format, "json");
  assert.deepEqual(observed.options, config.generationOptions.react.emotion);
  assert.equal(observed.messages[0].role, "system");
  assert.match(observed.messages[0].content, /Classify the emotion/);

  const forbidden = await fetch(`${base}/api/v1/emotion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, clientId: "discord" }),
  });
  assert.equal(forbidden.status, 403);
});

test("JSON chat selects policy model and forwards a validated vision image", async (t) => {
  let observed;
  const base = await withServer(t, mockFetchFactory({
    onOllamaRequest: (body) => { observed = body; },
  }));
  const request = chatPayload({
    channel: "vision",
    message: {
      text: "Describe this.",
      images: [{ mimeType: "image/jpeg", data: Buffer.from("image-data").toString("base64") }],
    },
  });
  const response = await fetch(`${base}/api/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.message.content, "A local reply.");
  assert.equal(result.model, config.models.vision);
  assert.equal(observed.model, config.models.vision);
  assert.deepEqual(observed.messages.at(-1).images, [request.message.images[0].data]);
});

test("SSE chat emits ordered meta, delta and terminal events", async (t) => {
  const base = await withServer(t, mockFetchFactory());
  const response = await fetch(`${base}/api/v1/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(chatPayload()),
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const text = await response.text();
  assert.match(text, /event: meta/);
  assert.match(text, /event: delta/);
  assert.match(text, /event: done/);
  assert.ok(text.indexOf("event: meta") < text.indexOf("event: delta"));
  assert.ok(text.indexOf("event: delta") < text.indexOf("event: done"));
});

test("SSE upstream failures emit one structured terminal error", async (t) => {
  const base = await withServer(t, async (url, options = {}) => {
    if (url === `${config.storageUrl}/api/memories`) {
      return new Response(JSON.stringify({ version: 1, memories: [] }), { status: 200 });
    }
    if (url === `${config.ollamaUrl}/api/chat`) {
      return new Response("unavailable", { status: 503 });
    }
    throw new Error(`Unexpected outbound URL: ${url}`);
  });
  const response = await fetch(`${base}/api/v1/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(chatPayload()),
  });
  const text = await response.text();
  assert.match(text, /event: error/);
  assert.equal((text.match(/event: (?:done|error|cancelled)/g) ?? []).length, 1);
  assert.match(text, /"code":"OLLAMA_ERROR"/);
});

test("request cancellation is scoped to the owning client and session", async (t) => {
  let resolveOllamaStarted;
  const ollamaStarted = new Promise((resolve) => { resolveOllamaStarted = resolve; });
  const base = await withServer(t, mockFetchFactory({
    ollamaResponse: (_body, options) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encodedChunk({ message: { content: "working" }, done: false }));
          resolveOllamaStarted(options.signal);
          options.signal.addEventListener("abort", () => {
            controller.error(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        },
      });
      return new Response(stream, { status: 200 });
    },
  }));
  const request = chatPayload({ sessionId: "cancel-session" });
  const response = await fetch(`${base}/api/v1/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("event: meta")) {
    const chunk = await reader.read();
    output += decoder.decode(chunk.value ?? new Uint8Array());
  }
  await ollamaStarted;

  const denied = await fetch(`${base}/api/v1/requests/${REQUEST_ID}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "wpf", sessionId: "cancel-session" }),
  });
  assert.equal(denied.status, 403);

  const cancelled = await fetch(`${base}/api/v1/requests/${REQUEST_ID}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "react", sessionId: "cancel-session" }),
  });
  assert.equal(cancelled.status, 200);
  while (!output.includes("event: cancelled")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += decoder.decode(chunk.value);
  }
  assert.match(output, /event: cancelled/);
});

test("tool API requires server policy, schema validation and explicit confirmation", async (t) => {
  const base = await withServer(t, mockFetchFactory());
  const url = `${base}/api/v1/tools/ollama.list_models/invoke`;
  const payload = {
    requestId: "60dfdaef-e800-437b-b586-a6d17b337e91",
    clientId: "react",
    sessionId: "tool-session",
    arguments: {},
  };
  const missingConfirmation = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(missingConfirmation.status, 403);
  const success = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, authorization: { confirmed: true } }),
  });
  assert.equal(success.status, 200);
  assert.deepEqual((await success.json()).result.models, ["llama3.1:latest"]);
});

test("skill activation is session-bound and skills do not confer tool rights", async (t) => {
  const base = await withServer(t, mockFetchFactory());
  const activation = await fetch(`${base}/api/v1/skills/general-assistant/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: "react",
      sessionId: "skill-session",
      enabled: true,
    }),
  });
  assert.equal(activation.status, 200);

  const chat = await fetch(`${base}/api/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(chatPayload({
      sessionId: "different-session",
      activeSkillIds: ["general-assistant"],
    })),
  });
  assert.equal(chat.status, 422);
  assert.equal((await chat.json()).error.code, "SKILL_NOT_ACTIVE");
});

test("invalid content type and malformed JSON return structured errors", async (t) => {
  const base = await withServer(t, mockFetchFactory());
  const wrongType = await fetch(`${base}/api/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).apiVersion, "1.0");

  const malformed = await fetch(`${base}/api/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "JSON_INVALID");
});
