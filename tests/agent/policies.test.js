import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentError,
  selectHistory,
  selectMemories,
  validateChatRequest,
  validateChatResponse,
} from "../../core/agent/policies.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(await readFile(path.join(ROOT, "shared/config/agent.json"), "utf8"));

test("per-client prior-message limits preserve each application's total context cap", () => {
  const history = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `message ${index}`,
  }));
  assert.equal(selectHistory(history, config.clientPolicies.react.historyLimit).length, 7);
  assert.equal(selectHistory(history, config.clientPolicies.wpf.historyLimit).length, 29);
  assert.equal(selectHistory(history, config.clientPolicies.discord.historyLimit).length, 20);
});

test("React memory retrieval ranks relevant notes and falls back to five", () => {
  const memories = Array.from({ length: 10 }, (_, index) => ({
    id: `m${index}`,
    content: `unrelated memory ${index}`,
  }));
  memories[2].content = "The user is building a local Ollama companion.";

  const relevant = selectMemories(
    memories,
    "relevant",
    [],
    "Help with the Ollama companion",
    config.clientPolicies.react,
  );
  assert.deepEqual(relevant.map((memory) => memory.id), ["m2"]);

  const fallback = selectMemories(
    memories,
    "relevant",
    [],
    "a completely different topic",
    config.clientPolicies.react,
  );
  assert.deepEqual(fallback.map((memory) => memory.id), ["m9", "m8", "m7", "m6", "m5"]);
});

test("WPF receives all configured memories and Discord receives none", () => {
  const memories = Array.from({ length: 8 }, (_, index) => ({
    id: `m${index}`,
    content: `memory ${index}`,
  }));
  assert.equal(
    selectMemories(memories, "all", [], "", config.clientPolicies.wpf).length,
    8,
  );
  assert.deepEqual(
    selectMemories(memories, "none", [], "", config.clientPolicies.discord),
    [],
  );
});

test("chat validation rejects invalid client/channel, unknown properties and malformed images", () => {
  const request = {
    requestId: "4b9d1804-62aa-4ca5-a070-9e7d47977bc6",
    clientId: "react",
    channel: "chat",
    sessionId: "browser-session",
    history: [],
    message: { text: "hello" },
  };
  assert.equal(validateChatRequest(request, config).message.text, "hello");
  assert.throws(
    () => validateChatRequest({ ...request, surprise: true }, config),
    (error) => error instanceof AgentError && error.code === "REQUEST_PROPERTY_UNKNOWN",
  );
  assert.throws(
    () => validateChatRequest({ ...request, clientId: "unknown" }, config),
    (error) => error instanceof AgentError && error.code === "CLIENT_INVALID",
  );
  assert.throws(
    () => validateChatRequest({
      ...request,
      message: { text: "image", images: [{ mimeType: "image/jpeg", data: "not-base64" }] },
    }, config),
    (error) => error instanceof AgentError && error.code === "IMAGE_INVALID",
  );
});

test("chat response contract rejects malformed server output", () => {
  const response = {
    apiVersion: "1.0",
    requestId: "4b9d1804-62aa-4ca5-a070-9e7d47977bc6",
    sessionId: "browser-session",
    clientId: "react",
    status: "completed",
    message: { role: "assistant", content: "Hello." },
    model: "llama3.1:latest",
    finishReason: "stop",
  };
  assert.equal(validateChatResponse(response), response);
  assert.throws(
    () => validateChatResponse({ ...response, message: { role: "user", content: "bad" } }),
    (error) => error instanceof AgentError && error.code === "RESPONSE_INVALID",
  );
});

test("published JSON schemas parse and declare versioned request/response shapes", async () => {
  const schema = JSON.parse(await readFile(path.join(ROOT, "shared/contracts/agent-api.schema.json"), "utf8"));
  const toolSchema = JSON.parse(await readFile(path.join(ROOT, "shared/contracts/tool.schema.json"), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.ok(schema.$defs.chatRequest);
  assert.ok(schema.$defs.chatResponse);
  assert.ok(schema.$defs.emotionRequest);
  assert.ok(schema.$defs.emotionResponse);
  assert.ok(schema.$defs.healthResponse);
  assert.ok(schema.$defs.capabilitiesResponse);
  assert.ok(schema.$defs.cancelRequest);
  assert.ok(schema.$defs.cancelResponse);
  assert.ok(schema.$defs.skillActivationRequest);
  assert.ok(schema.$defs.skillDiscoveryResponse);
  assert.ok(schema.$defs.skillActivationResponse);
  assert.ok(schema.$defs.toolDiscoveryResponse);
  assert.ok(schema.$defs.toolInvocationRequest);
  assert.ok(schema.$defs.toolInvocationResponse);
  assert.ok(schema.$defs.sseMetaEvent);
  assert.ok(schema.$defs.sseDeltaEvent);
  assert.ok(schema.$defs.sseTerminalEvent);
  assert.ok(schema.$defs.sseErrorEvent);
  assert.equal(toolSchema.properties.readOnly.const, true);
});
