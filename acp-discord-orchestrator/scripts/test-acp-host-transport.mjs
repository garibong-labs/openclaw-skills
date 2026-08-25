import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACP_HOST_TRANSPORT_SCHEMA_VERSION,
  activateHostTransport,
  prepareHostTransport,
  probeHostTransport,
  reconcileHostTransport,
  statusHostTransport
} from "./acp-host-transport.mjs";
import { buildValidReporting } from "./acp-reporting-test-fixture.mjs";

const CONTROL_CONVERSATION_ID = "100000000000000001";
const START_MESSAGE_ID = "100000000000000002";
const TRANSPORT_CLI = fileURLToPath(new URL("acp-host-transport-cli.mjs", import.meta.url));

function tmuxAvailable() {
  const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  return result.status === 0;
}

function writeFixture(root) {
  if (process.platform !== "win32") {
    fs.chmodSync(root, 0o700);
  }
  const runtimeFile = path.join(root, "runtime.mjs");
  const promptFile = path.join(root, "prompt.txt");
  const responseFile = path.join(root, "response.txt");
  const configFile = path.join(root, "run.json");
  const stateDir = path.join(root, "state");
  const deliveredAt = new Date().toISOString();
  fs.writeFileSync(runtimeFile, `
export function createRuntimeStore() { return {}; }
export function createAgentRegistry() { return {}; }
export function createAcpRuntime() {
  return {
    async probeAvailability() {},
    async ensureSession() { return { sessionId: "mock" }; },
    startTurn(input) {
      return {
        requestId: input.requestId,
        events: { async *[Symbol.asyncIterator]() {} },
        result: Promise.resolve({
          status: "completed",
          stopReason: "end_turn",
          response: "transport-ok"
        }),
        async cancel() {},
        async closeStream() {}
      };
    },
    async close() {}
  };
}
`, { mode: 0o600 });
  fs.writeFileSync(promptFile, "bounded transport test", { mode: 0o600 });
  fs.writeFileSync(configFile, JSON.stringify({
    agent: "codex",
    model: "test-model",
    cwd: root,
    sessionKey: "host-transport-test",
    promptFile,
    responseFile,
    stateDir,
    timeoutMs: 5000,
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
    reporting: buildValidReporting({
      agent: "codex",
      controlConversationId: CONTROL_CONVERSATION_ID,
      messageId: START_MESSAGE_ID,
      deliveredAt,
      model: "test-model"
    }),
    allowKinds: ["read"],
    runtimeModule: runtimeFile
  }, null, 2) + "\n", { mode: 0o600 });
  return { configFile, responseFile, stateDir };
}

async function waitForExit(input) {
  for (let index = 0; index < 100; index += 1) {
    const status = statusHostTransport(input);
    if (status.status === "exited") {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("host transport did not reach a mapped exit");
}

test("host transport probe fails closed when tmux is unavailable", () => {
  assert.throws(() => probeHostTransport({
    runTmux() {
      return { status: null, stdout: "", stderr: "", error: { code: "ENOENT" } };
    }
  }), /host_transport_tmux_missing/);
});

test("host transport probe fails closed without the clean environment command", () => {
  assert.throws(() => probeHostTransport({
    statFile() {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
    runTmux() {
      assert.fail("tmux must not be probed after the clean-environment prerequisite fails");
    }
  }), /host_transport_env_missing/);
});

test("host transport CLI accepts only the closed private input shape", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-host-transport-cli-"));
  const inputFile = path.join(root, "input.json");
  fs.writeFileSync(inputFile, JSON.stringify({
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    action: "probe",
    callerTitle: "not-allowed"
  }), { mode: 0o600 });
  const result = spawnSync(process.execPath, [TRANSPORT_CLI, "--input", inputFile], {
    encoding: "utf8"
  });
  assert.equal(result.status, 64);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).code, "host_transport_input_shape");
  assert.equal(result.stderr.includes(root), false);
  assert.equal(result.stderr.includes("not-allowed"), false);
});

test("status ignores an incomplete NDJSON tail until a later poll", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-host-transport-tail-"));
  if (process.platform !== "win32") {
    fs.chmodSync(root, 0o700);
  }
  const handle = "acp-partial-tail";
  const prefix = path.join(root, `host-transport-${handle}`);
  const transportFile = `${prefix}.json`;
  const record = {
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    transportId: handle,
    processHandle: handle,
    configFile: path.join(root, "run.json"),
    entryFile: path.join(root, "entry.mjs"),
    eventsFile: `${prefix}.events.ndjson`,
    stderrFile: `${prefix}.stderr.log`,
    exitFile: `${prefix}.exit`,
    environmentFile: `${prefix}.env.json`,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(transportFile, JSON.stringify(record), { mode: 0o600 });
  fs.writeFileSync(record.eventsFile, '{"type":"activation_required"', { mode: 0o600 });

  const status = statusHostTransport({
    transportFile,
    processHandle: handle
  }, {
    runTmux() {
      return { status: 0, stdout: "", stderr: "" };
    }
  });
  assert.equal(status.status, "active");
  assert.equal(status.lastSequence, 0);
  assert.deepEqual(status.events, []);
});

test("truncated status advances its cursor only through returned events", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-host-transport-cursor-"));
  if (process.platform !== "win32") {
    fs.chmodSync(root, 0o700);
  }
  const handle = "acp-truncated-cursor";
  const prefix = path.join(root, `host-transport-${handle}`);
  const transportFile = `${prefix}.json`;
  const record = {
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    transportId: handle,
    processHandle: handle,
    configFile: path.join(root, "run.json"),
    entryFile: path.join(root, "entry.mjs"),
    eventsFile: `${prefix}.events.ndjson`,
    stderrFile: `${prefix}.stderr.log`,
    exitFile: `${prefix}.exit`,
    environmentFile: `${prefix}.env.json`,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(transportFile, JSON.stringify(record), { mode: 0o600 });
  fs.writeFileSync(record.eventsFile, Array.from({ length: 66 }, (_, index) => JSON.stringify({
    schemaVersion: "acp-discord-orchestrator.v1",
    type: "activity",
    sequence: index + 1,
    runId: "run-truncated-cursor",
    requestId: "request-truncated-cursor"
  })).join("\n") + "\n", { mode: 0o600 });
  const dependencies = {
    runTmux() {
      return { status: 0, stdout: "", stderr: "" };
    }
  };

  const first = statusHostTransport({
    transportFile,
    processHandle: handle,
    afterSequence: 0
  }, dependencies);
  assert.equal(first.events.length, 64);
  assert.equal(first.truncated, true);
  assert.equal(first.lastSequence, 64);

  const second = statusHostTransport({
    transportFile,
    processHandle: handle,
    afterSequence: first.lastSequence
  }, dependencies);
  assert.equal(second.events.length, 2);
  assert.equal(second.truncated, false);
  assert.equal(second.lastSequence, 66);
});

test("launcher failures reconcile from exact transport terminal and exit evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-host-transport-launcher-"));
  if (process.platform !== "win32") {
    fs.chmodSync(root, 0o700);
  }
  const handle = "acp-launcher-error";
  const prefix = path.join(root, `host-transport-${handle}`);
  const transportFile = `${prefix}.json`;
  const record = {
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    transportId: handle,
    processHandle: handle,
    configFile: path.join(root, "run.json"),
    entryFile: path.join(root, "entry.mjs"),
    eventsFile: `${prefix}.events.ndjson`,
    stderrFile: `${prefix}.stderr.log`,
    exitFile: `${prefix}.exit`,
    environmentFile: `${prefix}.env.json`,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(transportFile, JSON.stringify(record), { mode: 0o600 });
  fs.writeFileSync(record.eventsFile, JSON.stringify({
    schemaVersion: "acp-discord-orchestrator.v1",
    type: "launcher_error",
    code: "invalid_config"
  }) + "\n", { mode: 0o600 });
  fs.writeFileSync(record.exitFile, "64\n", { mode: 0o600 });

  assert.deepEqual(reconcileHostTransport({
    transportFile,
    processHandle: handle
  }), {
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    type: "host_transport_reconciled",
    status: "pre_activation_exit_reconciled"
  });
});

test("tmux host transport returns a handle before activation and reconciles exact exit", {
  skip: process.platform === "win32" || !tmuxAvailable(),
  timeout: 10000
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-host-transport-"));
  const fixture = writeFixture(root);
  const prepared = prepareHostTransport({ configFile: fixture.configFile }, {
    environment: { ...process.env, CODEX_PATH: process.execPath }
  });
  assert.equal(prepared.schemaVersion, ACP_HOST_TRANSPORT_SCHEMA_VERSION);
  assert.equal(prepared.type, "host_transport_prepared");
  assert.match(prepared.processHandle, /^acp-[a-f0-9]{24}$/);
  assert.equal(fs.existsSync(fixture.responseFile), false);

  t.after(() => {
    spawnSync("tmux", ["kill-session", "-t", `=${prepared.processHandle}`], {
      stdio: "ignore"
    });
  });

  const activated = await activateHostTransport(prepared);
  assert.equal(activated.type, "host_transport_activated");
  assert.equal(activated.processHandle, prepared.processHandle);
  assert.equal(fs.existsSync(activated.lifecycleLedgerFile), true);

  const status = await waitForExit(prepared);
  assert.equal(status.exitCode, 0);
  assert.equal(status.terminalType, "terminal");
  assert.equal(status.events.some((event) => event.type === "activation_required"), true);
  assert.equal(status.events.some((event) => event.type === "activation_confirmed"), true);
  assert.equal(fs.existsSync(fixture.responseFile), true);

  const reconciled = reconcileHostTransport(prepared);
  assert.deepEqual(reconciled, {
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    type: "host_transport_reconciled",
    status: "exit_reconciled"
  });
});
