export type AgentChannel = "chat" | "vision" | "ambient";
export type AgentHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

type AgentImage = {
  mimeType: "image/jpeg";
  data: string;
};

type AgentChatInput = {
  channel: AgentChannel;
  conversationId: string;
  sessionId: string;
  history: AgentHistoryMessage[];
  text: string;
  image?: AgentImage;
  signal?: AbortSignal;
};

type AgentChatResponse = {
  apiVersion: "1.0";
  message: { role: "assistant"; content: string };
};

const API_BASE_URL = (
  import.meta.env.VITE_AGENT_API_URL ?? "http://127.0.0.1:4319"
).replace(/\/$/, "");

function createRequest(input: AgentChatInput) {
  return {
    requestId: crypto.randomUUID(),
    clientId: "react",
    channel: input.channel,
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    history: input.history,
    message: {
      text: input.text,
      ...(input.image ? { images: [input.image] } : {}),
    },
  };
}

async function throwApiError(response: Response): Promise<never> {
  let message = `Agent API returned HTTP ${response.status}.`;
  try {
    const body = await response.json() as {
      error?: { message?: unknown };
    };
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    // Keep the HTTP status when the server does not return a JSON error.
  }
  throw new Error(message);
}

export async function chatAgent(
  input: AgentChatInput,
): Promise<AgentChatResponse> {
  const response = await fetch(`${API_BASE_URL}/api/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: input.signal,
    body: JSON.stringify(createRequest(input)),
  });
  if (!response.ok) return throwApiError(response);

  const body = await response.json() as AgentChatResponse;
  if (
    body.apiVersion !== "1.0" ||
    body.message?.role !== "assistant" ||
    typeof body.message.content !== "string"
  ) {
    throw new Error("Agent API returned an invalid chat response.");
  }
  return body;
}

export async function streamAgentChat(
  input: AgentChatInput,
  onDelta: (text: string) => void,
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/v1/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: input.signal,
    body: JSON.stringify(createRequest(input)),
  });
  if (!response.ok) return throwApiError(response);
  if (!response.body) throw new Error("Agent API returned no readable stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;

  const dispatch = (frame: string) => {
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!eventName || dataLines.length === 0) return;

    const payload = JSON.parse(dataLines.join("\n")) as {
      text?: unknown;
      error?: { message?: unknown };
    };
    if (eventName === "delta" && typeof payload.text === "string") {
      onDelta(payload.text);
    } else if (eventName === "error") {
      throw new Error(
        typeof payload.error?.message === "string"
          ? payload.error.message
          : "Agent API streaming failed.",
      );
    } else if (eventName === "cancelled") {
      throw new DOMException("The request was cancelled.", "AbortError");
    } else if (eventName === "done") {
      completed = true;
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) dispatch(frame);
    }
    buffer += decoder.decode();
    if (buffer.trim()) dispatch(buffer);
  } finally {
    reader.releaseLock();
  }

  if (!completed) throw new Error("Agent API stream ended before completion.");
}

export async function classifyAgentEmotion(
  text: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/api/v1/emotion`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      clientId: "react",
      sessionId,
      text,
    }),
  });
  if (!response.ok) return throwApiError(response);

  const body = await response.json() as {
    apiVersion?: unknown;
    emotion?: unknown;
  };
  if (body.apiVersion !== "1.0" || typeof body.emotion !== "string") {
    throw new Error("Agent API returned an invalid emotion response.");
  }
  return body.emotion;
}
