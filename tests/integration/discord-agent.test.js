import test from "node:test";
import assert from "node:assert/strict";
import { chatAgent } from "../../apps/discord-bot/src/agent-api.js";

test("Discord chat adapter keeps text and voice sessions distinct", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      apiVersion: "1.0",
      requestId: requests.at(-1).body.requestId,
      sessionId: requests.at(-1).body.sessionId,
      clientId: "discord",
      status: "completed",
      message: { role: "assistant", content: "A local reply." },
      model: "llama3.1:latest",
      finishReason: "stop",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const history = [{ role: "user", content: "Keep this in voice history." }];
  const voiceAnswer = await chatAgent({
    channel: "voice",
    conversationId: "voice:guild:user",
    sessionId: "voice:guild:user",
    history,
    text: "Hello from voice.",
    fetchImpl,
  });
  const textAnswer = await chatAgent({
    channel: "chat",
    conversationId: "text:guild:user",
    sessionId: "text:guild:user",
    history: [],
    text: "Hello from text.",
    fetchImpl,
  });

  assert.equal(voiceAnswer, "A local reply.");
  assert.equal(textAnswer, "A local reply.");
  assert.equal(requests[0].url, "http://127.0.0.1:4319/api/v1/chat");
  assert.equal(requests[0].body.clientId, "discord");
  assert.equal(requests[0].body.channel, "voice");
  assert.equal(requests[0].body.sessionId, "voice:guild:user");
  assert.deepEqual(requests[0].body.history, history);
  assert.equal(requests[1].body.channel, "chat");
  assert.equal(requests[1].body.sessionId, "text:guild:user");
  assert.equal(requests[1].body.history.length, 0);
  assert.match(requests[0].body.requestId, /^[0-9a-f-]{36}$/i);
});
