import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LumiAgent } from "../../core/agent/agent.js";
import {
  AgentError,
  isRecord,
  isUuid,
  rejectUnknownKeys,
  validateChatRequest,
  validateChatResponse,
  validateOpaqueId,
} from "../../core/agent/policies.js";
import { loadSkillRegistry } from "../../core/agent/skill-registry.js";
import { createToolRegistry } from "../../core/agent/tool-registry.js";

const API_PREFIX = "/api/v1";
const DEFAULT_CONFIG_PATH = new URL("../../shared/config/agent.json", import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function createAgentServer({
  config,
  projectRoot = PROJECT_ROOT,
  fetchImpl = fetch,
  skills,
  tools,
  agent,
} = {}) {
  const resolvedConfig = config ?? JSON.parse(await readFile(DEFAULT_CONFIG_PATH, "utf8"));
  const toolRegistry = tools ?? createToolRegistry(resolvedConfig, fetchImpl);
  const skillRegistry = skills ?? await loadSkillRegistry(projectRoot, {
    registeredToolIds: toolRegistry.registeredIds(),
  });
  const agentCore = agent ?? new LumiAgent({
    config: resolvedConfig,
    projectRoot,
    skills: skillRegistry,
    fetchImpl,
  });
  const activeRequests = new Map();
  const server = http.createServer((request, response) => {
    void routeRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendError(response, asAgentError(error));
    });
  });

  async function routeRequest(request, response) {
    setSecurityHeaders(response);
    const origin = request.headers.origin;
    if (origin && !resolvedConfig.allowedOrigins.includes(origin)) {
      return sendError(response, new AgentError(403, "ORIGIN_FORBIDDEN", "Origin is not allowed."));
    }
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      if (!origin) return sendError(response, new AgentError(403, "ORIGIN_REQUIRED", "Origin is required."));
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      });
      return response.end();
    }

    const url = new URL(request.url ?? "/", `http://${resolvedConfig.host}:${resolvedConfig.port}`);
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, {
        apiVersion: resolvedConfig.apiVersion,
        status: "ok",
        service: "lumi-agent-api",
        capabilities: {
          chat: true,
          streaming: true,
          vision: true,
          emotion: true,
          cancellation: true,
          skills: true,
          registeredTools: true,
        },
      });
    }
    if (request.method === "GET" && url.pathname === `${API_PREFIX}/capabilities`) {
      return sendJson(response, 200, {
        apiVersion: resolvedConfig.apiVersion,
        clients: Object.entries(resolvedConfig.clientPolicies).map(([id, policy]) => ({
          id,
          channels: [...policy.channels],
        })),
        features: {
          chat: true,
          streaming: true,
          vision: true,
          emotion: true,
          cancellation: true,
          skills: true,
          registeredTools: true,
        },
        limits: {
          maxBodyBytes: resolvedConfig.maxBodyBytes,
          maxImageBytes: resolvedConfig.maxImageBytes,
          requestTimeoutMs: resolvedConfig.requestTimeoutMs,
        },
      });
    }
    if (request.method === "GET" && url.pathname === `${API_PREFIX}/skills`) {
      const clientId = url.searchParams.get("clientId");
      const policy = policyForDiscovery(resolvedConfig, clientId);
      return sendJson(response, 200, {
        apiVersion: resolvedConfig.apiVersion,
        skills: skillRegistry.listFor(clientId, policy.allowedSkillIds),
      });
    }
    if (request.method === "GET" && url.pathname === `${API_PREFIX}/tools`) {
      const clientId = url.searchParams.get("clientId");
      const policy = policyForDiscovery(resolvedConfig, clientId);
      return sendJson(response, 200, {
        apiVersion: resolvedConfig.apiVersion,
        tools: toolRegistry.discover(clientId, policy.allowedToolIds),
      });
    }

    if (request.method === "POST" && url.pathname === `${API_PREFIX}/emotion`) {
      const body = await readJsonBody(request, resolvedConfig.maxBodyBytes);
      if (!isRecord(body)) throw new AgentError(400, "REQUEST_INVALID", "Request body must be an object.");
      rejectUnknownKeys(body, new Set(["requestId", "clientId", "sessionId", "text"]));
      if (!isUuid(body.requestId)) throw new AgentError(400, "REQUEST_ID_INVALID", "requestId must be a UUID.");
      validateClientSession(body.clientId, body.sessionId, resolvedConfig);
      if (body.clientId !== "react") {
        throw new AgentError(403, "EMOTION_FORBIDDEN", "Emotion classification is not enabled for this client.");
      }
      if (typeof body.text !== "string" || body.text.length > 20_000) {
        throw new AgentError(400, "EMOTION_TEXT_INVALID", "text must be a string of at most 20000 characters.");
      }
      if (activeRequests.has(body.requestId)) {
        throw new AgentError(409, "REQUEST_ID_CONFLICT", "requestId is already active.");
      }
      if (activeRequests.size >= resolvedConfig.maxConcurrentRequests) {
        throw new AgentError(429, "CONCURRENCY_LIMIT", "Agent request capacity is full.");
      }
      const controller = new AbortController();
      activeRequests.set(body.requestId, {
        controller,
        clientId: body.clientId,
        sessionId: body.sessionId,
      });
      request.once("aborted", () => controller.abort(new Error("Client disconnected.")));
      response.once("close", () => {
        if (!response.writableEnded) controller.abort(new Error("Client disconnected."));
      });
      try {
        const emotion = await agentCore.classifyEmotion(body.clientId, body.text, {
          signal: controller.signal,
        });
        return sendJson(response, 200, {
          apiVersion: resolvedConfig.apiVersion,
          requestId: body.requestId,
          clientId: body.clientId,
          sessionId: body.sessionId,
          emotion,
        });
      } finally {
        activeRequests.delete(body.requestId);
      }
    }

    const skillMatch = url.pathname.match(/^\/api\/v1\/skills\/([a-z0-9-]{1,64})\/activate$/);
    if (request.method === "POST" && skillMatch) {
      const body = await readJsonBody(request, resolvedConfig.maxBodyBytes);
      if (!isRecord(body)) throw new AgentError(400, "REQUEST_INVALID", "Request body must be an object.");
      rejectUnknownKeys(body, new Set(["clientId", "sessionId", "enabled"]));
      validateClientSession(body.clientId, body.sessionId, resolvedConfig);
      if (typeof body.enabled !== "boolean") {
        throw new AgentError(400, "SKILL_ACTIVATION_INVALID", "enabled must be a boolean.");
      }
      const policy = resolvedConfig.clientPolicies[body.clientId];
      const result = skillRegistry.activate(
        body.clientId,
        body.sessionId,
        skillMatch[1],
        body.enabled,
        policy.allowedSkillIds,
      );
      return sendJson(response, 200, { apiVersion: resolvedConfig.apiVersion, skill: result });
    }

    const toolMatch = url.pathname.match(/^\/api\/v1\/tools\/([a-z][a-z0-9._-]{1,63})\/invoke$/);
    if (request.method === "POST" && toolMatch) {
      const body = await readJsonBody(request, resolvedConfig.maxBodyBytes);
      if (!isRecord(body)) throw new AgentError(400, "REQUEST_INVALID", "Request body must be an object.");
      rejectUnknownKeys(body, new Set(["requestId", "clientId", "sessionId", "arguments", "authorization"]));
      if (!isUuid(body.requestId)) throw new AgentError(400, "REQUEST_ID_INVALID", "requestId must be a UUID.");
      validateClientSession(body.clientId, body.sessionId, resolvedConfig);
      if (!isRecord(body.arguments)) throw new AgentError(400, "TOOL_ARGUMENTS_INVALID", "arguments must be an object.");
      if (body.authorization !== undefined) {
        if (!isRecord(body.authorization)) throw new AgentError(400, "AUTHORIZATION_INVALID", "authorization must be an object.");
        rejectUnknownKeys(body.authorization, new Set(["confirmed"]));
        if (body.authorization.confirmed !== undefined && typeof body.authorization.confirmed !== "boolean") {
          throw new AgentError(400, "AUTHORIZATION_INVALID", "authorization.confirmed must be a boolean.");
        }
      }
      const policy = resolvedConfig.clientPolicies[body.clientId];
      const result = await toolRegistry.invoke(toolMatch[1], {
        clientId: body.clientId,
        arguments: body.arguments,
        confirmed: body.authorization?.confirmed === true,
        allowedIds: policy.allowedToolIds,
      });
      return sendJson(response, 200, {
        apiVersion: resolvedConfig.apiVersion,
        requestId: body.requestId,
        toolId: toolMatch[1],
        status: "completed",
        result,
      });
    }

    const cancelMatch = url.pathname.match(/^\/api\/v1\/requests\/([0-9a-f-]{36})\/cancel$/i);
    if (request.method === "POST" && cancelMatch) {
      const body = await readJsonBody(request, resolvedConfig.maxBodyBytes);
      if (!isRecord(body)) throw new AgentError(400, "REQUEST_INVALID", "Request body must be an object.");
      rejectUnknownKeys(body, new Set(["clientId", "sessionId"]));
      validateClientSession(body.clientId, body.sessionId, resolvedConfig);
      const active = activeRequests.get(cancelMatch[1]);
      if (!active) throw new AgentError(404, "REQUEST_NOT_FOUND", "No active request has that ID.");
      if (active.clientId !== body.clientId || active.sessionId !== body.sessionId) {
        throw new AgentError(403, "REQUEST_FORBIDDEN", "Request belongs to a different client or session.");
      }
      active.controller.abort(new Error("Cancelled by client."));
      return sendJson(response, 200, {
        apiVersion: resolvedConfig.apiVersion,
        requestId: cancelMatch[1],
        status: "cancellation_requested",
      });
    }

    const isStream = request.method === "POST" && url.pathname === `${API_PREFIX}/chat/stream`;
    const isChat = request.method === "POST" && url.pathname === `${API_PREFIX}/chat`;
    if (isStream || isChat) {
      const body = await readJsonBody(request, resolvedConfig.maxBodyBytes);
      const validated = validateChatRequest(body, resolvedConfig);
      if (activeRequests.has(validated.requestId)) {
        throw new AgentError(409, "REQUEST_ID_CONFLICT", "requestId is already active.");
      }
      if (activeRequests.size >= resolvedConfig.maxConcurrentRequests) {
        throw new AgentError(429, "CONCURRENCY_LIMIT", "Agent request capacity is full.");
      }

      const controller = new AbortController();
      const active = {
        controller,
        clientId: validated.clientId,
        sessionId: validated.sessionId,
      };
      activeRequests.set(validated.requestId, active);
      request.once("aborted", () => controller.abort(new Error("Client disconnected.")));
      response.once("close", () => {
        if (!response.writableEnded) controller.abort(new Error("Client disconnected."));
      });

      try {
        if (isStream) {
          response.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
          });
          const model = agentCore.modelFor(validated.clientId, validated.message);
          writeEvent(response, "meta", {
            apiVersion: resolvedConfig.apiVersion,
            requestId: validated.requestId,
            ...(validated.conversationId ? { conversationId: validated.conversationId } : {}),
            sessionId: validated.sessionId,
            clientId: validated.clientId,
            model,
          });
          const result = validateChatResponse(await agentCore.chat(validated, {
            signal: controller.signal,
            onDelta: (text) => writeEvent(response, "delta", {
              requestId: validated.requestId,
              text,
            }),
          }));
          if (controller.signal.aborted) {
            writeEvent(response, "cancelled", {
              apiVersion: resolvedConfig.apiVersion,
              requestId: validated.requestId,
              status: "cancelled",
            });
          } else {
            writeEvent(response, "done", {
              apiVersion: resolvedConfig.apiVersion,
              requestId: validated.requestId,
              status: "completed",
              finishReason: result.finishReason,
              ...(result.warnings ? { warnings: result.warnings } : {}),
            });
          }
          return response.end();
        }

        const result = validateChatResponse(
          await agentCore.chat(validated, { signal: controller.signal }),
        );
        return sendJson(response, 200, result);
      } catch (error) {
        if (isStream && response.headersSent && !response.destroyed) {
          const apiError = asAgentError(error);
          if (controller.signal.aborted) {
            writeEvent(response, "cancelled", {
              apiVersion: resolvedConfig.apiVersion,
              requestId: validated.requestId,
              status: "cancelled",
            });
          } else {
            writeEvent(response, "error", {
              apiVersion: resolvedConfig.apiVersion,
              requestId: validated.requestId,
              error: errorBody(apiError).error,
            });
          }
          return response.end();
        }
        throw error;
      } finally {
        activeRequests.delete(validated.requestId);
      }
    }

    throw new AgentError(404, "NOT_FOUND", "Route was not found.");
  }

  return {
    server,
    listen(port = resolvedConfig.port, host = resolvedConfig.host) {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve(server.address());
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    close() {
      for (const active of activeRequests.values()) {
        active.controller.abort(new Error("Server is shutting down."));
      }
      return new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

export function writeEvent(response, eventName, payload) {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function readJsonBody(request, maxBytes) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new AgentError(415, "CONTENT_TYPE_UNSUPPORTED", "Content-Type must be application/json.");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new AgentError(413, "BODY_TOO_LARGE", "Request body exceeds the configured limit.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AgentError(400, "JSON_INVALID", "Request body is not valid JSON.");
  }
}

function validateClientSession(clientId, sessionId, config) {
  if (!Object.hasOwn(config.clientPolicies, clientId)) {
    throw new AgentError(400, "CLIENT_INVALID", "Unsupported clientId.");
  }
  validateOpaqueId(sessionId, "sessionId");
}

function policyForDiscovery(config, clientId) {
  if (!Object.hasOwn(config.clientPolicies, clientId)) {
    throw new AgentError(400, "CLIENT_INVALID", "A supported clientId query parameter is required.");
  }
  return config.clientPolicies[clientId];
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response, status, body) {
  if (!isRecord(body) || body.apiVersion !== "1.0") {
    throw new AgentError(500, "RESPONSE_INVALID", "API response envelope is invalid.");
  }
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendError(response, error) {
  sendJson(response, error.status, errorBody(error));
}

function errorBody(error) {
  return {
    apiVersion: "1.0",
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

function asAgentError(error) {
  if (error instanceof AgentError) return error;
  return new AgentError(500, "INTERNAL_ERROR", "The agent API encountered an unexpected error.");
}

async function start() {
  const service = await createAgentServer();
  const address = await service.listen();
  console.log(`Lumi agent API listening on http://${address.address}:${address.port}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((error) => {
    console.error("Lumi agent API failed to start:", error.message);
    process.exitCode = 1;
  });
}
