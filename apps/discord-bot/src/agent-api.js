import { randomUUID } from "node:crypto";

const API_BASE_URL = (
  process.env.LUMI_AGENT_API_URL ?? "http://127.0.0.1:4319"
).replace(/\/$/, "");

export async function chatAgent({
  channel,
  conversationId,
  sessionId,
  history,
  text,
  fetchImpl = fetch,
  timeoutMs = 120_000,
}) {
  const response = await fetchImpl(`${API_BASE_URL}/api/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      requestId: randomUUID(),
      clientId: "discord",
      channel,
      conversationId,
      sessionId,
      history,
      message: { text },
    }),
  });

  if (!response.ok) {
    let message = `Agent API returned HTTP ${response.status}.`;
    try {
      const body = await response.json();
      if (typeof body.error?.message === "string") {
        message = body.error.message;
      }
    } catch {
      // Preserve the HTTP status when the server does not return JSON.
    }
    throw new Error(message);
  }

  const body = await response.json();
  if (
    body.apiVersion !== "1.0" ||
    body.message?.role !== "assistant" ||
    typeof body.message.content !== "string"
  ) {
    throw new Error("Agent API returned an invalid chat response.");
  }
  return body.message.content.trim();
}
