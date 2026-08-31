import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACP_HOST_TRANSPORT_SCHEMA_VERSION,
  REPORT_CADENCE_MS,
  acknowledgeHostTransportReport,
  activateHostTransport,
  prepareHostTransport,
  probeHostTransport,
  reconcileHostTransport,
  statusHostTransport
} from "./acp-host-transport.mjs";
import { buildValidReporting } from "./acp-reporting-test-fixture.mjs";
import {
  activateLifecycleLedger,
  createLifecycleLedger,
  loadLifecycleLedger,
  recordLifecycleEvent
} from "./acp-lifecycle-ledger.mjs";

const CONTROL_CONVERSATION_ID = "100000000000000001";
const START_MESSAGE_ID = "100000000000000002";
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
    ...overrides
  };
}

function reportingContextFixture() {
  return {
    agent: "codex",
    model: "test-model",
    roundIndex: 1,
    repository: "openclaw-skills",
    branch: "fix/acp-report-publication-state-machine",
    controlConversationId: CONTROL_CONVERSATION_ID
  };
}

function serviceAck(status, servicedAt) {
  return {
    cursor: status.serviceCursor,
    conversationId: CONTROL_CONVERSATION_ID,
    servicedAt: new Date(servicedAt).toISOString()
  };
}

function writeStaticTransport({ root, handle, events, publication = publicationFixture(), exitCode = null }) {
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
    publication
  };
  fs.writeFileSync(transportFile, JSON.stringify(record), { mode: 0o600 });
  fs.writeFileSync(record.eventsFile, events.map((event) => JSON.stringify(event)).join("\n") + "\n", { mode: 0o600 });
  if (exitCode !== null) fs.writeFileSync(record.exitFile, `${exitCode}\n`, { mode: 0o600 });
  return { transportFile, processHandle: handle, record };
}

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

const ACTIVE_TMUX = { runTmux() { return { status: 0, stdout: "", stderr: "" }; } };

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
  let prior;
  for (let index = 0; index < 100; index += 1) {
    const nowMs = Date.now();
    const status = statusHostTransport({
      ...input,
      ...(prior ? { serviceCursorAck: serviceAck(prior, nowMs) } : {})
    }, { nowMs });
    prior = status;
    if (status.status === "terminal_publication_pending") {
      acknowledgeHostTransportReport({
        ...input,
        reportId: status.reportPublication.reportId,
        reportKind: "terminal",
        cadence: 0,
        receipt: {
          conversationId: CONTROL_CONVERSATION_ID,
          messageId: "100000000000000099",
          deliveredAt: new Date(nowMs).toISOString(),
          deliveryStatus: "delivered"
        }
      }, { nowMs });
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
    publication: publicationFixture()
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
    publication: publicationFixture()
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

test("first cadence is required at exactly 600 seconds and freezes later evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-publication-cadence-"));
  const dueAt = REPORT_CADENCE_MS;
  const fixture = writeStaticTransport({
    root,
    handle: "acp-publication-cadence",
    events: [event(1, "started", 0), event(2, "activity", dueAt)],
    publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
  });
  const before = statusHostTransport(fixture, { ...ACTIVE_TMUX, nowMs: dueAt - 1, randomUUID: () => "before" });
  assert.equal(before.reportPublication, undefined);
  const due = statusHostTransport({
    ...fixture,
    serviceCursorAck: serviceAck(before, dueAt)
  }, { ...ACTIVE_TMUX, nowMs: dueAt, randomUUID: () => "due" });
  assert.equal(due.reportPublication.state, "report_required");
  assert.equal(due.reportPublication.kind, "intermediate");
  assert.equal(due.reportPublication.cadence, 1);
  assert.equal(due.lastSequence, 2);

  fs.appendFileSync(fixture.record.eventsFile, JSON.stringify(event(3, "progress", dueAt + 1)) + "\n");
  assert.throws(() => statusHostTransport(fixture, {
    ...ACTIVE_TMUX,
    nowMs: dueAt + 1
  }), /host_transport_service_cursor_invalid/);
  const blocked = statusHostTransport({
    ...fixture,
    afterSequence: due.lastSequence,
    serviceCursorAck: serviceAck(due, dueAt + 1)
  }, { ...ACTIVE_TMUX, nowMs: dueAt + 1, randomUUID: () => "blocked" });
  assert.equal(blocked.reportPublication.state, "publication_pending");
  assert.deepEqual(blocked.events, []);
  assert.equal(blocked.lastSequence, 2);
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
  const status = statusHostTransport(fixture, { ...ACTIVE_TMUX, nowMs: dueAt, randomUUID: () => "receipt" });
  const base = {
    ...fixture,
    reportId: status.reportPublication.reportId,
    reportKind: "intermediate",
    cadence: 1
  };
  const validReceipt = {
    conversationId: CONTROL_CONVERSATION_ID,
    messageId: "100000000000000010",
    deliveredAt: new Date(dueAt).toISOString(),
    deliveryStatus: "delivered"
  };
  assert.throws(() => acknowledgeHostTransportReport(base, { nowMs: dueAt }), /host_transport_report_receipt_invalid/);
  for (const deliveryStatus of ["failed", "queued", "pending", "", null, true]) {
    assert.throws(() => acknowledgeHostTransportReport({
      ...base,
      receipt: { ...validReceipt, deliveryStatus }
    }, { nowMs: dueAt }), /host_transport_report_receipt_invalid/);
  }
  assert.throws(() => acknowledgeHostTransportReport({ ...base, receipt: { ...validReceipt, conversationId: "999888777666555444" } }, { nowMs: dueAt }), /host_transport_report_receipt_invalid/);
  assert.throws(() => acknowledgeHostTransportReport({ ...base, receipt: { ...validReceipt, deliveredAt: new Date(dueAt - 1).toISOString() } }, { nowMs: dueAt }), /host_transport_report_receipt_stale/);
  const acked = acknowledgeHostTransportReport({ ...base, receipt: validReceipt }, { nowMs: dueAt });
  assert.deepEqual(acked, {
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    type: "host_transport_report_acknowledged",
    kind: "intermediate",
    cadence: 1
  });
  assert.equal(JSON.stringify(acked).includes(validReceipt.messageId), false);
  assert.throws(() => acknowledgeHostTransportReport({ ...base, receipt: validReceipt }, { nowMs: dueAt }), /host_transport_report_ack_duplicate/);

  const nextDue = dueAt + REPORT_CADENCE_MS;
  fs.appendFileSync(
    fixture.record.eventsFile,
    JSON.stringify(event(2, "activity", dueAt + 10, { elapsedMs: dueAt + 10 })) + "\n"
  );
  const unblocked = statusHostTransport({
    ...fixture,
    afterSequence: status.lastSequence,
    serviceCursorAck: serviceAck(status, nextDue - 1)
  }, { ...ACTIVE_TMUX, nowMs: nextDue - 1, randomUUID: () => "unblocked" });
  assert.equal(unblocked.reportPublication.state, "receipt_acked");
  assert.equal(unblocked.events.at(-1).elapsedMs, dueAt + 10);
  const next = statusHostTransport({
    ...fixture,
    serviceCursorAck: serviceAck(unblocked, nextDue)
  }, { ...ACTIVE_TMUX, nowMs: nextDue, randomUUID: () => "next" });
  assert.equal(next.reportPublication.state, "report_required");
  assert.equal(next.reportPublication.cadence, 2);
  assert.equal(next.reportPublication.requiredAt, new Date(nextDue).toISOString());
  assert.throws(() => acknowledgeHostTransportReport({
    ...fixture,
    reportId: next.reportPublication.reportId,
    reportKind: "intermediate",
    cadence: 2,
    receipt: { ...validReceipt, deliveredAt: new Date(nextDue).toISOString() }
  }, { nowMs: nextDue }), /host_transport_report_receipt_duplicate/);
});

test("intermediate acknowledgements accept both authorized success statuses and preserve elapsed cadence anchors", () => {
  const dueAt = REPORT_CADENCE_MS;
  const cases = [
    { label: "on-time", deliveredAt: dueAt, deliveryStatus: "sent", nextAlreadyOverdue: false },
    { label: "late", deliveredAt: dueAt + 4 * 60_000, deliveryStatus: "delivered", nextAlreadyOverdue: false },
    { label: "already-overdue", deliveredAt: dueAt + 11 * 60_000, deliveryStatus: "sent", nextAlreadyOverdue: true },
  ];
  for (const [index, scenario] of cases.entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `acp-cadence-anchor-${scenario.label}-`));
    const fixture = writeStaticTransport({
      root,
      handle: `acp-cadence-anchor-${scenario.label}`,
      events: [event(1, "started", 0)],
      publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
    });
    const due = statusHostTransport(fixture, {
      ...ACTIVE_TMUX,
      nowMs: dueAt,
      randomUUID: () => `due-${scenario.label}`
    });
    acknowledgeHostTransportReport({
      ...fixture,
      reportId: due.reportPublication.reportId,
      reportKind: "intermediate",
      cadence: 1,
      receipt: {
        conversationId: CONTROL_CONVERSATION_ID,
        messageId: `1000000000000001${index + 1}`,
        deliveredAt: new Date(scenario.deliveredAt).toISOString(),
        deliveryStatus: scenario.deliveryStatus
      }
    }, { nowMs: scenario.deliveredAt });

    const persisted = JSON.parse(fs.readFileSync(fixture.transportFile, "utf8"));
    const expectedNextDueAt = new Date(dueAt + REPORT_CADENCE_MS).toISOString();
    assert.equal(persisted.publication.nextDueAt, expectedNextDueAt, scenario.label);

    const afterAck = statusHostTransport({
      ...fixture,
      serviceCursorAck: serviceAck(due, scenario.deliveredAt)
    }, {
      ...ACTIVE_TMUX,
      nowMs: scenario.deliveredAt,
      randomUUID: () => `after-${scenario.label}`
    });
    assert.equal(
      afterAck.reportPublication.state,
      scenario.nextAlreadyOverdue ? "report_required" : "receipt_acked",
      scenario.label
    );
    if (scenario.nextAlreadyOverdue) {
      assert.equal(afterAck.reportPublication.cadence, 2);
      assert.equal(afterAck.reportPublication.requiredAt, expectedNextDueAt);
    }
  }
});

test("intermediate boundary binds 마지막 ACP 활동 to normalized ACP activity events and exposes no Δ result count", () => {
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
  const due = statusHostTransport(fixture, { ...ACTIVE_TMUX, nowMs: dueAt, randomUUID: () => "activity-due" });
  assert.equal(due.reportPublication.state, "report_required");
  assert.equal(due.reportPublication.lastAcpActivityAt, new Date(300000).toISOString());
  assert.equal("newResultDelta" in due.reportPublication, false);
  assert.equal("resultBaselineSequence" in JSON.parse(fs.readFileSync(fixture.transportFile, "utf8")).publication, false);

  // A later poll boundary alone does not move the activity instant.
  const polled = statusHostTransport({
    ...fixture,
    afterSequence: due.lastSequence,
    serviceCursorAck: serviceAck(due, dueAt + 30000)
  }, { ...ACTIVE_TMUX, nowMs: dueAt + 30000, randomUUID: () => "activity-poll" });
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
    afterSequence: due.lastSequence,
    serviceCursorAck: serviceAck(polled, dueAt + 50000)
  }, { ...ACTIVE_TMUX, nowMs: dueAt + 50000, randomUUID: () => "activity-advanced" });
  assert.equal(advanced.reportPublication.lastAcpActivityAt, new Date(dueAt + 40000).toISOString());
  assert.equal("newResultDelta" in advanced.reportPublication, false);

  acknowledgeHostTransportReport({
    ...fixture,
    reportId: due.reportPublication.reportId,
    reportKind: "intermediate",
    cadence: 1,
    receipt: {
      conversationId: CONTROL_CONVERSATION_ID,
      messageId: "100000000000000060",
      deliveredAt: new Date(dueAt + 50000).toISOString(),
      deliveryStatus: "delivered"
    }
  }, { nowMs: dueAt + 50000 });
  // The delivery receipt keeps no result cursor and touches no activity
  // bookkeeping: the record's publication state stays free of any Δ
  // derivation source.
  const acked = JSON.parse(fs.readFileSync(fixture.transportFile, "utf8"));
  assert.equal("resultBaselineSequence" in acked.publication, false);

  const secondDue = 2 * REPORT_CADENCE_MS;
  const second = statusHostTransport({
    ...fixture,
    serviceCursorAck: serviceAck(advanced, secondDue)
  }, { ...ACTIVE_TMUX, nowMs: secondDue, randomUUID: () => "activity-second" });
  assert.equal(second.reportPublication.cadence, 2);
  assert.equal(second.reportPublication.lastAcpActivityAt, new Date(dueAt + 40000).toISOString());
  assert.equal("newResultDelta" in second.reportPublication, false);
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
  const due = statusHostTransport(fixture, { ...ACTIVE_TMUX, nowMs: dueAt, randomUUID: () => "activity-missing" });
  assert.equal(due.reportPublication.state, "report_required");
  assert.equal(due.reportPublication.lastAcpActivityAt, null);
  assert.equal("newResultDelta" in due.reportPublication, false);
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
  const intermediate = statusHostTransport(fixture, { ...ACTIVE_TMUX, nowMs: dueAt, randomUUID: () => "middle" });
  fs.appendFileSync(fixture.record.eventsFile, JSON.stringify(event(3, "progress", dueAt + 1)) + "\n");
  fs.appendFileSync(fixture.record.eventsFile, JSON.stringify(event(4, "terminal", dueAt + 2, { status: "completed" })) + "\n");
  const terminal = statusHostTransport({
    ...fixture,
    serviceCursorAck: serviceAck(intermediate, dueAt + 1)
  }, { ...ACTIVE_TMUX, nowMs: dueAt + 2, randomUUID: () => "terminal" });
  assert.equal(terminal.status, "terminal_publication_pending");
  assert.equal(terminal.reportPublication.state, "report_required");
  assert.equal(terminal.reportPublication.kind, "terminal");
  assert.equal(terminal.reportPublication.cadence, 0);
  assert.equal(terminal.events.at(-1).type, "terminal");
  assert.equal(terminal.events.some((normalizedEvent) => normalizedEvent.type === "progress"), false);
  const receipt = {
    conversationId: CONTROL_CONVERSATION_ID,
    messageId: "100000000000000020",
    deliveredAt: new Date(dueAt + 2).toISOString(),
    deliveryStatus: "delivered"
  };
  assert.throws(() => acknowledgeHostTransportReport({
    ...fixture,
    reportId: intermediate.reportPublication.reportId,
    reportKind: "intermediate",
    cadence: 1,
    receipt
  }, { nowMs: dueAt + 2 }), /host_transport_report_ack_mismatch/);
  acknowledgeHostTransportReport({
    ...fixture,
    reportId: terminal.reportPublication.reportId,
    reportKind: "terminal",
    cadence: 0,
    receipt
  }, { nowMs: dueAt + 2 });
  for (const normalizedEvent of terminal.events) {
    const serialized = JSON.stringify(normalizedEvent);
    assert.equal(serialized.includes(terminal.serviceCursor), false);
    assert.equal(serialized.includes(terminal.reportPublication.reportId), false);
    assert.equal(serialized.includes(fixture.processHandle), false);
    assert.equal(serialized.includes(receipt.messageId), false);
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
  const status = statusHostTransport(fixture, { ...ACTIVE_TMUX, nowMs: 599999, randomUUID: () => "early" });
  assert.equal(status.reportPublication.kind, "terminal");
  assert.equal(status.reportPublication.cadence, 0);
  assert.equal(status.reportPublication.terminalStatus, "failed");
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
  assert.equal(loadLifecycleLedger(writer.filePath).document.state, "exit_reconciled");
  acknowledgeHostTransportReport({
    ...fixture,
    reportId: status.reportPublication.reportId,
    reportKind: "terminal",
    cadence: 0,
    receipt: {
      conversationId: CONTROL_CONVERSATION_ID,
      messageId: "100000000000000040",
      deliveredAt: new Date(nowMs).toISOString(),
      deliveryStatus: "delivered"
    }
  }, { nowMs });
  assert.equal(reconcileHostTransport(fixture).status, "exit_reconciled");
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
  const second = statusHostTransport({
    ...fixture,
    serviceCursorAck: serviceAck(first, 1001)
  }, { ...ACTIVE_TMUX, nowMs: 1001, randomUUID: () => "second" });
  assert.equal(second.type, "host_transport_status");
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
  const status = statusHostTransport(fixture, {
    ...ACTIVE_TMUX,
    nowMs,
    randomUUID: () => "ack-cli"
  });
  const messageId = "100000000000000050";
  const inputFile = path.join(root, "ack.json");
  fs.writeFileSync(inputFile, JSON.stringify({
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    action: "ack-report",
    transportFile: fixture.transportFile,
    processHandle: fixture.processHandle,
    reportId: status.reportPublication.reportId,
    reportKind: "intermediate",
    cadence: 1,
    receipt: {
      conversationId: CONTROL_CONVERSATION_ID,
      messageId,
      deliveredAt: new Date(nowMs).toISOString(),
      deliveryStatus: "delivered"
    }
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
    publication: publicationFixture()
  };
  fs.writeFileSync(transportFile, JSON.stringify(record), { mode: 0o600 });
  fs.writeFileSync(record.eventsFile, JSON.stringify({
    schemaVersion: "acp-discord-orchestrator.v1",
    type: "launcher_error",
    code: "invalid_config"
  }) + "\n", { mode: 0o600 });
  fs.writeFileSync(record.exitFile, "64\n", { mode: 0o600 });

  const pending = reconcileHostTransport({
    transportFile,
    processHandle: handle
  });
  assert.equal(pending.status, "terminal_publication_pending");
  const nowMs = Date.now();
  const status = statusHostTransport({ transportFile, processHandle: handle }, {
    nowMs,
    randomUUID: () => "launcher-report",
    runTmux() { return { status: 1, stdout: "", stderr: "" }; }
  });
  acknowledgeHostTransportReport({
    transportFile,
    processHandle: handle,
    reportId: status.reportPublication.reportId,
    reportKind: "terminal",
    cadence: 0,
    receipt: {
      conversationId: CONTROL_CONVERSATION_ID,
      messageId: "100000000000000030",
      deliveredAt: new Date(nowMs).toISOString(),
      deliveryStatus: "delivered"
    }
  }, { nowMs });
  assert.deepEqual(reconcileHostTransport({ transportFile, processHandle: handle }), {
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
