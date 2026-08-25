import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildValidReporting } from "../acp-discord-orchestrator/scripts/acp-reporting-test-fixture.mjs";

const SUPERVISOR_ERROR_EXIT = 22;
const LIFECYCLE_SCHEMA_VERSION = "acp-host-lifecycle.v1";

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
  const importMarker = path.join(root, "runtime-imported");

  fs.writeFileSync(runtimeFile, `
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(importMarker)}, "imported");
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
    stdio: ["pipe", "pipe", "pipe"],
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

  const activationRequired = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("activation gate was not emitted")), 1000);
    const inspect = () => {
      if (stdout.includes('"type":"activation_required"')) {
        clearTimeout(timer);
        child.stdout.off("data", inspect);
        resolve();
      }
    };
    child.stdout.on("data", inspect);
    inspect();
  });

  await activationRequired;
  assert.equal(fs.existsSync(importMarker), false);
  child.stdin.end(JSON.stringify({
    schemaVersion: "acp-host-activation.v1",
    processHandle: "cli-session-42"
  }) + "\n");

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
  assert.equal(fs.existsSync(importMarker), true);
  const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events[0].type, "activation_required");
  assert.equal(events[1].type, "activation_confirmed");
  assert.equal(events.at(-1).type, "terminal");
  assert.equal(events.at(-1).status, "completed");
  assert.equal(events.at(-1).supervisorStatus, "degraded");
  assert.equal(events.at(-1).cleanupOk, false);
});

const LIFECYCLE_RECONCILE_CLI = fileURLToPath(new URL(
  "../acp-discord-orchestrator/scripts/acp-lifecycle-reconcile-cli.mjs",
  import.meta.url
));

function runLifecycleReconcileCli(inputFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      LIFECYCLE_RECONCILE_CLI,
      "--input",
      inputFile
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function writeLifecycleLedger(root, overrides = {}) {
  const timestamp = new Date().toISOString();
  const ledgerFile = path.join(root, "supervisor-run-1.lifecycle.json");
  fs.writeFileSync(ledgerFile, JSON.stringify({
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    runId: "run-1",
    requestId: "request-1",
    processHandle: "cli-session-42",
    state: "terminal_intent",
    activatedAt: timestamp,
    lastEvent: { type: "terminal", sequence: 4, timestamp },
    terminalIntent: { type: "terminal", status: "completed" },
    exitReconciliation: { status: "pending", expectedExitCode: 0 },
    trackingFault: null,
    updatedAt: timestamp,
    ...overrides
  }, null, 2) + "\n", { mode: 0o600 });
  return ledgerFile;
}

test("lifecycle reconciliation CLI confirms mapped exit without exposing private input", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-reconcile-cli-"));
  const ledgerFile = writeLifecycleLedger(root);
  const inputFile = path.join(root, "reconcile.json");
  fs.writeFileSync(inputFile, JSON.stringify({
    ledgerFile,
    processHandle: "cli-session-42",
    outcome: "exited",
    exitCode: 0
  }), { mode: 0o600 });

  const outcome = await runLifecycleReconcileCli(inputFile);
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stderr, "");
  assert.deepEqual(JSON.parse(outcome.stdout), {
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    type: "lifecycle_reconciled",
    status: "exit_reconciled"
  });
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  assert.equal(ledger.exitReconciliation.status, "confirmed");
  assert.equal(ledger.exitReconciliation.exitCode, 0);
  assert.equal(outcome.stdout.includes(root), false);
  assert.equal(outcome.stdout.includes("cli-session-42"), false);
});

test("lifecycle reconciliation CLI records tracking_lost and rejects mismatched handles", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-reconcile-lost-"));
  const ledgerFile = writeLifecycleLedger(root, {
    state: "active",
    lastEvent: {
      type: "started",
      sequence: 3,
      timestamp: new Date().toISOString()
    },
    terminalIntent: null,
    exitReconciliation: { status: "pending" }
  });
  const mismatchInput = path.join(root, "mismatch.json");
  fs.writeFileSync(mismatchInput, JSON.stringify({
    ledgerFile,
    processHandle: "wrong-session",
    outcome: "tracking_lost"
  }), { mode: 0o600 });
  const mismatch = await runLifecycleReconcileCli(mismatchInput);
  assert.equal(mismatch.code, 64);
  assert.equal(mismatch.stdout, "");
  assert.equal(JSON.parse(mismatch.stderr).code, "lifecycle_handle_mismatch");
  assert.equal(mismatch.stderr.includes(root), false);
  assert.equal(mismatch.stderr.includes("wrong-session"), false);

  const lostInput = path.join(root, "lost.json");
  fs.writeFileSync(lostInput, JSON.stringify({
    ledgerFile,
    processHandle: "cli-session-42",
    outcome: "tracking_lost"
  }), { mode: 0o600 });
  const lost = await runLifecycleReconcileCli(lostInput);
  assert.equal(lost.code, 0);
  assert.equal(JSON.parse(lost.stdout).status, "tracking_lost");
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  assert.equal(ledger.trackingFault.code, "tracking_lost");
});

// ---------------------------------------------------------------------------
// acp-start-message-cli.mjs — the production start-message builder CLI.
// ---------------------------------------------------------------------------

const INVALID_CONFIG_EXIT = 64;

const START_MESSAGE_CLI = fileURLToPath(new URL(
  "../acp-discord-orchestrator/scripts/acp-start-message-cli.mjs",
  import.meta.url
));

const START_MESSAGE_INPUT = Object.freeze({
  agent: "codex",
  model: "gpt-5.6-sol[medium]",
  roundIndex: 1,
  repository: "openclaw-skills",
  branch: "fix/acp-reporting-start-builder",
  timeKst: "18:30",
  scope: "보고 시작 메시지 빌더 검증",
  externalAction: "없음"
});

function runStartMessageCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [START_MESSAGE_CLI, ...args], {
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
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function writeStartMessageInput(root, input, mode = 0o600) {
  const inputFile = path.join(root, "start-message.json");
  fs.writeFileSync(inputFile, JSON.stringify(input), { mode });
  // The creation mode is narrowed by the process umask; set the exact mode so
  // the broad-permissions case really is broad.
  fs.chmodSync(inputFile, mode);
  return inputFile;
}

async function expectStartMessageCliError(args, code) {
  const outcome = await runStartMessageCli(args);
  assert.equal(outcome.code, INVALID_CONFIG_EXIT);
  assert.equal(outcome.stdout, "");
  const events = outcome.stderr.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "start_message_builder_error");
  assert.equal(events[0].code, code);
  return outcome;
}

test("start-message CLI renders the exact round-1 message from a private JSON input", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-start-cli-"));
  const inputFile = writeStartMessageInput(root, START_MESSAGE_INPUT);
  const outcome = await runStartMessageCli(["--input", inputFile]);
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stderr, "");
  assert.equal(outcome.stdout, [
    "🚀 **ACP 작업 시작 · 18:30 KST**",
    "",
    "🤖 **ACP**: Codex · `gpt-5.6-sol[medium]`",
    "📍 **작업**: `openclaw-skills` · `fix/acp-reporting-start-builder`",
    "",
    "🎯 **범위**",
    "- 보고 시작 메시지 빌더 검증",
    "",
    "🕒 **중간 보고**",
    "- ACP 실행 10분 이상일 때만 시작",
    "",
    "🔒 **외부 작업**",
    "- 없음",
    ""
  ].join("\n"));
});

test("start-message CLI derives the correction title from roundIndex alone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-start-cli-"));
  const inputFile = writeStartMessageInput(root, { ...START_MESSAGE_INPUT, roundIndex: 3 });
  const outcome = await runStartMessageCli(["--input", inputFile]);
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stderr, "");
  assert.equal(
    outcome.stdout.split("\n")[0],
    "🔁 **ACP 수정 라운드 3 시작 · 18:30 KST**"
  );
});

test("start-message CLI rejects a caller-supplied title without echoing it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-start-cli-"));
  const smuggledTitle = "🚀 **ACP 작업 시작 · 18:30 KST**";
  const inputFile = writeStartMessageInput(root, {
    ...START_MESSAGE_INPUT,
    roundIndex: 3,
    title: smuggledTitle
  });
  const outcome = await expectStartMessageCliError(
    ["--input", inputFile],
    "invalid_reporting_context"
  );
  assert.ok(!outcome.stderr.includes(smuggledTitle));
});

test("start-message CLI rejects screened free text without echoing it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-start-cli-"));
  const inputFile = writeStartMessageInput(root, {
    ...START_MESSAGE_INPUT,
    scope: "git status 출력 정리"
  });
  const outcome = await expectStartMessageCliError(
    ["--input", inputFile],
    "invalid_reporting_forbidden_content"
  );
  assert.ok(!outcome.stderr.includes("git status"));
});

test("start-message CLI enforces usage and private-path handling without echoing paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-start-cli-"));

  await expectStartMessageCliError([], "usage");
  await expectStartMessageCliError(["--config", path.join(root, "x.json")], "usage");
  await expectStartMessageCliError(
    ["--input", "relative/start.json"],
    "invalid_input_path_not_absolute"
  );
  await expectStartMessageCliError(
    ["--input", path.join(root, "missing.json")],
    "invalid_input_file_missing"
  );

  const broad = writeStartMessageInput(root, START_MESSAGE_INPUT, 0o644);
  const outcome = await expectStartMessageCliError(
    ["--input", broad],
    "invalid_input_file_permissions"
  );
  assert.ok(!outcome.stderr.includes(root));

  const link = path.join(root, "link.json");
  fs.symlinkSync(broad, link);
  await expectStartMessageCliError(["--input", link], "invalid_input_file_symlink");

  const malformed = path.join(root, "malformed.json");
  fs.writeFileSync(malformed, "{not json", { mode: 0o600 });
  await expectStartMessageCliError(["--input", malformed], "invalid_input_json");
});
