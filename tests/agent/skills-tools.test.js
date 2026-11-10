import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSkillRegistry,
  loadSkillRegistry,
  parseSkillDocument,
} from "../../core/agent/skill-registry.js";
import { createToolRegistry } from "../../core/agent/tool-registry.js";
import { AgentError } from "../../core/agent/policies.js";
import { SessionManager } from "../../core/agent/session-manager.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(await readFile(path.join(ROOT, "shared/config/agent.json"), "utf8"));

test("registered skills are declarative and parse their metadata", async () => {
  const toolRegistry = createToolRegistry(config, fetch);
  const skills = await loadSkillRegistry(ROOT, {
    registeredToolIds: toolRegistry.registeredIds(),
  });
  const discovered = skills.listFor("react", config.clientPolicies.react.allowedSkillIds);
  assert.deepEqual(discovered.map((skill) => skill.id), ["general-assistant", "vision-analysis"]);
  const parsed = parseSkillDocument([
    "---",
    "id: local-example",
    "name: Example",
    "description: Declarative example.",
    "requiredToolIds: []",
    "---",
    "Instructions are data only.",
  ].join("\n"));
  assert.equal(parsed.instructions, "Instructions are data only.");
  assert.throws(() => parseSkillDocument("console.log('not a skill')"));
});

test("skill metadata cannot grant a tool permission", async () => {
  const skill = parseSkillDocument([
    "---",
    "id: requests-model-list",
    "name: Request model list",
    "description: Describes a tool requirement.",
    "requiredToolIds: [ollama.list_models]",
    "---",
    "This skill requests a read-only model listing.",
  ].join("\n"));
  const registry = createSkillRegistry(new Map([[skill.id, skill]]), {
    sessionManager: new SessionManager(),
    registeredToolIds: ["ollama.list_models"],
  });
  registry.activate("react", "session-a", skill.id, true, [skill.id]);

  const tools = createToolRegistry(config, async () => {
    throw new Error("Denied tool must never reach the handler.");
  });
  await assert.rejects(
    tools.invoke("ollama.list_models", {
      clientId: "react",
      arguments: {},
      confirmed: true,
      allowedIds: [],
    }),
    (error) => error instanceof AgentError && error.code === "TOOL_FORBIDDEN",
  );
});

test("skill registry rejects references to unregistered tool IDs", () => {
  const skill = parseSkillDocument([
    "---",
    "id: requests-missing-tool",
    "name: Missing tool",
    "description: This should not register.",
    "requiredToolIds: [shell.execute]",
    "---",
    "Instructions are data only.",
  ].join("\n"));
  assert.throws(
    () => createSkillRegistry(new Map([[skill.id, skill]]), {
      registeredToolIds: ["agent.get_status"],
    }),
    /unregistered tool/,
  );
});

test("skill activation is isolated between client sessions", () => {
  const skill = parseSkillDocument([
    "---",
    "id: session-isolation",
    "name: Session isolation",
    "description: Validates activation scope.",
    "requiredToolIds: []",
    "---",
    "Session-specific instruction.",
  ].join("\n"));
  const registry = createSkillRegistry(new Map([[skill.id, skill]]));
  registry.activate("react", "session-a", skill.id, true, [skill.id]);
  assert.equal(registry.activeFor("react", "session-a", undefined, [skill.id]).length, 1);
  assert.equal(registry.activeFor("react", "session-b", undefined, [skill.id]).length, 0);
  registry.sessionManager.close("react", "session-a");
  assert.equal(registry.activeFor("react", "session-a", undefined, [skill.id]).length, 0);
});

test("read-only tools require confirmation and strict arguments", async () => {
  let fetchCount = 0;
  const tools = createToolRegistry(config, async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ models: [{ name: "llama3.1:latest" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  await assert.rejects(
    tools.invoke("ollama.list_models", {
      clientId: "react",
      arguments: {},
      confirmed: false,
      allowedIds: config.clientPolicies.react.allowedToolIds,
    }),
    (error) => error instanceof AgentError && error.code === "TOOL_CONFIRMATION_REQUIRED",
  );
  assert.equal(fetchCount, 0);

  await assert.rejects(
    tools.invoke("ollama.list_models", {
      clientId: "react",
      arguments: { url: "http://attacker.invalid" },
      confirmed: true,
      allowedIds: config.clientPolicies.react.allowedToolIds,
    }),
    (error) => error instanceof AgentError && error.code === "REQUEST_PROPERTY_UNKNOWN",
  );
  assert.equal(fetchCount, 0);

  const result = await tools.invoke("ollama.list_models", {
    clientId: "react",
    arguments: {},
    confirmed: true,
    allowedIds: config.clientPolicies.react.allowedToolIds,
  });
  assert.deepEqual(result, { models: ["llama3.1:latest"] });
  assert.equal(fetchCount, 1);
});

test("tool discovery exposes only explicitly registered read-only handlers", () => {
  const tools = createToolRegistry(config, fetch);
  const discovered = tools.discover("react", config.clientPolicies.react.allowedToolIds);
  assert.deepEqual(discovered.map((tool) => tool.id), ["agent.get_status", "ollama.list_models"]);
  assert.ok(discovered.every((tool) => tool.readOnly === true));
  assert.ok(discovered.every((tool) => !("handler" in tool)));
  assert.ok(!discovered.some((tool) => /shell|terminal|filesystem|command/i.test(tool.id)));
});
