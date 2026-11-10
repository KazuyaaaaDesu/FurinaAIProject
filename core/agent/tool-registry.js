import { AgentError, isRecord, rejectUnknownKeys } from "./policies.js";

const EMPTY_ARGUMENTS = Object.freeze({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
});

export function createToolRegistry(config, fetchImpl = fetch) {
  const definitions = new Map([
    ["agent.get_status", {
      id: "agent.get_status",
      description: "Return non-sensitive local agent service status.",
      inputSchema: EMPTY_ARGUMENTS,
      readOnly: true,
      allowedClients: ["react", "wpf", "discord"],
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      confirmationRequired: false,
      handler: async () => ({ status: "ready", service: "lumi-agent-api" }),
    }],
    ["ollama.list_models", {
      id: "ollama.list_models",
      description: "List model names available from the configured local Ollama service.",
      inputSchema: EMPTY_ARGUMENTS,
      readOnly: true,
      allowedClients: ["react", "wpf", "discord"],
      timeoutMs: 5000,
      maxOutputBytes: 8192,
      confirmationRequired: true,
      handler: async ({ signal }) => {
        const response = await fetchImpl(`${config.ollamaUrl}/api/tags`, { signal });
        if (!response.ok) {
          throw new AgentError(502, "TOOL_UPSTREAM_ERROR", "Configured Ollama service returned an error.");
        }
        const body = await response.json();
        if (!isRecord(body) || !Array.isArray(body.models)) {
          throw new AgentError(502, "TOOL_UPSTREAM_INVALID", "Configured Ollama service returned an invalid model list.");
        }
        return {
          models: body.models
            .filter((model) => isRecord(model) && typeof model.name === "string")
            .map((model) => model.name),
        };
      },
    }],
  ]);

  return {
    registeredIds() {
      return [...definitions.keys()];
    },
    discover(clientId, allowedIds) {
      return [...definitions.values()]
        .filter((tool) => allowedIds.includes(tool.id) && tool.allowedClients.includes(clientId))
        .map(publicDefinition);
    },
    async invoke(toolId, { clientId, arguments: args, confirmed, allowedIds }) {
      const tool = definitions.get(toolId);
      if (!tool) {
        throw new AgentError(404, "TOOL_NOT_FOUND", "Tool is not registered.");
      }
      if (!tool.readOnly || !tool.allowedClients.includes(clientId) || !allowedIds.includes(toolId)) {
        throw new AgentError(403, "TOOL_FORBIDDEN", "Tool is not allowed for this client.");
      }
      validateArguments(tool.inputSchema, args);
      if (tool.confirmationRequired && confirmed !== true) {
        throw new AgentError(403, "TOOL_CONFIRMATION_REQUIRED", "Explicit user confirmation is required.");
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("Tool timed out.")), tool.timeoutMs);
      timeout.unref?.();
      try {
        const result = await tool.handler({ signal: controller.signal });
        if (!isRecord(result)) {
          throw new AgentError(502, "TOOL_OUTPUT_INVALID", "Tool returned an invalid result.");
        }
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > tool.maxOutputBytes) {
          throw new AgentError(502, "TOOL_OUTPUT_TOO_LARGE", "Tool result exceeded its output limit.");
        }
        return result;
      } catch (error) {
        if (controller.signal.aborted) {
          throw new AgentError(504, "TOOL_TIMEOUT", "Tool execution exceeded its configured timeout.");
        }
        if (error instanceof AgentError) throw error;
        throw new AgentError(502, "TOOL_FAILED", "Tool execution failed.");
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function validateArguments(schema, value) {
  if (!isRecord(value)) {
    throw new AgentError(400, "TOOL_ARGUMENTS_INVALID", "Tool arguments must be an object.");
  }
  rejectUnknownKeys(value, new Set(Object.keys(schema.properties)));
  if (schema.required.some((key) => !(key in value))) {
    throw new AgentError(400, "TOOL_ARGUMENTS_INVALID", "Required tool arguments are missing.");
  }
}

function publicDefinition({ handler, ...definition }) {
  return structuredClone(definition);
}
