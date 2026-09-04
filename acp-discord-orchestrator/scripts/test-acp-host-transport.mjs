import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACP_HOST_TRANSPORT_SCHEMA_VERSION,
  MAX_REPORT_PUBLICATION_ATTEMPTS,
  MAX_REPORT_RECEIPT_AGE_MS,
  REPORT_ATTEMPT_TTL_MS,
  REPORT_CADENCE_MS,
  acquireTransportLock,
  acknowledgeHostTransportReport,
  activateHostTransport,
  abortHostTransportPreactivation,
  beginHostTransportReportDelivery,
  claimHostTransportReport,
  confirmHostTransportActivation,
  prepareHostTransport,
  probeHostTransport,
  requireReport,
  reconcileHostTransport,
  statusHostTransport
} from "./acp-host-transport.mjs";
import { REMOTE_PROVIDER_CLOCK_SKEW_MS } from "./acpx-foreground-supervisor.mjs";
import { buildValidReporting } from "./acp-reporting-test-fixture.mjs";
import {
  buildAcpIntermediateReport,
  buildAcpTerminalReport
} from "./acp-reporting-contract.mjs";
import {
  AcpReportControllerPreparationError,
  runReportControllerPreparation
} from "./acp-report-controller-preparation.mjs";
import {
  activateLifecycleLedger,
  createLifecycleLedger,
  loadLifecycleLedger,
  recordLifecycleEvent
} from "./acp-lifecycle-ledger.mjs";

const CONTROL_CONVERSATION_ID = "100000000000000001";
// The scheduler, not the caller, mints the job id on the model-callable add.
const COORDINATOR_JOB_ID = "5c1a7f60-6b9d-4a11-9f2e-71c0a4d5b8e3";
const START_MESSAGE_ID = "100000000000000002";
const PUMP_JOB_ID = "acp-report-pump-round-1";
const TRANSPORT_CLI = fileURLToPath(new URL("acp-host-transport-cli.mjs", import.meta.url));

function publicationFixture(overrides = {}) {
  return {
    state: "receipt_acked",
    kind: null,
    cadence: 0,
    reportId: null,
    requiredAt: null,
    evidenceThroughSequence: 0,
    receiptMessageId: null,
    acknowledgedMessageIds: [],
    nextCadence: 1,
    nextDueAt: null,
    terminalSequence: null,
    terminalStatus: null,
    controlCursor: null,
    controlCursorIssuedAt: null,
    controlCursorReissues: 0,
    fence: 0,
    attempt: null,
    attemptCount: 0,
    lastAttemptOutcome: null,
    halted: null,
    pumpJobId: null,
    ...overrides
  };
}

function attemptFixture(overrides = {}) {
  return {
    attemptId: "attempt-fixture",
    fence: 1,
    state: "delivery_pending",
    jobId: PUMP_JOB_ID,
    runToken: "pumprun-fixture",
    claimedAt: new Date(0).toISOString(),
    expiresAt: new Date(REPORT_ATTEMPT_TTL_MS).toISOString(),
    ...overrides
  };
}

function reportingContextFixture() {
  return {
    agent: "codex",
    model: "test-model[medium]",
    roundIndex: 1,
    repository: "openclaw-skills",
    branch: "fix/acp-report-publication-state-machine",
    controlConversationId: CONTROL_CONVERSATION_ID
  };
}

function canonicalReport(kind, overrides = {}) {
  const identity = {
    ...reportingContextFixture(),
    timeKst: "12:34"
  };
  delete identity.controlConversationId;
  if (kind === "intermediate") {
    return {
      ...identity,
      phaseIndex: 2,
      totalMinutes: 10,
      phaseMinutes: 4,
      lastAcpActivityMinutesAgo: 0,
      newResultDelta: 0,
      executionState: "구현 중",
      inProgress: "수정 진행",
      verification: "검증 준비",
      next: "테스트 실행",
      ...overrides
    };
  }
  return {
    ...identity,
    elapsed: "10분",
    status: "completed",
    summary: "작업 완료",
    verification: "검증 통과",
    result: "수정 반영",
    next: "소유자 확인",
    externalAction: "없음",
    ...overrides
  };
}

function reportDigest(kind, report) {
  const message = kind === "intermediate"
    ? buildAcpIntermediateReport(report)
    : buildAcpTerminalReport(report);
  return crypto.createHash("sha256").update(message, "utf8").digest("hex");
}

function reportReceipt(kind, report, messageId, deliveredAt, deliveryStatus = "delivered") {
  return {
    conversationId: CONTROL_CONVERSATION_ID,
    messageId,
    deliveredAt: new Date(deliveredAt).toISOString(),
    deliveryStatus,
    messageDigest: reportDigest(kind, report)
  };
}

function serviceAck(status, servicedAt) {
  return {
    cursor: status.serviceCursor,
    conversationId: CONTROL_CONVERSATION_ID,
    servicedAt: new Date(servicedAt).toISOString()
  };
}

function claimInput(fixture, overrides = {}) {
  return {
    transportFile: fixture.transportFile,
    processHandle: fixture.processHandle,
    jobId: PUMP_JOB_ID,
    runToken: `pumprun-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
    destination: CONTROL_CONVERSATION_ID,
    ...overrides
  };
}

function claimAndBegin(fixture, dependencies) {
  const claim = claimHostTransportReport(claimInput(fixture), dependencies);
  assert.equal(claim.status, "claimed");
  beginHostTransportReportDelivery({
    transportFile: fixture.transportFile,
    processHandle: fixture.processHandle,
    attemptId: claim.attemptId,
    fence: claim.fence
  }, dependencies);
  return claim;
}

function ackInput(fixture, claim, report, receipt) {
  return {
    transportFile: fixture.transportFile,
    processHandle: fixture.processHandle,
    reportId: claim.reportId,
    reportKind: claim.reportKind,
    cadence: claim.cadence,
    attemptId: claim.attemptId,
    fence: claim.fence,
    report,
    receipt
  };
}

function readRecord(fixture) {
  return JSON.parse(fs.readFileSync(fixture.transportFile, "utf8"));
}

test("v2 records require controllerLease and fail with the bounded record code", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-controller-lease-required-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-controller-lease-required",
    events: [event(1, "started", 0)],
  });
  const record = readRecord(fixture);
  delete record.controllerLease;
  fs.writeFileSync(fixture.transportFile, JSON.stringify(record), { mode: 0o600 });
  assert.throws(
    () => confirmHostTransportActivation(fixture),
    (error) => error?.code === "host_transport_record_invalid",
  );
});

function writeStaticTransport({ root, handle, events, publication = publicationFixture(), exitCode = null,
  controllerLease = { phase: "activation_confirmed" } }) {
  if (process.platform !== "win32") fs.chmodSync(root, 0o700);
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
    createdAt: new Date(0).toISOString(),
    reportingContext: reportingContextFixture(),
    publication,
    controllerLease
  };
  fs.writeFileSync(transportFile, JSON.stringify(record), { mode: 0o600 });
  fs.writeFileSync(record.eventsFile, events.map((event) => JSON.stringify(event)).join("\n") + "\n", { mode: 0o600 });
  if (exitCode !== null) fs.writeFileSync(record.exitFile, `${exitCode}\n`, { mode: 0o600 });
  return { transportFile, processHandle: handle, record };
}

test("controller activation proof returns only the exact closed plugin shape", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-controller-confirm-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-controller-confirm",
    events: [event(1, "activation_confirmed")],
    controllerLease: { phase: "activation_confirmed" },
  });
  assert.deepEqual(confirmHostTransportActivation(fixture), {
    schemaVersion: "acp-host-controller-lease.v1",
    type: "host_transport_activation_confirmed",
    processHandle: fixture.processHandle,
  });
  assert.throws(() => confirmHostTransportActivation({ ...fixture, processHandle: "wrong-handle" }),
    /host_transport_handle_mismatch|host_transport_activation_not_confirmed/u);
  fixture.record.controllerLease.phase = "prepared";
  fs.writeFileSync(fixture.transportFile, JSON.stringify(fixture.record), { mode: 0o600 });
  assert.throws(() => confirmHostTransportActivation(fixture), /host_transport_activation_not_confirmed/u);
});

test("preactivation abort stops the exact session, seals atomically, and is idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-controller-abort-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-controller-abort",
    events: [event(1, "activation_required")],
    controllerLease: { phase: "prepared" },
  });
  const calls = [];
  const dependencies = { runTmux(args) {
    calls.push(args);
    return args[0] === "has-session"
      ? { status: 0, stdout: "", stderr: "" }
      : { status: 0, stdout: "", stderr: "" };
  } };
  const expected = {
    schemaVersion: "acp-host-controller-lease.v1",
    type: "host_transport_preactivation_aborted",
    processHandle: fixture.processHandle,
  };
  assert.deepEqual(abortHostTransportPreactivation(fixture, dependencies), expected);
  assert.deepEqual(abortHostTransportPreactivation(fixture, dependencies), expected);
  assert.deepEqual(calls, [
    ["has-session", "-t", `=${fixture.processHandle}`],
    ["kill-session", "-t", `=${fixture.processHandle}`],
  ]);
  assert.equal(readRecord(fixture).controllerLease.phase, "preactivation_aborted");
});

test("activate-vs-abort fence and uncertain or started evidence deny preactivation abort", () => {
  for (const [name, phase, events, dependencies] of [
    ["activation-in-progress", "activation_in_progress", [event(1, "activation_required")], ACTIVE_TMUX],
    ["started", "prepared", [event(1, "activation_required"), event(2, "started")], ACTIVE_TMUX],
    ["uncertain-dead", "prepared", [event(1, "activation_required")], DEAD_TMUX],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `acp-controller-deny-${name}-`));
    const fixture = writeStaticTransport({ root, handle: `acp-controller-${name}`,
      events, controllerLease: { phase } });
    assert.throws(() => abortHostTransportPreactivation(fixture, dependencies),
      /host_transport_preactivation_abort_denied/u, name);
    assert.equal(readRecord(fixture).controllerLease.phase, phase);
  }
});

test("an uncertain activation write remains fenced against preactivation abort", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-controller-write-race-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-controller-write-race",
    events: [event(1, "activation_required")],
    controllerLease: { phase: "prepared" },
  });
  const dependencies = { runTmux(args) {
    if (args[0] === "paste-buffer") return { status: 1, stdout: "", stderr: "uncertain" };
    return { status: 0, stdout: "", stderr: "" };
  } };
  await assert.rejects(activateHostTransport(fixture, dependencies),
    /host_transport_activation_write_failed/u);
  assert.equal(readRecord(fixture).controllerLease.phase, "activation_in_progress");
  assert.throws(() => abortHostTransportPreactivation(fixture, dependencies),
    /host_transport_preactivation_abort_denied/u);
});

test("an exact supervisor rejection after the activation write permits running preactivation cleanup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-controller-rejected-running-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-controller-rejected-running",
    events: [activationRequiredEvent()],
    controllerLease: { phase: "prepared" },
  });
  const calls = [];
  const dependencies = { runTmux(args) {
    calls.push(args);
    if (args[0] === "paste-buffer") {
      fs.appendFileSync(fixture.record.eventsFile,
        JSON.stringify(supervisorErrorEvent()) + "\n");
    }
    return { status: 0, stdout: "", stderr: "" };
  } };

  await assert.rejects(activateHostTransport(fixture, dependencies),
    /host_transport_activation_rejected/u);
  assert.equal(readRecord(fixture).controllerLease.phase, "activation_in_progress");
  assert.equal(abortHostTransportPreactivation(fixture, dependencies).type,
    "host_transport_preactivation_aborted");
  assert.equal(abortHostTransportPreactivation(fixture, dependencies).type,
    "host_transport_preactivation_aborted");
  assert.equal(readRecord(fixture).controllerLease.phase, "preactivation_aborted");
  assert.equal(calls.filter((args) => args[0] === "kill-session" &&
    args[2] === `=${fixture.processHandle}`).length, 1);
});

test("unknown, malformed, and mixed activation evidence keeps an in-progress abort denied", () => {
  const cases = [
    ["unknown", [activationRequiredEvent(), event(2, "unknown_control")]],
    ["activation-confirmed", [activationRequiredEvent(), event(2, "activation_confirmed"),
      supervisorErrorEvent(3)]],
    ["after-error", [activationRequiredEvent(), supervisorErrorEvent(), event(3, "started")]],
    ["error-extra-field", [activationRequiredEvent(), supervisorErrorEvent(2, { detail: "private" })]],
    ["out-of-order-time", [activationRequiredEvent(2000), supervisorErrorEvent(2, {}, 1000)]],
  ];
  for (const [name, events] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `acp-controller-mixed-${name}-`));
    const fixture = writeStaticTransport({
      root,
      handle: `acp-controller-mixed-${name}`,
      events,
      controllerLease: { phase: "activation_in_progress" },
    });
    assert.throws(() => abortHostTransportPreactivation(fixture, ACTIVE_TMUX),
      /host_transport_preactivation_abort_denied/u, name);
    assert.equal(readRecord(fixture).controllerLease.phase, "activation_in_progress");
  }
});

test("an exact supervisor rejection with its mapped preactivation exit can be aborted", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-controller-rejected-exit-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-controller-rejected-exit",
    events: [activationRequiredEvent(), supervisorErrorEvent()],
    exitCode: 22,
    controllerLease: { phase: "activation_in_progress" },
  });
  assert.equal(abortHostTransportPreactivation(fixture, DEAD_TMUX).type,
    "host_transport_preactivation_aborted");
  assert.equal(readRecord(fixture).controllerLease.phase, "preactivation_aborted");

  const wrongRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-controller-rejected-wrong-exit-"));
  const wrongExit = writeStaticTransport({
    root: wrongRoot,
    handle: "acp-controller-rejected-wrong-exit",
    events: [activationRequiredEvent(), supervisorErrorEvent()],
    exitCode: 64,
    controllerLease: { phase: "activation_in_progress" },
  });
  assert.throws(() => abortHostTransportPreactivation(wrongExit, DEAD_TMUX),
    /host_transport_preactivation_abort_denied/u);
  assert.equal(readRecord(wrongExit).controllerLease.phase, "activation_in_progress");
});

test("coordinator rollback releases a registered lease after exact supervisor preactivation rejection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-controller-coordinator-rollback-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-controller-coordinator-rollback",
    events: [activationRequiredEvent(), supervisorErrorEvent()],
    exitCode: 22,
    controllerLease: { phase: "activation_in_progress" },
  });
  const calls = [];
  let declarationKey;
  await assert.rejects(runReportControllerPreparation({
    roundIndex: 1,
    destination: { channel: "discord", accountId: "account-example",
      conversationId: CONTROL_CONVERSATION_ID },
    reportPumpEntry: path.join(root, "acp-report-pump.mjs"),
    hostTransportEntry: path.join(root, "acp-host-transport.mjs"),
  }, {
    randomBytes: () => Buffer.alloc(32, 0xab),
    randomUUID: () => "coordinator-job",
    async createAutomation(call) {
      calls.push("create");
      assert.equal(Object.hasOwn(call.job, "id"), false);
      assert.equal(call.job.enabled, false);
      declarationKey = call.job.declarationKey;
      return { created: true, job: { id: COORDINATOR_JOB_ID, declarationKey, enabled: false } };
    },
    // The full persisted job the real update boundary answers with.
    async armAutomation(call) {
      calls.push("arm");
      assert.equal(call.id, COORDINATOR_JOB_ID);
      return {
        id: COORDINATOR_JOB_ID,
        declarationKey,
        name: "ACP report controller",
        enabled: true,
        sessionTarget: "isolated",
        deleteAfterRun: false,
        schedule: { kind: "every", everyMs: 600000, anchorMs: 1756900000000 },
        payload: call.job.payload,
        delivery: { mode: "none" },
      };
    },
    async bindReporting() { calls.push("bind"); return {}; },
    async sendStartReceipt() { calls.push("start"); return {}; },
    async assemble() { calls.push("assemble"); return {}; },
    async prepare() { calls.push("prepare"); return fixture; },
    async registerController() { calls.push("register"); return { status: "prepared" }; },
    async activate() { calls.push("activate"); throw new Error("preactivation rejection"); },
    async removeAutomation() { calls.push("remove"); return { removed: true }; },
    async abortController() {
      calls.push("abort");
      const result = abortHostTransportPreactivation(fixture, DEAD_TMUX);
      return { status: result.type === "host_transport_preactivation_aborted" ? "aborted" : "invalid" };
    },
    async commitController() { assert.fail("commit must not run"); },
    async retainRecovery() { assert.fail("recovery must not run"); },
  }), (error) => error instanceof AcpReportControllerPreparationError &&
    error.code === "report_controller_preparation_failed");
  assert.deepEqual(calls, ["create", "arm", "bind", "start", "assemble", "prepare", "register",
    "activate", "remove", "abort"]);
  assert.equal(readRecord(fixture).controllerLease.phase, "preactivation_aborted");
});

test("preactivation mapped launcher exit can be durably aborted without PID inference", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-controller-mapped-exit-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-controller-mapped-exit",
    events: [{ schemaVersion: "acp-discord-orchestrator.v1", type: "launcher_error", code: "launcher_failed" }],
    exitCode: 22,
    controllerLease: { phase: "prepared" },
  });
  assert.equal(abortHostTransportPreactivation(fixture, DEAD_TMUX).type,
    "host_transport_preactivation_aborted");
  assert.equal(readRecord(fixture).controllerLease.phase, "preactivation_aborted");
});

function event(sequence, type = "activity", timestampMs = sequence * 1000, extra = {}) {
  return {
    schemaVersion: "acp-discord-orchestrator.v1",
    type,
    sequence,
    runId: "run-publication-test",
    requestId: "request-publication-test",
    timestamp: new Date(timestampMs).toISOString(),
    elapsedMs: timestampMs,
    ...extra
  };
}

function activationRequiredEvent(timestampMs = 1000) {
  return event(1, "activation_required", timestampMs, {
    activationSchemaVersion: "acp-host-activation.v1",
  });
}

function supervisorErrorEvent(sequence = 2, extra = {}, timestampMs = sequence * 1000) {
  return event(sequence, "supervisor_error", timestampMs, {
    code: "host_activation_rejected",
    ...extra,
  });
}

const ACTIVE_TMUX = { runTmux() { return { status: 0, stdout: "", stderr: "" }; } };
const DEAD_TMUX = { runTmux() { return { status: 1, stdout: "", stderr: "" }; } };

function tmuxAvailable() {
  const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  return result.status === 0;
}

function writeFixture(root, { reportingSchemaVersion } = {}) {
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
    async setConfigOption() {},
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
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
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
      model: "gpt-5.6-sol[medium]",
      ...(reportingSchemaVersion ? { schemaVersion: reportingSchemaVersion } : {})
    }),
    allowKinds: ["read"],
    runtimeModule: runtimeFile
  }, null, 2) + "\n", { mode: 0o600 });
  return { configFile, responseFile, stateDir };
}

async function waitForExit(input) {
  let prior;
  for (let index = 0; index < 100; index += 1) {
    const nowMs = Date.now();
    const status = statusHostTransport({
      ...input,
      ...(prior ? { serviceCursorAck: serviceAck(prior, nowMs) } : {})
    }, { nowMs });
    prior = status;
    if (status.status === "terminal_publication_pending") {
      const claim = claimAndBegin(input, { nowMs });
      const report = canonicalReport("terminal", {
        ...claim.identity,
        status: claim.terminalStatus
      });
      acknowledgeHostTransportReport(
        ackInput(input, claim, report, reportReceipt("terminal", report, "100000000000000099", nowMs)),
        { nowMs }
      );
      const closedAt = nowMs + 1;
      return statusHostTransport({
        ...input,
        serviceCursorAck: serviceAck(status, closedAt)
      }, { nowMs: closedAt });
    }
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

test("prepare binds Codex report acknowledgements to the composed public model identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-transport-reporting-model-"));
  const fixture = writeFixture(root);
  const expectedHandle = "acp-111111112222333344445555";
  const prepared = prepareHostTransport({ configFile: fixture.configFile }, {
    environment: { ...process.env, CODEX_PATH: process.execPath },
    randomUUID: () => "11111111-2222-3333-4444-555555555555",
    runTmux(args) {
      if (args[0] === "-V") {
        return { status: 0, stdout: "tmux 3.5a\n", stderr: "" };
      }
      assert.equal(args[0], "new-session");
      return { status: 0, stdout: `${expectedHandle}\n`, stderr: "" };
    }
  });
  const config = JSON.parse(fs.readFileSync(fixture.configFile, "utf8"));
  const record = JSON.parse(fs.readFileSync(prepared.transportFile, "utf8"));
  assert.equal(config.model, "gpt-5.6-sol");
  assert.equal(config.reasoningEffort, "medium");
  assert.equal(record.reportingContext.model, "gpt-5.6-sol[medium]");
  assert.equal(
    record.reportingContext.model,
    config.reporting.startMessage.match(/`([^`]+)`/)[1]
  );
  // A v2 watchdog config stays accepted as the bounded migration path: the
  // record starts unbound and binds the pump job on its first claim instead.
  assert.equal(record.publication.pumpJobId, null);
});

test("prepare binds the acp-reporting-v3 pump job identity into the transport record", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-transport-pump-bind-"));
  const fixture = writeFixture(root, { reportingSchemaVersion: "acp-reporting-v3" });
  const expectedHandle = "acp-999911112222333344445555";
  const prepared = prepareHostTransport({ configFile: fixture.configFile }, {
    environment: { ...process.env, CODEX_PATH: process.execPath },
    randomUUID: () => "99991111-2222-3333-4444-555555555555",
    runTmux(args) {
      if (args[0] === "-V") {
        return { status: 0, stdout: "tmux 3.5a\n", stderr: "" };
      }
      return { status: 0, stdout: `${expectedHandle}\n`, stderr: "" };
    }
  });
  const config = JSON.parse(fs.readFileSync(fixture.configFile, "utf8"));
  assert.equal(config.reporting.schemaVersion, "acp-reporting-v3");
  assert.equal(config.reporting.reportPump.enabled, true);
  assert.equal("watchdog" in config.reporting, false);
  const record = JSON.parse(fs.readFileSync(prepared.transportFile, "utf8"));
  assert.equal(record.publication.pumpJobId, PUMP_JOB_ID);
});

test("prepare applies the shared report-pump id rule before writing transport state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-transport-pump-id-invalid-"));
  if (process.platform !== "win32") fs.chmodSync(root, 0o700);
  const configFile = path.join(root, "run.json");
  fs.writeFileSync(configFile, "{}\n", { mode: 0o600 });
  assert.throws(() => prepareHostTransport({ configFile }, {
    statFile: () => ({ isSymbolicLink: () => false, isFile: () => true, mode: 0o755 }),
    runTmux: () => ({ status: 0, stdout: "tmux 3.6a\n", stderr: "" }),
    loadConfig: () => ({ reporting: { reportPump: { id: "invalid job id" } } }),
  }), /host_transport_pump_job_invalid/u);
  assert.deepEqual(fs.readdirSync(root), ["run.json"]);
});

test("prepare fails closed when an injected Codex config omits or invalidly supplies reporting identity selections", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-transport-injected-config-"));
  const configFile = path.join(root, "run.json");
  fs.writeFileSync(configFile, "{}\n", { mode: 0o600 });
  const shared = {
    agent: "codex",
    stateDir: root,
    reporting: {
      roundIndex: 1,
      repository: "openclaw-skills",
      branch: "fix/acp-codex-reasoning-smoke"
    },
    lifecycle: { controlConversationId: CONTROL_CONVERSATION_ID }
  };
  const cases = [
    ["missing model", { model: undefined, reasoningEffort: "medium" }, "invalid_model"],
    ["invalid model", { model: "not a model", reasoningEffort: "medium" }, "invalid_model"],
    ["missing reasoning", { model: "test-model", reasoningEffort: undefined }, "invalid_reasoning_effort"],
    ["invalid reasoning", { model: "test-model", reasoningEffort: "not an effort" }, "invalid_reasoning_effort"]
  ];
  for (const [name, selections, expected] of cases) {
    assert.throws(() => prepareHostTransport({ configFile }, {
      loadConfig() {
        return { ...shared, ...selections };
      },
      runTmux(args) {
        assert.deepEqual(args, ["-V"]);
        return { status: 0, stdout: "tmux 3.5a\n", stderr: "" };
      }
    }), { message: expected, code: expected }, name);
  }
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
    createdAt: new Date().toISOString(),
    reportingContext: reportingContextFixture(),
    publication: publicationFixture(),
    controllerLease: { phase: "activation_confirmed" }
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
    createdAt: new Date().toISOString(),
    reportingContext: reportingContextFixture(),
    publication: publicationFixture(),
    controllerLease: { phase: "activation_confirmed" }
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
    afterSequence: first.lastSequence,
    serviceCursorAck: serviceAck(first, Date.now())
  }, { ...dependencies, nowMs: Date.now() });
  assert.equal(second.events.length, 2);
  assert.equal(second.truncated, false);
  assert.equal(second.lastSequence, 66);
});

test("first cadence is claimable at exactly 600 seconds and freezes later evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-publication-cadence-"));
  const dueAt = REPORT_CADENCE_MS;
  const fixture = writeStaticTransport({
    root,
    handle: "acp-publication-cadence",
    events: [event(1, "started", 0), event(2, "activity", dueAt)],
    publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
  });
  const early = claimHostTransportReport(claimInput(fixture), {
    ...ACTIVE_TMUX,
    nowMs: dueAt - 1,
    randomUUID: () => "before"
  });
  assert.equal(early.status, "none_due");
  const due = claimHostTransportReport(claimInput(fixture), {
    ...ACTIVE_TMUX,
    nowMs: dueAt,
    randomUUID: () => "due"
  });
  assert.equal(due.status, "claimed");
  assert.equal(due.reportKind, "intermediate");
  assert.equal(due.cadence, 1);
  assert.equal(due.requiredAt, new Date(dueAt).toISOString());
  assert.deepEqual(due.identity, {
    agent: "codex",
    model: "test-model[medium]",
    roundIndex: 1,
    repository: "openclaw-skills",
    branch: "fix/acp-report-publication-state-machine"
  });

  fs.appendFileSync(fixture.record.eventsFile, JSON.stringify(event(3, "progress", dueAt + 1)) + "\n");
  const blocked = statusHostTransport(fixture, {
    ...ACTIVE_TMUX,
    nowMs: dueAt + 1,
    randomUUID: () => "blocked"
  });
  assert.equal(blocked.reportPublication.state, "publication_pending");
  assert.equal(blocked.reportPublication.deliveryState, "claim_acquired");
  assert.deepEqual(blocked.events.map((item) => item.sequence), [1, 2]);
  assert.equal(blocked.lastSequence, 2);
  const beyond = statusHostTransport({
    ...fixture,
    afterSequence: blocked.lastSequence,
    serviceCursorAck: serviceAck(blocked, dueAt + 2)
  }, { ...ACTIVE_TMUX, nowMs: dueAt + 2, randomUUID: () => "beyond" });
  assert.deepEqual(beyond.events, []);
  assert.equal(beyond.lastSequence, 2);
});

test("report receipt validation stays blocked until exact destination delivery is acknowledged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-publication-receipt-"));
  const dueAt = REPORT_CADENCE_MS;
  const fixture = writeStaticTransport({
    root,
    handle: "acp-publication-receipt",
    events: [event(1, "started", 0)],
    publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
  });
  const claim = claimAndBegin(fixture, { ...ACTIVE_TMUX, nowMs: dueAt, randomUUID: () => "receipt" });
  const report = canonicalReport("intermediate");
  const base = ackInput(fixture, claim, report, undefined);
  const validReceipt = reportReceipt(
    "intermediate", report, "100000000000000010", dueAt
  );
  // Preserve Discord's explicit-offset microsecond wire spelling. It denotes
  // the same instant as the canonical private cadence anchor.
  validReceipt.deliveredAt = "1970-01-01T09:10:00.000000+09:00";
  assert.throws(() => acknowledgeHostTransportReport(base, { nowMs: dueAt }), /host_transport_report_receipt_invalid/);
  for (const deliveryStatus of ["failed", "queued", "pending", "", null, true]) {
    assert.throws(() => acknowledgeHostTransportReport({
      ...base,
      receipt: { ...validReceipt, deliveryStatus }
    }, { nowMs: dueAt }), /host_transport_report_receipt_invalid/);
  }
  assert.throws(() => acknowledgeHostTransportReport({ ...base, receipt: { ...validReceipt, conversationId: "999888777666555444" } }, { nowMs: dueAt }), /host_transport_report_receipt_invalid/);
  assert.throws(() => acknowledgeHostTransportReport({ ...base, receipt: { ...validReceipt, deliveredAt: "1970-01-01T00:10:00.0000001+00:00" } }, { nowMs: dueAt }), /host_transport_report_receipt_invalid/);
  assert.throws(() => acknowledgeHostTransportReport({ ...base, receipt: { ...validReceipt, deliveredAt: "1970-01-01T00:10:00.000000" } }, { nowMs: dueAt }), /host_transport_report_receipt_invalid/);
  assert.throws(() => acknowledgeHostTransportReport({ ...base, receipt: { ...validReceipt, deliveredAt: new Date(dueAt - REMOTE_PROVIDER_CLOCK_SKEW_MS - 1).toISOString() } }, { nowMs: dueAt }), /host_transport_report_receipt_stale/);
  const acked = acknowledgeHostTransportReport({ ...base, receipt: validReceipt }, { nowMs: dueAt });
  assert.deepEqual(acked, {
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    type: "host_transport_report_acknowledged",
    kind: "intermediate",
    cadence: 1,
    skippedCadences: 0
  });
  assert.equal(JSON.stringify(acked).includes(validReceipt.messageId), false);
  assert.throws(() => acknowledgeHostTransportReport({ ...base, receipt: validReceipt }, { nowMs: dueAt }), /host_transport_report_ack_duplicate/);

  const nextDue = dueAt + REPORT_CADENCE_MS;
  const persistedAfterAck = readRecord(fixture);
  assert.equal(persistedAfterAck.publication.requiredAt, new Date(dueAt).toISOString());
  assert.equal(persistedAfterAck.publication.nextDueAt, new Date(nextDue).toISOString());
  assert.equal(persistedAfterAck.publication.attempt, null);
  assert.equal(persistedAfterAck.publication.lastAttemptOutcome, "acknowledged");
  fs.appendFileSync(
    fixture.record.eventsFile,
    JSON.stringify(event(2, "activity", dueAt + 10, { elapsedMs: dueAt + 10 })) + "\n"
  );
  const unblocked = statusHostTransport(fixture, {
    ...ACTIVE_TMUX,
    nowMs: nextDue - 1,
    randomUUID: () => "unblocked"
  });
  assert.equal(unblocked.reportPublication.state, "receipt_acked");
  assert.equal(unblocked.reportPublication.deliveryState, "acknowledged");
  assert.equal(unblocked.events.at(-1).elapsedMs, dueAt + 10);
  const next = claimAndBegin(fixture, { ...ACTIVE_TMUX, nowMs: nextDue, randomUUID: () => "next" });
  assert.equal(next.cadence, 2);
  assert.equal(next.requiredAt, new Date(nextDue).toISOString());
  assert.throws(() => acknowledgeHostTransportReport(
    ackInput(fixture, next, report, { ...validReceipt, deliveredAt: new Date(nextDue).toISOString() }),
    { nowMs: nextDue }
  ), /host_transport_report_receipt_duplicate/);
});

test("report receipt freshness permits only bounded symmetric remote provider clock skew", () => {
  const dueAt = REPORT_CADENCE_MS;
  const receiptFor = (label, deliveredAt, nowMs = dueAt) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `acp-receipt-skew-${label}-`));
    const fixture = writeStaticTransport({
      root,
      handle: `acp-receipt-skew-${label}`,
      events: [event(1, "started", 0)],
      publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
    });
    const claim = claimAndBegin(fixture, {
      ...ACTIVE_TMUX,
      nowMs: dueAt,
      randomUUID: () => `receipt-${label}`
    });
    const report = canonicalReport("intermediate");
    return {
      input: ackInput(
        fixture,
        claim,
        report,
        reportReceipt("intermediate", report, "100000000000000011", deliveredAt)
      ),
      nowMs
    };
  };

  assert.equal(REMOTE_PROVIDER_CLOCK_SKEW_MS, 1000);
  for (const [label, offset] of [
    ["behind-bound", -REMOTE_PROVIDER_CLOCK_SKEW_MS],
    ["ahead-bound", REMOTE_PROVIDER_CLOCK_SKEW_MS]
  ]) {
    const { input, nowMs } = receiptFor(label, dueAt + offset);
    assert.equal(
      acknowledgeHostTransportReport(input, { nowMs }).type,
      "host_transport_report_acknowledged",
      label
    );
  }
  for (const [label, offset] of [
    ["behind-outside", -REMOTE_PROVIDER_CLOCK_SKEW_MS - 1],
    ["ahead-outside", REMOTE_PROVIDER_CLOCK_SKEW_MS + 1]
  ]) {
    const { input, nowMs } = receiptFor(label, dueAt + offset);
    assert.throws(
      () => acknowledgeHostTransportReport(input, { nowMs }),
      /host_transport_report_receipt_stale/,
      label
    );
  }

  const stale = receiptFor("five-minute-age", dueAt, dueAt + MAX_REPORT_RECEIPT_AGE_MS + 1);
  assert.throws(
    () => acknowledgeHostTransportReport(stale.input, { nowMs: stale.nowMs }),
    /host_transport_report_receipt_stale/
  );
});

test("private transport timestamps retain canonical millisecond UTC spelling", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-private-timestamp-canonical-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-private-timestamp-canonical",
    events: [event(1, "started", 0)],
    publication: publicationFixture({
      nextDueAt: "1970-01-01T00:10:00.000000+00:00"
    })
  });
  assert.throws(() => statusHostTransport(fixture, {
    ...ACTIVE_TMUX,
    nowMs: REPORT_CADENCE_MS
  }), /host_transport_record_invalid/);
});

test("intermediate acknowledgements accept both authorized success statuses and preserve elapsed cadence anchors", () => {
  const dueAt = REPORT_CADENCE_MS;
  const cases = [
    { label: "on-time", deliveredAt: dueAt, deliveryStatus: "sent", skipped: 0 },
    { label: "late", deliveredAt: dueAt + 4 * 60_000, deliveryStatus: "delivered", skipped: 0 },
    { label: "already-overdue", deliveredAt: dueAt + 11 * 60_000, deliveryStatus: "sent", skipped: 1 },
  ];
  for (const [index, scenario] of cases.entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `acp-cadence-anchor-${scenario.label}-`));
    const fixture = writeStaticTransport({
      root,
      handle: `acp-cadence-anchor-${scenario.label}`,
      events: [event(1, "started", 0)],
      publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
    });
    const claim = claimAndBegin(fixture, {
      ...ACTIVE_TMUX,
      nowMs: dueAt,
      randomUUID: () => `due-${scenario.label}`
    });
    const report = canonicalReport("intermediate");
    const acknowledged = acknowledgeHostTransportReport(ackInput(
      fixture,
      claim,
      report,
      reportReceipt(
        "intermediate",
        report,
        `1000000000000001${index + 1}`,
        scenario.deliveredAt,
        scenario.deliveryStatus
      )
    ), { nowMs: scenario.deliveredAt });
    assert.equal(acknowledged.skippedCadences, scenario.skipped, scenario.label);

    const persisted = readRecord(fixture);
    const expectedNextDueAt = new Date(
      dueAt + ((scenario.skipped + 1) * REPORT_CADENCE_MS)
    ).toISOString();
    assert.equal(persisted.publication.nextDueAt, expectedNextDueAt, scenario.label);
    assert.equal(persisted.publication.nextCadence, scenario.skipped + 2, scenario.label);

    const afterAck = statusHostTransport(fixture, {
      ...ACTIVE_TMUX,
      nowMs: scenario.deliveredAt,
      randomUUID: () => `after-${scenario.label}`
    });
    assert.equal(
      afterAck.reportPublication.state,
      "receipt_acked",
      scenario.label
    );
  }
});

test("intermediate claim binds 마지막 ACP 활동 to normalized ACP activity events and exposes no Δ result count", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-activity-instant-"));
  const dueAt = REPORT_CADENCE_MS;
  const fixture = writeStaticTransport({
    root,
    handle: "acp-activity-instant",
    events: [
      event(1, "activation_confirmed", 0),
      event(2, "started", 1000),
      // Completed read/edit/execute tool events are activity evidence and
      // must advance the activity instant — but they are not material
      // results, so they may never create a Δ count at this boundary.
      event(3, "activity", 120000, { activity: "tool", toolKind: "read", toolStatus: "completed" }),
      event(4, "activity", 180000, { activity: "tool", toolKind: "edit", toolStatus: "completed" }),
      event(5, "activity", 240000, { activity: "tool", toolKind: "execute", toolStatus: "completed" }),
      event(6, "activity", 300000, { activity: "model_output" }),
      // Timer-driven progress bookkeeping is later than every ACP event but
      // must not move the activity instant.
      event(7, "progress", 590000, { evidenceAgeMs: 290000 })
    ],
    publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
  });
  const due = claimHostTransportReport(claimInput(fixture), {
    ...ACTIVE_TMUX,
    nowMs: dueAt,
    randomUUID: () => "activity-due"
  });
  assert.equal(due.status, "claimed");
  assert.equal(due.lastAcpActivityAt, new Date(300000).toISOString());
  assert.equal("newResultDelta" in due, false);
  assert.equal("resultBaselineSequence" in readRecord(fixture).publication, false);

  // A later poll boundary alone does not move the activity instant.
  const polled = statusHostTransport(fixture, {
    ...ACTIVE_TMUX,
    nowMs: dueAt + 30000,
    randomUUID: () => "activity-poll"
  });
  assert.equal(polled.reportPublication.state, "publication_pending");
  assert.equal(polled.reportPublication.lastAcpActivityAt, new Date(300000).toISOString());

  // A later completed tool event advances the activity instant — and still
  // surfaces no Δ, because raw tool completion is never a material result.
  fs.appendFileSync(
    fixture.record.eventsFile,
    JSON.stringify(event(8, "activity", dueAt + 40000, { activity: "tool", toolKind: "execute", toolStatus: "completed" })) + "\n"
  );
  const advanced = statusHostTransport({
    ...fixture,
    afterSequence: polled.lastSequence,
    serviceCursorAck: serviceAck(polled, dueAt + 50000)
  }, { ...ACTIVE_TMUX, nowMs: dueAt + 50000, randomUUID: () => "activity-advanced" });
  assert.equal(advanced.reportPublication.lastAcpActivityAt, new Date(dueAt + 40000).toISOString());
  assert.equal("newResultDelta" in advanced.reportPublication, false);

  beginHostTransportReportDelivery({
    transportFile: fixture.transportFile,
    processHandle: fixture.processHandle,
    attemptId: due.attemptId,
    fence: due.fence
  }, { nowMs: dueAt + 50000 });
  const activityReport = canonicalReport("intermediate");
  acknowledgeHostTransportReport(ackInput(
    fixture,
    due,
    activityReport,
    reportReceipt("intermediate", activityReport, "100000000000000060", dueAt + 50000)
  ), { nowMs: dueAt + 50000 });
  // The delivery receipt keeps no result cursor and touches no activity
  // bookkeeping: the record's publication state stays free of any Δ
  // derivation source.
  const acked = readRecord(fixture);
  assert.equal("resultBaselineSequence" in acked.publication, false);

  const secondDue = 2 * REPORT_CADENCE_MS;
  const second = claimHostTransportReport(claimInput(fixture), {
    ...ACTIVE_TMUX,
    nowMs: secondDue,
    randomUUID: () => "activity-second"
  });
  assert.equal(second.cadence, 2);
  assert.equal(second.lastAcpActivityAt, new Date(dueAt + 40000).toISOString());
  assert.equal("newResultDelta" in second, false);
});

test("마지막 ACP 활동 stays fail-closed missing without a normalized ACP activity event", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-activity-missing-"));
  const dueAt = REPORT_CADENCE_MS;
  const fixture = writeStaticTransport({
    root,
    handle: "acp-activity-missing",
    events: [
      // Host lifecycle/control marks are not ACP activity and never
      // substitute for a missing activity instant.
      event(1, "activation_confirmed", 0),
      event(2, "started", 1000),
      event(3, "progress", 590000, { evidenceAgeMs: 589000 })
    ],
    publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
  });
  const due = claimHostTransportReport(claimInput(fixture), {
    ...ACTIVE_TMUX,
    nowMs: dueAt,
    randomUUID: () => "activity-missing"
  });
  assert.equal(due.status, "claimed");
  assert.equal(due.lastAcpActivityAt, null);
  assert.equal("newResultDelta" in due, false);
});

test("terminal supersedes an overdue intermediate and requires exact terminal acknowledgement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-publication-terminal-race-"));
  const dueAt = REPORT_CADENCE_MS;
  const fixture = writeStaticTransport({
    root,
    handle: "acp-terminal-race",
    events: [event(1, "started", 0), event(2, "activity", dueAt)],
    publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
  });
  const intermediate = claimAndBegin(fixture, { ...ACTIVE_TMUX, nowMs: dueAt, randomUUID: () => "middle" });
  fs.appendFileSync(fixture.record.eventsFile, JSON.stringify(event(3, "progress", dueAt + 1)) + "\n");
  fs.appendFileSync(fixture.record.eventsFile, JSON.stringify(event(4, "terminal", dueAt + 2, { status: "completed" })) + "\n");

  // Before the terminal claim, status reports the pending terminal without
  // minting anything; the frozen intermediate boundary still hides the newer
  // events.
  const observed = statusHostTransport(fixture, {
    ...ACTIVE_TMUX,
    nowMs: dueAt + 1,
    randomUUID: () => "observed"
  });
  assert.equal(observed.status, "terminal_publication_pending");
  assert.equal(observed.reportPublication.kind, "intermediate");
  assert.equal(observed.reportPublication.deliveryState, "delivery_pending");
  assert.equal(observed.lastSequence, 2);

  // The terminal claim supersedes the interrupted intermediate attempt
  // atomically: its delivery becomes an explicit uncertain outcome and
  // terminal cadence 0 is minted under a fresh fence.
  const terminal = claimAndBegin(fixture, { ...ACTIVE_TMUX, nowMs: dueAt + 2, randomUUID: () => "terminal" });
  assert.equal(terminal.reportKind, "terminal");
  assert.equal(terminal.cadence, 0);
  assert.equal(terminal.terminalStatus, "completed");
  assert.equal(terminal.fence, 2);
  assert.equal(readRecord(fixture).publication.lastAttemptOutcome, null);

  const terminalStatus = statusHostTransport({
    ...fixture,
    serviceCursorAck: serviceAck(observed, dueAt + 2)
  }, { ...ACTIVE_TMUX, nowMs: dueAt + 2, randomUUID: () => "terminal-status" });
  assert.equal(terminalStatus.status, "terminal_publication_pending");
  assert.equal(terminalStatus.reportPublication.kind, "terminal");
  assert.equal(terminalStatus.events.at(-1).type, "terminal");
  assert.equal(terminalStatus.events.some((normalizedEvent) => normalizedEvent.type === "progress"), false);
  assert.equal(terminalStatus.lastSequence, 2);

  const terminalReport = canonicalReport("terminal", { status: "completed" });
  const receipt = reportReceipt(
    "terminal", terminalReport, "100000000000000020", dueAt + 2
  );
  assert.throws(() => acknowledgeHostTransportReport({
    ...ackInput(fixture, intermediate, terminalReport, receipt),
    reportKind: "intermediate",
    cadence: 1
  }, { nowMs: dueAt + 2 }), /host_transport_report_ack_mismatch/);
  acknowledgeHostTransportReport(
    ackInput(fixture, terminal, terminalReport, receipt),
    { nowMs: dueAt + 2 }
  );
  const gap = statusHostTransport({
    ...fixture,
    afterSequence: terminalStatus.lastSequence,
    serviceCursorAck: serviceAck(terminalStatus, dueAt + 3)
  }, { ...ACTIVE_TMUX, nowMs: dueAt + 3, randomUUID: () => "gap" });
  assert.deepEqual(gap.events.map((item) => item.sequence), [3, 4]);
  assert.equal(gap.lastSequence, 4);
  for (const normalizedEvent of [...terminalStatus.events, ...gap.events]) {
    const serialized = JSON.stringify(normalizedEvent);
    assert.equal(serialized.includes(terminalStatus.serviceCursor), false);
    assert.equal(serialized.includes(terminal.reportId), false);
    assert.equal(serialized.includes(terminal.attemptId), false);
    assert.equal(serialized.includes(fixture.processHandle), false);
    assert.equal(serialized.includes(receipt.messageId), false);
    assert.equal(serialized.includes(PUMP_JOB_ID), false);
  }
});

test("terminal before ten minutes requires only terminal receipt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-publication-early-terminal-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-early-terminal",
    events: [event(1, "started", 0), event(2, "terminal", 599999, { status: "failed" })],
    publication: publicationFixture({ nextDueAt: new Date(REPORT_CADENCE_MS).toISOString() })
  });
  const claim = claimHostTransportReport(claimInput(fixture), {
    ...ACTIVE_TMUX,
    nowMs: 599999,
    randomUUID: () => "early"
  });
  assert.equal(claim.reportKind, "terminal");
  assert.equal(claim.cadence, 0);
  assert.equal(claim.terminalStatus, "failed");
  assert.equal(claim.elapsedMs, 599999);
});

test("exit reconciliation remains terminal-publication-pending until terminal receipt acknowledgement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-terminal-reconcile-"));
  if (process.platform !== "win32") fs.chmodSync(root, 0o700);
  const handle = "acp-terminal-reconcile";
  const terminalEvent = event(2, "terminal", 5000, { status: "completed" });
  const writer = createLifecycleLedger({
    stateDir: root,
    runId: terminalEvent.runId,
    requestId: terminalEvent.requestId,
    nowMs: 0
  });
  activateLifecycleLedger(writer, handle, 1);
  recordLifecycleEvent(writer, terminalEvent, { expectedExitCode: 0, force: true });
  const fixture = writeStaticTransport({
    root,
    handle,
    events: [event(1, "started", 1), terminalEvent],
    exitCode: 0
  });
  const nowMs = 5000;
  const status = statusHostTransport(fixture, {
    nowMs,
    randomUUID: () => "terminal-reconcile",
    runTmux() { return { status: 1, stdout: "", stderr: "" }; }
  });
  assert.equal(status.status, "terminal_publication_pending");
  assert.equal(reconcileHostTransport(fixture).status, "terminal_publication_pending");
  assert.equal(loadLifecycleLedger(writer.filePath).document.state, "terminal_intent");
  const claim = claimAndBegin(fixture, { ...DEAD_TMUX, nowMs, randomUUID: () => "terminal-claim" });
  const terminalReport = canonicalReport("terminal", { status: "completed" });
  acknowledgeHostTransportReport(ackInput(
    fixture,
    claim,
    terminalReport,
    reportReceipt("terminal", terminalReport, "100000000000000040", nowMs)
  ), { nowMs });
  assert.equal(reconcileHostTransport(fixture).status, "exit_reconciled");
});

test("terminal acknowledgement releases the attempt lease and directs pump self-cleanup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-terminal-cleanup-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-terminal-cleanup",
    events: [event(1, "started", 0), event(2, "terminal", 5000, { status: "completed" })],
    exitCode: 0
  });
  const nowMs = 5000;
  const claim = claimAndBegin(fixture, { ...DEAD_TMUX, nowMs, randomUUID: () => "cleanup" });
  const terminalReport = canonicalReport("terminal", { status: "completed" });
  acknowledgeHostTransportReport(ackInput(
    fixture,
    claim,
    terminalReport,
    reportReceipt("terminal", terminalReport, "100000000000000041", nowMs)
  ), { nowMs });

  const record = readRecord(fixture);
  assert.equal(record.publication.attempt, null);
  assert.equal(record.publication.attemptCount, 0);
  assert.equal(record.publication.lastAttemptOutcome, "acknowledged");

  // The next pump tick is told deterministically that publication is done and
  // that the automation must clean itself up.
  const done = claimHostTransportReport(claimInput(fixture), {
    ...DEAD_TMUX,
    nowMs: nowMs + 1,
    randomUUID: () => "cleanup-done"
  });
  assert.equal(done.status, "terminal_acked");

  // No lease or sibling-temp residue survives the completed flow.
  const residue = fs.readdirSync(root).filter((name) =>
    name.endsWith(".lock") || name.endsWith(".tmp"));
  assert.deepEqual(residue, []);
});

test("record mutations serialize on the exclusive lease and never steal a live lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-transport-lease-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-transport-lease",
    events: [event(1, "started", 0)]
  });
  const lockFile = `${fixture.transportFile}.lock`;
  fs.writeFileSync(lockFile, JSON.stringify({
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    type: "host_transport_lease",
    action: "status",
    ownerToken: "foreign-live-holder",
    acquiredAtMs: Date.now()
  }) + "\n", { mode: 0o600 });

  // A live foreign lease is never stolen: the bounded wait fails closed.
  assert.throws(() => statusHostTransport(fixture, {
    ...ACTIVE_TMUX,
    nowMs: 1000,
    lockWaitMs: 80
  }), /host_transport_lock_timeout/);
  assert.equal(fs.existsSync(lockFile), true);

  // An apparently stale lease also fails closed: pathname age is not identity,
  // and reclaiming it could unlink a fresh replacement in the compare/act gap.
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lockFile, old, old);
  assert.throws(() => statusHostTransport(fixture, {
    ...ACTIVE_TMUX,
    nowMs: 1000,
    lockWaitMs: 80,
  }), /host_transport_lock_timeout/);
  assert.equal(fs.readFileSync(lockFile, "utf8").includes("foreign-live-holder"), true);
});

test("stale-lock replacement race never unlinks the fresh owner or admits a writer", () => {
  const exists = () => {
    const error = new Error("exists");
    error.code = "EEXIST";
    throw error;
  };
  let sleeps = 0;
  let unlinkCalls = 0;
  let freshOwnerWasUnlinked = false;
  let observedOldLease = false;
  const startedAt = Date.now();
  assert.throws(() => acquireTransportLock("/private/fake-record.json", "status", {
    fileSystem: {
      writeFileSync: exists,
      lstatSync: () => {
        observedOldLease = true;
        // This is the old takeover boundary: the pathname now denotes a fresh
        // holder. The implementation must not perform any pathname deletion.
        return { mtimeMs: Date.now() };
      },
      unlinkSync() {
        unlinkCalls += 1;
        freshOwnerWasUnlinked = true;
      },
    },
    lockWaitMs: 35,
    lockStaleMs: 1,
    sleepMs(ms) {
      sleeps += 1;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
  }), /host_transport_lock_timeout/u);
  assert.equal(observedOldLease, true);
  assert.equal(unlinkCalls, 0);
  assert.equal(freshOwnerWasUnlinked, false);
  assert.ok(sleeps >= 1);
  assert.ok(Date.now() - startedAt < 500);
});

test("two concurrent claimers yield exactly one live claim", {
  skip: !tmuxAvailable(),
  timeout: 15000
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-concurrent-claim-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-concurrent-claim",
    events: [event(1, "started", 0), event(2, "terminal", 5000, { status: "completed" })],
    exitCode: 0
  });
  const writeClaimFile = (name, runToken) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
      action: "claim-report",
      transportFile: fixture.transportFile,
      processHandle: fixture.processHandle,
      jobId: PUMP_JOB_ID,
      runToken,
      destination: CONTROL_CONVERSATION_ID
    }), { mode: 0o600 });
    return file;
  };
  const run = (inputFile) => new Promise((resolve) => {
    const child = spawn(process.execPath, [TRANSPORT_CLI, "--input", inputFile], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const results = await Promise.all([
    run(writeClaimFile("claim-a.json", "pumprun-claimer-a")),
    run(writeClaimFile("claim-b.json", "pumprun-claimer-b"))
  ]);
  const winners = results.filter((result) => result.code === 0 &&
    JSON.parse(result.stdout).status === "claimed");
  const losers = results.filter((result) => result.code !== 0);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(JSON.parse(losers[0].stderr).code, "host_transport_report_claim_held");
  const record = readRecord(fixture);
  assert.equal(record.publication.fence, 1);
  assert.equal(record.publication.attemptCount, 1);
});

test("status observes but never mints; claim-report owns publication transitions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-status-vs-claim-"));
  const dueAt = REPORT_CADENCE_MS;
  const fixture = writeStaticTransport({
    root,
    handle: "acp-status-vs-claim",
    events: [event(1, "started", 0), event(2, "activity", dueAt)],
    publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
  });
  // A status poll at (and past) the due instant is pure observation: no
  // report identity is minted, no evidence boundary freezes.
  const atDue = statusHostTransport(fixture, { ...ACTIVE_TMUX, nowMs: dueAt, randomUUID: () => "observe" });
  assert.equal(atDue.reportPublication, undefined);
  assert.equal(atDue.lastSequence, 2);
  assert.equal(readRecord(fixture).publication.kind, null);

  const claim = claimHostTransportReport(claimInput(fixture), {
    ...ACTIVE_TMUX,
    nowMs: dueAt,
    randomUUID: () => "claim-owns"
  });
  assert.equal(claim.status, "claimed");
  assert.equal(claim.reportKind, "intermediate");
  assert.equal(claim.cadence, 1);
  assert.equal(claim.fence, 1);

  // Status between claim and acknowledgement reflects the stored obligation
  // and cannot re-mint, replace, or advance it.
  const after = statusHostTransport({
    ...fixture,
    serviceCursorAck: serviceAck(atDue, dueAt + 1)
  }, { ...ACTIVE_TMUX, nowMs: dueAt + 1, randomUUID: () => "observe-after" });
  assert.equal(after.reportPublication.state, "publication_pending");
  assert.equal(after.reportPublication.deliveryState, "claim_acquired");
  assert.equal(after.reportPublication.reportId, claim.reportId);
  assert.equal(readRecord(fixture).publication.fence, 1);

  // A second claimer against the live attempt fails closed.
  assert.throws(() => claimHostTransportReport(claimInput(fixture), {
    ...ACTIVE_TMUX,
    nowMs: dueAt + 2,
    randomUUID: () => "claim-second"
  }), /host_transport_report_claim_held/);
});

test("an expired attempt is superseded with an explicit outcome and its stale fence can no longer act", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-stale-fence-"));
  const dueAt = REPORT_CADENCE_MS;
  const fixture = writeStaticTransport({
    root,
    handle: "acp-stale-fence",
    events: [event(1, "started", 0)],
    publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
  });
  // First claim hands off to delivery, then disappears (simulated crash
  // after the Discord handoff, before receipt persistence).
  const first = claimAndBegin(fixture, { ...ACTIVE_TMUX, nowMs: dueAt, randomUUID: () => "fence-1" });
  assert.equal(first.fence, 1);

  // While the attempt lease is live, no re-claim is possible.
  assert.throws(() => claimHostTransportReport(claimInput(fixture), {
    ...ACTIVE_TMUX,
    nowMs: dueAt + REPORT_ATTEMPT_TTL_MS - 1,
    randomUUID: () => "fence-live"
  }), /host_transport_report_claim_held/);

  const retryAt = dueAt + REPORT_ATTEMPT_TTL_MS;
  const second = claimHostTransportReport(claimInput(fixture), {
    ...ACTIVE_TMUX,
    nowMs: retryAt,
    randomUUID: () => "fence-2"
  });
  assert.equal(second.status, "claimed");
  assert.equal(second.fence, 2);
  assert.equal(second.attemptCount, 2);
  // Same obligation, fresh attempt: the report identity is unchanged, and
  // the interrupted delivery is recorded as explicitly uncertain — never
  // inferred as success.
  assert.equal(second.reportId, first.reportId);
  assert.equal(readRecord(fixture).publication.lastAttemptOutcome, "uncertain");

  // The superseded fence can neither hand off nor acknowledge.
  assert.throws(() => beginHostTransportReportDelivery({
    transportFile: fixture.transportFile,
    processHandle: fixture.processHandle,
    attemptId: first.attemptId,
    fence: first.fence
  }, { nowMs: retryAt }), /host_transport_report_fencing_stale/);
  const report = canonicalReport("intermediate");
  assert.throws(() => acknowledgeHostTransportReport(ackInput(
    fixture,
    first,
    report,
    reportReceipt("intermediate", report, "100000000000000071", retryAt)
  ), { nowMs: retryAt }), /host_transport_report_fencing_stale/);

  // The fresh fence completes normally.
  beginHostTransportReportDelivery({
    transportFile: fixture.transportFile,
    processHandle: fixture.processHandle,
    attemptId: second.attemptId,
    fence: second.fence
  }, { nowMs: retryAt });
  acknowledgeHostTransportReport(ackInput(
    fixture,
    second,
    report,
    reportReceipt("intermediate", report, "100000000000000072", retryAt)
  ), { nowMs: retryAt });
  assert.equal(readRecord(fixture).publication.lastAttemptOutcome, "acknowledged");
});

test("a claim that never reached delivery is superseded as an explicit missing outcome", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-missing-outcome-"));
  const dueAt = REPORT_CADENCE_MS;
  const fixture = writeStaticTransport({
    root,
    handle: "acp-missing-outcome",
    events: [event(1, "started", 0)],
    publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
  });
  const first = claimHostTransportReport(claimInput(fixture), {
    ...ACTIVE_TMUX,
    nowMs: dueAt,
    randomUUID: () => "missing-1"
  });
  assert.equal(first.status, "claimed");
  // Crash before begin-delivery: no Discord handoff can have happened, so
  // the superseding claim records the safe, explicit `missing` outcome.
  const second = claimHostTransportReport(claimInput(fixture), {
    ...ACTIVE_TMUX,
    nowMs: dueAt + REPORT_ATTEMPT_TTL_MS,
    randomUUID: () => "missing-2"
  });
  assert.equal(second.status, "claimed");
  assert.equal(readRecord(fixture).publication.lastAttemptOutcome, "missing");
  // An attempt that expired without the delivery_pending handoff can no
  // longer begin delivery even with its exact identity.
  assert.throws(() => beginHostTransportReportDelivery({
    transportFile: fixture.transportFile,
    processHandle: fixture.processHandle,
    attemptId: first.attemptId,
    fence: first.fence
  }, { nowMs: dueAt + REPORT_ATTEMPT_TTL_MS }), /host_transport_report_fencing_stale/);
});

test("publication attempts are bounded per report obligation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-attempts-bound-"));
  const dueAt = REPORT_CADENCE_MS;
  const fixture = writeStaticTransport({
    root,
    handle: "acp-attempts-bound",
    events: [event(1, "started", 0)],
    publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
  });
  for (let attempt = 1; attempt <= MAX_REPORT_PUBLICATION_ATTEMPTS; attempt += 1) {
    const claim = claimHostTransportReport(claimInput(fixture), {
      ...ACTIVE_TMUX,
      nowMs: dueAt + (attempt - 1) * REPORT_ATTEMPT_TTL_MS,
      randomUUID: () => `bounded-${attempt}`
    });
    assert.equal(claim.status, "claimed");
    assert.equal(claim.attemptCount, attempt);
  }
  assert.throws(() => claimHostTransportReport(claimInput(fixture), {
    ...ACTIVE_TMUX,
    nowMs: dueAt + MAX_REPORT_PUBLICATION_ATTEMPTS * REPORT_ATTEMPT_TTL_MS,
    randomUUID: () => "bounded-exhausted"
  }), /host_transport_report_attempts_exhausted/);
  const record = readRecord(fixture);
  assert.equal(record.publication.fence, MAX_REPORT_PUBLICATION_ATTEMPTS);
  assert.equal(record.publication.attemptCount, MAX_REPORT_PUBLICATION_ATTEMPTS);
});

test("claim-report binds and enforces the exact scheduler job identity and destination", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-pump-identity-"));
  const bound = writeStaticTransport({
    root,
    handle: "acp-pump-bound",
    events: [event(1, "started", 0)],
    publication: publicationFixture({ pumpJobId: "acp-report-pump-original" })
  });
  assert.throws(() => claimHostTransportReport(claimInput(bound, { jobId: "acp-report-pump-imposter" }), {
    ...ACTIVE_TMUX,
    nowMs: 1000
  }), /host_transport_pump_job_mismatch/);
  assert.throws(() => claimHostTransportReport(claimInput(bound, {
    jobId: "acp-report-pump-original",
    destination: "999888777666555444"
  }), { ...ACTIVE_TMUX, nowMs: 1000 }), /host_transport_pump_destination_mismatch/);

  // A legacy (v1/v2 watchdog config) record binds the first claiming job and
  // rejects every other job thereafter.
  const legacy = writeStaticTransport({
    root,
    handle: "acp-pump-legacy",
    events: [event(1, "started", 0)]
  });
  const first = claimHostTransportReport(claimInput(legacy), { ...ACTIVE_TMUX, nowMs: 1000 });
  assert.equal(first.status, "none_due");
  assert.equal(readRecord(legacy).publication.pumpJobId, PUMP_JOB_ID);
  assert.throws(() => claimHostTransportReport(claimInput(legacy, { jobId: "acp-report-pump-second" }), {
    ...ACTIVE_TMUX,
    nowMs: 1001
  }), /host_transport_pump_job_mismatch/);
});

test("a dead session without exit or terminal evidence halts publication as tracking_lost", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-tracking-lost-"));
  const dueAt = REPORT_CADENCE_MS;
  const fixture = writeStaticTransport({
    root,
    handle: "acp-tracking-lost",
    events: [event(1, "started", 0)],
    publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
  });
  const lost = claimHostTransportReport(claimInput(fixture), {
    ...DEAD_TMUX,
    nowMs: dueAt,
    randomUUID: () => "lost"
  });
  assert.equal(lost.status, "tracking_lost");
  const record = readRecord(fixture);
  assert.equal(record.publication.halted, "tracking_lost");
  // Even an overdue cadence mints nothing after tracking loss.
  assert.equal(record.publication.kind, null);

  // Tracking loss is sticky: publication stays stopped and is never resumed
  // or relaunched by a later claim, handoff, or acknowledgement.
  const again = claimHostTransportReport(claimInput(fixture), {
    ...ACTIVE_TMUX,
    nowMs: dueAt + 1,
    randomUUID: () => "lost-again"
  });
  assert.equal(again.status, "tracking_lost");
  assert.throws(() => beginHostTransportReportDelivery({
    transportFile: fixture.transportFile,
    processHandle: fixture.processHandle,
    attemptId: "attempt-any",
    fence: 1
  }, { nowMs: dueAt + 2 }), /host_transport_publication_halted/);
  assert.throws(() => acknowledgeHostTransportReport({
    transportFile: fixture.transportFile,
    processHandle: fixture.processHandle,
    reportId: "report-any",
    reportKind: "intermediate",
    cadence: 1,
    attemptId: "attempt-any",
    fence: 1,
    report: canonicalReport("intermediate"),
    receipt: {}
  }, { nowMs: dueAt + 2 }), /host_transport_publication_halted/);

  const status = statusHostTransport(fixture, {
    ...DEAD_TMUX,
    nowMs: dueAt + 3,
    randomUUID: () => "lost-status"
  });
  assert.equal(status.status, "unavailable");
  assert.equal(status.publicationHalted, "tracking_lost");
});

test("a dead session with mapped exit but no terminal evidence also halts as tracking_lost", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-tracking-lost-mapped-exit-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-tracking-lost-mapped-exit",
    events: [event(1, "started", 0)],
    exitCode: 22,
    publication: publicationFixture({ nextDueAt: new Date(REPORT_CADENCE_MS).toISOString() }),
  });
  const result = claimHostTransportReport(claimInput(fixture), {
    ...DEAD_TMUX,
    nowMs: REPORT_CADENCE_MS,
  });
  assert.equal(result.status, "tracking_lost");
  assert.equal(readRecord(fixture).publication.halted, "tracking_lost");
});

test("control service cursor prevents starvation and accepts only fresh exact-conversation attestation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-service-cursor-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-service-cursor",
    events: [event(1, "started", 0)]
  });
  const first = statusHostTransport(fixture, { ...ACTIVE_TMUX, nowMs: 1000, randomUUID: () => "first" });
  assert.throws(() => statusHostTransport(fixture, { ...ACTIVE_TMUX, nowMs: 1001 }), /host_transport_service_cursor_invalid/);
  assert.throws(() => statusHostTransport({
    ...fixture,
    serviceCursorAck: { ...serviceAck(first, 1001), conversationId: "999888777666555444" }
  }, { ...ACTIVE_TMUX, nowMs: 1001 }), /host_transport_service_cursor_invalid/);
  assert.throws(() => statusHostTransport({
    ...fixture,
    serviceCursorAck: {
      ...serviceAck(first, 1001),
      servicedAt: "1970-01-01T00:00:01.001000+00:00"
    }
  }, { ...ACTIVE_TMUX, nowMs: 1001 }), /host_transport_service_cursor_invalid/);
  const second = statusHostTransport({
    ...fixture,
    serviceCursorAck: serviceAck(first, 1001)
  }, { ...ACTIVE_TMUX, nowMs: 1001, randomUUID: () => "second" });
  assert.equal(second.type, "host_transport_status");
});

test("a lost status response can reissue the exact bounded service cursor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-service-reissue-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-service-reissue",
    events: [event(1, "started", 0)]
  });
  const first = statusHostTransport(fixture, {
    ...ACTIVE_TMUX,
    nowMs: 1000,
    randomUUID: () => "first-lost"
  });
  let reissued;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    reissued = statusHostTransport({
      ...fixture,
      reissueServiceCursor: true
    }, { ...ACTIVE_TMUX, nowMs: 1000 + attempt });
    assert.equal(reissued.serviceCursor, first.serviceCursor);
  }
  assert.throws(() => statusHostTransport({
    ...fixture,
    reissueServiceCursor: true
  }, { ...ACTIVE_TMUX, nowMs: 1004 }), /host_transport_service_cursor_reissue_exhausted/);
  const next = statusHostTransport({
    ...fixture,
    serviceCursorAck: serviceAck(reissued, 1005)
  }, { ...ACTIVE_TMUX, nowMs: 1005, randomUUID: () => "after-reissue" });
  assert.notEqual(next.serviceCursor, first.serviceCursor);
});

test("transport mutation uses atomic replacement and preserves the authoritative record on rename failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-atomic-record-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-atomic-record",
    events: [event(1, "started", 0)]
  });
  const before = fs.readFileSync(fixture.transportFile, "utf8");
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    const error = new Error("synthetic rename failure");
    error.code = "EIO";
    throw error;
  };
  try {
    assert.throws(() => statusHostTransport(fixture, {
      ...ACTIVE_TMUX,
      nowMs: 1000,
      randomUUID: () => "atomic"
    }), /host_transport_record_write_failed/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(fixture.transportFile, "utf8"), before);
  assert.deepEqual(fs.readdirSync(root).filter((name) =>
    name.endsWith(".tmp") || name.endsWith(".lock")), []);
});

test("report acknowledgement distinguishes no obligation and binds canonical report identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-report-identity-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-report-identity",
    events: [event(1, "started", 0)]
  });
  assert.throws(() => acknowledgeHostTransportReport({
    ...fixture,
    reportId: "report-none",
    reportKind: "intermediate",
    cadence: 1,
    attemptId: "attempt-none",
    fence: 1,
    report: canonicalReport("intermediate"),
    receipt: {}
  }), /host_transport_report_not_required/);

  const dueAt = REPORT_CADENCE_MS;
  const dueFixture = writeStaticTransport({
    root,
    handle: "acp-report-identity-due",
    events: [event(1, "started", 0)],
    publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
  });
  const claim = claimAndBegin(dueFixture, {
    ...ACTIVE_TMUX,
    nowMs: dueAt,
    randomUUID: () => "identity"
  });
  const report = canonicalReport("intermediate");
  assert.throws(() => acknowledgeHostTransportReport(ackInput(
    dueFixture,
    claim,
    { ...report, model: "different-model" },
    reportReceipt("intermediate", report, "100000000000000070", dueAt)
  ), { nowMs: dueAt }), /host_transport_report_ack_identity_mismatch/);
  assert.throws(() => acknowledgeHostTransportReport(ackInput(
    dueFixture,
    claim,
    report,
    {
      ...reportReceipt("intermediate", report, "100000000000000070", dueAt),
      messageDigest: "0".repeat(64)
    }
  ), { nowMs: dueAt }), /host_transport_report_receipt_invalid/);

  // An acknowledgement whose attempt never persisted the delivery handoff is
  // rejected: the receipt claims a delivery the record never began.
  const skipped = writeStaticTransport({
    root,
    handle: "acp-report-identity-skip",
    events: [event(1, "started", 0)],
    publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
  });
  const unbegun = claimHostTransportReport(claimInput(skipped), {
    ...ACTIVE_TMUX,
    nowMs: dueAt,
    randomUUID: () => "identity-skip"
  });
  assert.throws(() => acknowledgeHostTransportReport(ackInput(
    skipped,
    unbegun,
    report,
    reportReceipt("intermediate", report, "100000000000000073", dueAt)
  ), { nowMs: dueAt }), /host_transport_report_ack_state/);
});

test("publication writers clear intermediate terminal fields and bound receipt history", () => {
  const loaded = {
    record: {
      publication: publicationFixture({
        terminalSequence: 9,
        terminalStatus: "completed"
      })
    }
  };
  requireReport(loaded, "intermediate", 2, REPORT_CADENCE_MS, 8, null, {
    randomUUID: () => "writer"
  });
  assert.equal(loaded.record.publication.terminalSequence, null);
  assert.equal(loaded.record.publication.terminalStatus, null);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-receipt-bound-"));
  const oldIds = Array.from({ length: 64 }, (_, index) => String(200000000000000000n + BigInt(index)));
  const dueAt = REPORT_CADENCE_MS;
  const fixture = writeStaticTransport({
    root,
    handle: "acp-receipt-bound",
    events: [event(1, "started", 0)],
    publication: publicationFixture({
      state: "publication_pending",
      kind: "intermediate",
      cadence: 1,
      reportId: "report-history",
      requiredAt: new Date(dueAt).toISOString(),
      acknowledgedMessageIds: oldIds,
      fence: 1,
      attemptCount: 1,
      pumpJobId: PUMP_JOB_ID,
      attempt: attemptFixture({
        attemptId: "attempt-history",
        claimedAt: new Date(dueAt).toISOString(),
        expiresAt: new Date(dueAt + REPORT_ATTEMPT_TTL_MS).toISOString()
      })
    })
  });
  const report = canonicalReport("intermediate");
  acknowledgeHostTransportReport({
    ...fixture,
    reportId: "report-history",
    reportKind: "intermediate",
    cadence: 1,
    attemptId: "attempt-history",
    fence: 1,
    report,
    receipt: reportReceipt("intermediate", report, "300000000000000000", dueAt)
  }, { nowMs: dueAt });
  const ids = readRecord(fixture).publication.acknowledgedMessageIds;
  assert.equal(ids.length, 64);
  assert.equal(ids.includes(oldIds[0]), false);
  assert.equal(ids.at(-1), "300000000000000000");
});

test("terminal report requirement preserves an epoch-zero timestamp", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-terminal-epoch-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-terminal-epoch",
    events: [event(1, "terminal", 0, { status: "failed" })]
  });
  const claim = claimHostTransportReport(claimInput(fixture), {
    ...ACTIVE_TMUX,
    nowMs: 1234,
    randomUUID: () => "epoch"
  });
  assert.equal(claim.requiredAt, new Date(0).toISOString());
});

test("ack-report CLI accepts only the private exact-key receipt shape and does not echo identifiers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-ack-report-cli-"));
  const nowMs = Date.now();
  const fixture = writeStaticTransport({
    root,
    handle: "acp-ack-report-cli",
    events: [event(1, "started", nowMs - REPORT_CADENCE_MS)],
    publication: publicationFixture({ nextDueAt: new Date(nowMs).toISOString() })
  });
  const claim = claimAndBegin(fixture, {
    ...ACTIVE_TMUX,
    nowMs,
    randomUUID: () => "ack-cli"
  });
  const messageId = "100000000000000050";
  const report = canonicalReport("intermediate");
  const inputFile = path.join(root, "ack.json");
  fs.writeFileSync(inputFile, JSON.stringify({
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    action: "ack-report",
    ...ackInput(fixture, claim, report, reportReceipt("intermediate", report, messageId, nowMs))
  }), { mode: 0o600 });
  const extraFile = path.join(root, "extra.json");
  const extra = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  extra.receipt.source = "caller";
  fs.writeFileSync(extraFile, JSON.stringify(extra), { mode: 0o600 });
  const rejected = spawnSync(process.execPath, [TRANSPORT_CLI, "--input", extraFile], { encoding: "utf8" });
  assert.equal(rejected.status, 64);
  assert.equal(JSON.parse(rejected.stderr).code, "host_transport_report_receipt_invalid");
  const result = spawnSync(process.execPath, [TRANSPORT_CLI, "--input", inputFile], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.includes(messageId), false);
  assert.equal(result.stdout.includes(CONTROL_CONVERSATION_ID), false);
  assert.equal(result.stdout.includes(claim.attemptId), false);
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
    createdAt: new Date().toISOString(),
    reportingContext: reportingContextFixture(),
    publication: publicationFixture(),
    controllerLease: { phase: "activation_confirmed" }
  };
  fs.writeFileSync(transportFile, JSON.stringify(record), { mode: 0o600 });
  fs.writeFileSync(record.eventsFile, JSON.stringify({
    schemaVersion: "acp-discord-orchestrator.v1",
    type: "launcher_error",
    code: "invalid_config"
  }) + "\n", { mode: 0o600 });
  fs.writeFileSync(record.exitFile, "64\n", { mode: 0o600 });

  const fixture = { transportFile, processHandle: handle };
  const pending = reconcileHostTransport(fixture);
  assert.equal(pending.status, "terminal_publication_pending");
  const nowMs = Date.now();
  const status = statusHostTransport(fixture, {
    nowMs,
    randomUUID: () => "launcher-report",
    runTmux() { return { status: 1, stdout: "", stderr: "" }; }
  });
  assert.equal(status.status, "terminal_publication_pending");
  const claim = claimAndBegin(fixture, { ...DEAD_TMUX, nowMs, randomUUID: () => "launcher-claim" });
  assert.equal(claim.reportKind, "terminal");
  assert.equal(claim.terminalStatus, "failed");
  assert.equal(claim.elapsedMs, null);
  const terminalReport = canonicalReport("terminal", { status: "failed" });
  acknowledgeHostTransportReport(ackInput(
    fixture,
    claim,
    terminalReport,
    reportReceipt("terminal", terminalReport, "100000000000000030", nowMs)
  ), { nowMs });
  assert.deepEqual(reconcileHostTransport(fixture), {
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
  assert.deepEqual(confirmHostTransportActivation(prepared), {
    schemaVersion: "acp-host-controller-lease.v1",
    type: "host_transport_activation_confirmed",
    processHandle: prepared.processHandle,
  });
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

test("normative contract documents every report-pump correction error code", () => {
  const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const contract = fs.readFileSync(path.join(skillRoot, "references/runtime-contract.md"), "utf8");
  const sources = [
    "scripts/acp-host-transport.mjs",
    "scripts/acp-report-pump.mjs",
    "scripts/acp-report-controller-preparation.mjs",
  ].map((relative) => fs.readFileSync(path.join(skillRoot, relative), "utf8")).join("\n");
  const stableCodes = [
    "host_transport_report_claim_held",
    "host_transport_report_attempts_exhausted",
    "host_transport_report_fencing_stale",
    "host_transport_lock_timeout",
    "host_transport_pump_destination_mismatch",
    "host_transport_pump_job_mismatch",
    "host_transport_report_attempt_expired",
    "host_transport_report_delivery_already_pending",
    "host_transport_publication_halted",
    "host_transport_pump_job_invalid",
    "host_transport_pump_run_token_invalid",
    "host_transport_lock_failed",
    "host_transport_activation_state_invalid",
    "host_transport_activation_not_confirmed",
    "report_pump_input_invalid",
    "report_pump_input_schema",
    "report_controller_lease_token_invalid",
    "report_controller_declaration_key_invalid",
    "report_controller_round_invalid",
    "report_controller_job_create_invalid",
    "report_controller_job_create_unresolved",
    "report_controller_job_id_invalid",
    "report_controller_job_arm_invalid",
    "report_controller_registration_invalid",
    "report_controller_commit_recovery_invalid",
  ];
  for (const code of stableCodes) {
    assert.equal(sources.includes(`"${code}"`), true, `${code} must remain implemented`);
    assert.equal(contract.includes(`\`${code}\``), true, `${code} must remain documented`);
  }
});
