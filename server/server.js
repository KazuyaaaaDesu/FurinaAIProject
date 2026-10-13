import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const CONVERSATIONS_FILE = path.join(DATA_DIR, "conversations.json");
const HOST = "127.0.0.1";
const PORT = 4317;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:5175",
  "http://127.0.0.1:5175",
]);

let saveQueue = Promise.resolve();

async function ensureFiles() {
  await mkdir(DATA_DIR, { recursive: true });

  for (const [file, initial] of [
    [CONVERSATIONS_FILE, { version: 1, conversations: [] }],
    [path.join(DATA_DIR, "memory.json"), { version: 1, memories: [] }],
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

function validateStore(body) {
  if (
    !body ||
    typeof body !== "object" ||
    body.version !== 1 ||
    !Array.isArray(body.conversations)
  ) {
    return false;
  }

  return body.conversations.every(
    (conversation) =>
      conversation &&
      typeof conversation === "object" &&
      !Array.isArray(conversation),
  );
}

async function atomicSave(data) {
  const tempFile = path.join(DATA_DIR, `conversations-${randomUUID()}.tmp`);

  try {
    await writeFile(tempFile, JSON.stringify(data, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(tempFile, CONVERSATIONS_FILE);
  } catch (error) {
    const { unlink } = await import("node:fs/promises");
    await unlink(tempFile).catch(() => {});
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return send(res, 403, { error: "Origin not allowed." });
  }

  if (req.method === "OPTIONS") {
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      return send(res, 403, { error: "Origin not allowed." });
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

    if (req.method === "GET" && url.pathname === "/api/conversations") {
      const fileContents = await readFile(CONVERSATIONS_FILE, "utf8");
      const data = JSON.parse(fileContents.replace(/^\uFEFF/, ""));
      return send(res, 200, data, origin);
    }

    if (req.method === "PUT" && url.pathname === "/api/conversations") {
      const body = await readBody(req);

      if (!validateStore(body)) {
        return send(
          res,
          400,
          { error: "Expected { version: 1, conversations: [...] }." },
          origin,
        );
      }

      // Queue writes so overlapping requests cannot overwrite each other out of order.
      const operation = saveQueue.then(() => atomicSave(body));
      saveQueue = operation.catch(() => {});
      await operation;

      return send(res, 200, { status: "saved" }, origin);
    }

    return send(res, 404, { error: "Not found." }, origin);
  } catch (error) {
    console.error("Storage server error:", error);
    return send(
      res,
      error.status ?? 500,
      { error: error.status ? error.message : "Storage operation failed." },
      origin,
    );
  }
});

await ensureFiles();

server.listen(PORT, HOST, () => {
  console.log(`Sakura storage server: http://${HOST}:${PORT}`);
  console.log(`Conversation file: ${CONVERSATIONS_FILE}`);
});
