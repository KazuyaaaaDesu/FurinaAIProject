import { createHash } from "node:crypto";

const CLIENT_IDS = new Set(["react", "wpf", "discord"]);
const CHANNELS = new Set(["chat", "voice", "ambient", "vision"]);

export class AgentError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "AgentError";
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

export function getClientPolicy(config, clientId, channel) {
  if (!CLIENT_IDS.has(clientId)) {
    throw new AgentError(400, "CLIENT_INVALID", "Unsupported clientId.");
  }
  if (!CHANNELS.has(channel)) {
    throw new AgentError(400, "CHANNEL_INVALID", "Unsupported channel.");
  }

  const policy = config.clientPolicies[clientId];
  if (!policy || !policy.channels.includes(channel)) {
    throw new AgentError(
      403,
      "CHANNEL_FORBIDDEN",
      "This client is not allowed to use the requested channel.",
    );
  }
  return {
    ...policy,
    ...(policy.channelOverrides?.[channel] ?? {}),
  };
}

export function validateChatRequest(body, config) {
  if (!isRecord(body)) {
    throw new AgentError(400, "REQUEST_INVALID", "Request body must be an object.");
  }
  const allowed = new Set([
    "requestId",
    "clientId",
    "channel",
    "conversationId",
    "sessionId",
    "history",
    "message",
    "activeSkillIds",
  ]);
  rejectUnknownKeys(body, allowed);

  if (!isUuid(body.requestId)) {
    throw new AgentError(400, "REQUEST_ID_INVALID", "requestId must be a UUID.");
  }
  const policy = getClientPolicy(config, body.clientId, body.channel);
  validateOpaqueId(body.sessionId, "sessionId");
  if (body.conversationId !== undefined) {
    validateOpaqueId(body.conversationId, "conversationId");
  }
  if (!Array.isArray(body.history) || body.history.length > 100) {
    throw new AgentError(400, "HISTORY_INVALID", "history must contain at most 100 messages.");
  }
  for (const [index, item] of body.history.entries()) {
    if (
      !isRecord(item) ||
      Object.keys(item).some((key) => key !== "role" && key !== "content") ||
      !["user", "assistant"].includes(item.role) ||
      typeof item.content !== "string" ||
      item.content.length > 20_000
    ) {
      throw new AgentError(
        400,
        "HISTORY_MESSAGE_INVALID",
        "Each history item must be a bounded user or assistant text message.",
        { index },
      );
    }
  }

  if (!isRecord(body.message)) {
    throw new AgentError(400, "MESSAGE_INVALID", "message must be an object.");
  }
  rejectUnknownKeys(body.message, new Set(["text", "images"]));
  if (
    typeof body.message.text !== "string" ||
    body.message.text.length > 20_000
  ) {
    throw new AgentError(400, "MESSAGE_TEXT_INVALID", "message.text must be a string of at most 20000 characters.");
  }

  const images = body.message.images ?? [];
  if (!Array.isArray(images) || images.length > 1) {
    throw new AgentError(400, "IMAGES_INVALID", "At most one image is accepted per request.");
  }
  let totalImageBytes = 0;
  for (const [index, image] of images.entries()) {
    if (
      !isRecord(image) ||
      Object.keys(image).some((key) => key !== "mimeType" && key !== "data") ||
      !["image/jpeg", "image/png", "image/webp"].includes(image.mimeType) ||
      typeof image.data !== "string" ||
      !isBase64(image.data)
    ) {
      throw new AgentError(400, "IMAGE_INVALID", "Each image must contain a supported MIME type and base64 data.", { index });
    }
    const bytes = Buffer.from(image.data, "base64").length;
    if (bytes === 0 || bytes > config.maxImageBytes) {
      throw new AgentError(413, "IMAGE_TOO_LARGE", "Image exceeds the decoded image size limit.", { index });
    }
    totalImageBytes += bytes;
  }
  if (images.length > 0 && !["vision", "ambient", "chat"].includes(body.channel)) {
    throw new AgentError(422, "IMAGES_CHANNEL_INVALID", "Images are not supported for this channel.");
  }

  const skillIds = body.activeSkillIds ?? [];
  if (
    !Array.isArray(skillIds) ||
    skillIds.length > 8 ||
    skillIds.some((id) => typeof id !== "string" || !/^[a-z0-9-]{1,64}$/.test(id)) ||
    new Set(skillIds).size !== skillIds.length
  ) {
    throw new AgentError(400, "SKILLS_INVALID", "activeSkillIds must be unique registered skill IDs.");
  }
  if (skillIds.some((id) => !policy.allowedSkillIds.includes(id))) {
    throw new AgentError(403, "SKILL_FORBIDDEN", "A requested skill is not allowed for this client.");
  }

  return {
    requestId: body.requestId,
    clientId: body.clientId,
    channel: body.channel,
    conversationId: body.conversationId,
    sessionId: body.sessionId,
    history: body.history,
    message: { text: body.message.text, images },
    activeSkillIds: skillIds,
    policy,
    imageBytes: totalImageBytes,
  };
}

export function validateChatResponse(response) {
  const allowedKeys = new Set([
    "apiVersion",
    "requestId",
    "conversationId",
    "sessionId",
    "clientId",
    "status",
    "message",
    "model",
    "finishReason",
    "warnings",
  ]);
  if (
    !isRecord(response) ||
    Object.keys(response).some((key) => !allowedKeys.has(key)) ||
    response.apiVersion !== "1.0" ||
    !isUuid(response.requestId) ||
    !isOpaqueId(response.sessionId) ||
    !CLIENT_IDS.has(response.clientId) ||
    response.status !== "completed" ||
    !isRecord(response.message) ||
    response.message.role !== "assistant" ||
    typeof response.message.content !== "string" ||
    typeof response.model !== "string" ||
    !["stop", "length", "unknown"].includes(response.finishReason) ||
    (response.conversationId !== undefined &&
      !isOpaqueId(response.conversationId)) ||
    (response.warnings !== undefined &&
      (!Array.isArray(response.warnings) ||
        response.warnings.some((warning) => typeof warning !== "string")))
  ) {
    throw new AgentError(500, "RESPONSE_INVALID", "Agent produced an invalid chat response.");
  }
  return response;
}

export function selectHistory(history, limit) {
  if (limit <= 0) return [];
  return history.slice(-limit).map(({ role, content }) => ({ role, content }));
}

export function selectMemories(memories, mode, conversation, currentText, policy) {
  if (mode === "none" || memories.length === 0) return [];
  if (mode === "all") return memories.slice(0, policy.maxMemories);

  const recentText = [
    ...conversation.slice(-4).map((message) => message.content),
    currentText,
  ].join(" ").toLowerCase();
  const keywords = new Set(recentText.match(/[a-z0-9]{3,}/g) ?? []);

  const ranked = memories
    .map((memory, index) => {
      const words = new Set(memory.content.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
      let score = 0;
      for (const word of words) {
        if (keywords.has(word)) score += 1;
      }
      return { memory, index, score };
    })
    .sort((left, right) => right.score - left.score || right.index - left.index);

  const matching = ranked
    .filter((entry) => entry.score > 0)
    .slice(0, policy.maxMemories);
  const selected = matching.length > 0
    ? matching
    : ranked.slice(0, policy.fallbackMemories);
  return selected.map((entry) => entry.memory);
}

export function memoryReference(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rejectUnknownKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new AgentError(400, "REQUEST_PROPERTY_UNKNOWN", "Request contains unsupported properties.", {
      properties: unknown,
    });
  }
}

export function validateOpaqueId(value, name) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new AgentError(400, "IDENTIFIER_INVALID", `${name} is invalid.`);
  }
}

export function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isBase64(value) {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function isOpaqueId(value) {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value);
}
