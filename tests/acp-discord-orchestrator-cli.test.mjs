import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SUPERVISOR_ERROR_EXIT = 22;

test("CLI exits with the mapped code despite a leaked runtime handle", {
  timeout: 5000
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-cli-exit-"));
  const runtimeFile = path.join(root, "runtime.mjs");
  const promptFile = path.join(root, "prompt.txt");
  const responseFile = path.join(root, "response.txt");
  const configFile = path.join(root, "run.json");
  const stateDir = path.join(root, "state");

  fs.writeFileSync(runtimeFile, `
export function createRuntimeStore() { return {}; }
export function createAgentRegistry() { return {}; }
export function createAcpRuntime() {
  setInterval(() => {}, 1000);
  return {
    async ensureSession() { return { sessionId: "mock" }; },
    startTurn(input) {
      return {
        requestId: input.requestId,
        events: { async *[Symbol.asyncIterator]() {} },
        result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        async cancel() {},
        async closeStream() {}
      };
    },
    async close() { throw new Error("simulated cleanup failure"); }
  };
}
`, { mode: 0o600 });
  fs.writeFileSync(promptFile, "bounded no-op", { mode: 0o600 });
  fs.writeFileSync(configFile, JSON.stringify({
    agent: "claude",
    model: "test-model",
    cwd: root,
    sessionKey: "cli-exit-test",
    promptFile,
    responseFile,
    stateDir,
    timeoutMs: 1000,
    progressMs: 0,
    allowKinds: ["read"],
    runtimeModule: runtimeFile
  }), { mode: 0o600 });

  const supervisorFile = fileURLToPath(new URL(
    "../acp-discord-orchestrator/scripts/acpx-foreground-supervisor.mjs",
    import.meta.url
  ));
  const child = spawn(process.execPath, [
    supervisorFile,
    "--config",
    configFile
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI did not exit after terminal output"));
    }, 3000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  assert.deepEqual(outcome, {
    code: SUPERVISOR_ERROR_EXIT,
    signal: null
  });
  assert.equal(stderr, "");
  assert.equal(fs.existsSync(responseFile), true);
  const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "terminal");
  assert.equal(events.at(-1).status, "completed");
  assert.equal(events.at(-1).supervisorStatus, "degraded");
  assert.equal(events.at(-1).cleanupOk, false);
});
