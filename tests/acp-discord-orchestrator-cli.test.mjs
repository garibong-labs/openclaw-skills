import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildValidReporting } from "../acp-discord-orchestrator/scripts/acp-reporting-test-fixture.mjs";

const SUPERVISOR_ERROR_EXIT = 22;

const CONTROL_CONVERSATION_ID = "100000000000000001";
const START_MESSAGE_ID = "100000000000000002";

// Deterministic codex acp-reporting-v2 bundle from the shared integration
// fixture, bound to this test's lifecycle receipt so the config passes the
// mandatory reporting gate and reaches turn execution.
function validReporting(deliveredAt, model = "test-model") {
  return buildValidReporting({
    agent: "codex",
    controlConversationId: CONTROL_CONVERSATION_ID,
    messageId: START_MESSAGE_ID,
    deliveredAt,
    model
  });
}

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
  const deliveredAt = new Date().toISOString();
  fs.writeFileSync(configFile, JSON.stringify({
    agent: "codex",
    model: "test-model",
    cwd: root,
    sessionKey: "cli-exit-test",
    promptFile,
    responseFile,
    stateDir,
    timeoutMs: 1000,
    progressMs: 0,
    lifecycle: {
      controlConversationId: CONTROL_CONVERSATION_ID,
      maxStartReceiptAgeMs: 60000,
      startReceipt: {
        conversationId: CONTROL_CONVERSATION_ID,
        messageId: START_MESSAGE_ID,
        deliveredAt
      }
    },
    reporting: validReporting(deliveredAt),
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
    stdio: ["ignore", "pipe", "pipe"],
    // Canonical codex runs require the operator-injected executable path
    // before any runtime surface; the test's own node binary satisfies the
    // absolute-regular-executable contract.
    env: { ...process.env, CODEX_PATH: process.execPath }
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
