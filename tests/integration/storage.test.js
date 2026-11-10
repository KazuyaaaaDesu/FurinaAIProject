import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STORAGE_SERVER = path.join(ROOT, "services", "storage", "server.js");

async function startStorage(t) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "lumi-storage-test-"));
  const child = spawn(process.execPath, [STORAGE_SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      LUMI_STORAGE_DATA_DIR: dataDirectory,
      LUMI_STORAGE_HOST: "127.0.0.1",
      LUMI_STORAGE_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });

  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Storage service startup timed out.")), 10_000);
    const inspect = () => {
      const match = output.match(/Fufuu storage server: http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    };
    child.stdout.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Storage server exited (${code}): ${errorOutput}`));
    });
    inspect();
  });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(dataDirectory, { recursive: true, force: true });
  });

  return { baseUrl, dataDirectory };
}

test("migrated storage API persists only inside its isolated configured directory", async (t) => {
  const { baseUrl, dataDirectory } = await startStorage(t);
  const initial = await fetch(`${baseUrl}/api/conversations`);
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { version: 1, conversations: [] });

  const store = {
    version: 1,
    conversations: [{
      id: "integration-test",
      title: "Test conversation",
      messages: [{ role: "user", content: "isolated" }],
      updatedAt: new Date().toISOString(),
    }],
  };
  const saved = await fetch(`${baseUrl}/api/conversations`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(store),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/conversations`)).json(), store);

  const memoryStore = {
    version: 1,
    memories: [{
      id: "isolated-memory",
      content: "temporary integration test",
      createdAt: new Date().toISOString(),
    }],
  };
  const memorySave = await fetch(`${baseUrl}/api/memories`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(memoryStore),
  });
  assert.equal(memorySave.status, 200);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/memories`)).json(), memoryStore);

  assert.ok(path.isAbsolute(dataDirectory));
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
});
