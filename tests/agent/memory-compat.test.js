import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LumiAgent } from "../../core/agent/agent.js";
import { AgentError, validateChatRequest } from "../../core/agent/policies.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(await readFile(path.join(ROOT, "shared/config/agent.json"), "utf8"));
const skills = { activeFor: () => [] };

function request(clientId) {
  return validateChatRequest({
    requestId: "4b9d1804-62aa-4ca5-a070-9e7d47977bc6",
    clientId,
    channel: "chat",
    sessionId: `${clientId}-memory-test`,
    history: [],
    message: { text: "Hello." },
  }, config);
}

function ollamaResponse() {
  return new Response(`${JSON.stringify({
    message: { content: "A local reply." },
    done: true,
    done_reason: "stop",
  })}\n`, { status: 200 });
}

test("WPF memory service failure keeps chat available and reports a warning", async () => {
  const calls = [];
  const agent = new LumiAgent({
    config,
    projectRoot: ROOT,
    skills,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === `${config.storageUrl}/api/memories`) return new Response("unavailable", { status: 503 });
      if (url === `${config.ollamaUrl}/api/chat`) return ollamaResponse();
      throw new Error(`Unexpected outbound URL: ${url}`);
    },
  });

  const result = await agent.chat(request("wpf"));
  assert.equal(result.message.content, "A local reply.");
  assert.deepEqual(result.warnings, ["MEMORY_UNAVAILABLE"]);
  assert.deepEqual(calls, [
    `${config.storageUrl}/api/memories`,
    `${config.ollamaUrl}/api/chat`,
  ]);
});

test("React memory service failure remains explicit and blocks model invocation", async () => {
  let ollamaCalled = false;
  const agent = new LumiAgent({
    config,
    projectRoot: ROOT,
    skills,
    fetchImpl: async (url) => {
      if (url === `${config.storageUrl}/api/memories`) return new Response("unavailable", { status: 503 });
      if (url === `${config.ollamaUrl}/api/chat`) {
        ollamaCalled = true;
        return ollamaResponse();
      }
      throw new Error(`Unexpected outbound URL: ${url}`);
    },
  });

  await assert.rejects(
    agent.chat(request("react")),
    (error) => error instanceof AgentError && error.code === "MEMORY_UNAVAILABLE",
  );
  assert.equal(ollamaCalled, false);
});

test("Discord chat does not call the shared memory service", async () => {
  const calls = [];
  const agent = new LumiAgent({
    config,
    projectRoot: ROOT,
    skills,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === `${config.ollamaUrl}/api/chat`) return ollamaResponse();
      throw new Error(`Unexpected outbound URL: ${url}`);
    },
  });

  const result = await agent.chat(request("discord"));
  assert.equal(result.message.content, "A local reply.");
  assert.deepEqual(calls, [`${config.ollamaUrl}/api/chat`]);
});
