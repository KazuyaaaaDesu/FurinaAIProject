import http from "node:http";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DATA_DIR = path.join(ROOT, "data");
const CONVERSATIONS_FILE = path.join(DATA_DIR, "conversations.json");
const MEMORY_FILE = path.join(DATA_DIR, "memory.json");

const HOST = "127.0.0.1";
const PORT = 4317;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MEMORIES = 200;
const MAX_MEMORY_LENGTH = 1000;

const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:5175",
  "http://127.0.0.1:5175",
]);

let conversationSaveQueue = Promise.resolve();
let memorySaveQueue = Promise.resolve();

async function ensureFiles() {
  await mkdir(DATA_DIR, { recursive: true });

  for (const [file, initial] of [
    [CONVERSATIONS_FILE, { version: 1, conversations: [] }],
    [MEMORY_FILE, { version: 1, memories: [] }],
  ]) {
    try {
      await readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;

      await writeFile(file, JSON.stringify(initial, null, 2), "utf8");
    }
  }
}

function send(res, status, body, origin) {
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });

  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = "";
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }

    raw += chunk.toString("utf8");
  }

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

function validateConversationStore(body) {
  return (
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    body.version === 1 &&
    Array.isArray(body.conversations) &&
    body.conversations.every(
      (conversation) =>
        conversation &&
        typeof conversation === "object" &&
        !Array.isArray(conversation),
    )
  );
}

function validateMemoryStore(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body.version !== 1 ||
    !Array.isArray(body.memories) ||
    body.memories.length > MAX_MEMORIES
  ) {
    return false;
  }

  const ids = new Set();

  return body.memories.every((memory) => {
    if (
      !memory ||
      typeof memory !== "object" ||
      Array.isArray(memory) ||
      typeof memory.id !== "string" ||
      memory.id.length === 0 ||
      memory.id.length > 100 ||
      ids.has(memory.id) ||
      typeof memory.content !== "string" ||
      memory.content.trim().length === 0 ||
      memory.content.length > MAX_MEMORY_LENGTH ||
      typeof memory.createdAt !== "string" ||
      Number.isNaN(Date.parse(memory.createdAt))
    ) {
      return false;
    }

    ids.add(memory.id);
    return true;
  });
}

async function atomicSave(file, data, prefix) {
  const tempFile = path.join(
    DATA_DIR,
    `${prefix}-${randomUUID()}.tmp`,
  );

  try {
    await writeFile(tempFile, JSON.stringify(data, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });

    await rename(tempFile, file);
  } catch (error) {
    await unlink(tempFile).catch(() => {});
    throw error;
  }
}

async function readStore(file) {
  const contents = await readFile(file, "utf8");
  return JSON.parse(contents.replace(/^\uFEFF/, ""));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return send(res, 403, { error: "Origin not allowed." }, null);
  }

  if (req.method === "OPTIONS") {
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      return send(res, 403, { error: "Origin not allowed." }, null);
    }

    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    });

    return res.end();
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { status: "ok", storage: "D:" }, origin);
    }

    // Existing conversation endpoints
    if (req.method === "GET" && url.pathname === "/api/conversations") {
      return send(
        res,
        200,
        await readStore(CONVERSATIONS_FILE),
        origin,
      );
    }

    if (req.method === "PUT" && url.pathname === "/api/conversations") {
      const body = await readBody(req);

      if (!validateConversationStore(body)) {
        return send(
          res,
          400,
          { error: "Expected { version: 1, conversations: [...] }." },
          origin,
        );
      }

      const operation = conversationSaveQueue.then(() =>
        atomicSave(CONVERSATIONS_FILE, body, "conversations"),
      );

      conversationSaveQueue = operation.catch(() => {});
      await operation;

      return send(res, 200, { status: "saved" }, origin);
    }

    // New persistent-memory endpoints
    if (req.method === "GET" && url.pathname === "/api/memories") {
      return send(res, 200, await readStore(MEMORY_FILE), origin);
    }

    if (req.method === "PUT" && url.pathname === "/api/memories") {
      const body = await readBody(req);

      if (!validateMemoryStore(body)) {
        return send(
          res,
          400,
          {
            error:
              "Expected { version: 1, memories: [{ id, content, createdAt }] }. " +
              `Maximum ${MAX_MEMORIES} memories; each content must be 1–${MAX_MEMORY_LENGTH} characters.`,
          },
          origin,
        );
      }

      const operation = memorySaveQueue.then(() =>
        atomicSave(MEMORY_FILE, body, "memory"),
      );

      memorySaveQueue = operation.catch(() => {});
      await operation;

      return send(res, 200, { status: "saved" }, origin);
    }

    return send(res, 404, { error: "Not found." }, origin);
  } catch (error) {
    console.error("Storage server error:", error);

    return send(
      res,
      error.status ?? 500,
      {
        error: error.status
          ? error.message
          : "Storage operation failed.",
      },
      origin,
    );
  }
});

await ensureFiles();

server.listen(PORT, HOST, () => {
  console.log(`Fufuu storage server: http://${HOST}:${PORT}`);
  console.log(`Conversation file: ${CONVERSATIONS_FILE}`);
  console.log(`Memory file: ${MEMORY_FILE}`);
});