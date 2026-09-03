import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ACP_REPORT_PUMP_SCHEMA_VERSION,
  ACP_REPORT_PUMP_SNAPSHOT_SCHEMA_VERSION,
  main as reportPumpMain,
  runReportPump
} from "./acp-report-pump.mjs";
import {
  ACP_HOST_TRANSPORT_SCHEMA_VERSION,
  REPORT_CADENCE_MS,
  acknowledgeHostTransportReport
} from "./acp-host-transport.mjs";
import {
  buildAcpIntermediateReport,
  buildAcpTerminalReport
} from "./acp-reporting-contract.mjs";

const CONTROL_CONVERSATION_ID = "100000000000000001";
const PUMP_JOB_ID = "acp-report-pump-round-1";
const ACTIVE_TMUX = { runTmux() { return { status: 0, stdout: "", stderr: "" }; } };
const DEAD_TMUX = { runTmux() { return { status: 1, stdout: "", stderr: "" }; } };

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
    pumpJobId: PUMP_JOB_ID,
    ...overrides
  };
}

function event(sequence, type = "activity", timestampMs = sequence * 1000, extra = {}) {
  return {
    schemaVersion: "acp-discord-orchestrator.v1",
    type,
    sequence,
    runId: "run-report-pump-test",
    requestId: "request-report-pump-test",
    timestamp: new Date(timestampMs).toISOString(),
    elapsedMs: timestampMs,
    ...extra
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
    reportingContext: {
      agent: "codex",
      model: "test-model[medium]",
      roundIndex: 1,
      repository: "openclaw-skills",
      branch: "fix/acp-automated-report-pump",
      controlConversationId: CONTROL_CONVERSATION_ID
    },
    publication
  };
  fs.writeFileSync(transportFile, JSON.stringify(record), { mode: 0o600 });
  fs.writeFileSync(record.eventsFile, events.map((item) => JSON.stringify(item)).join("\n") + "\n", { mode: 0o600 });
  if (exitCode !== null) fs.writeFileSync(record.exitFile, `${exitCode}\n`, { mode: 0o600 });
  return { transportFile, processHandle: handle, record };
}

function pumpInput(fixture, overrides = {}) {
  return {
    schemaVersion: ACP_REPORT_PUMP_SCHEMA_VERSION,
    transportFile: fixture.transportFile,
    processHandle: fixture.processHandle,
    jobId: PUMP_JOB_ID,
    destination: CONTROL_CONVERSATION_ID,
    runToken: "pumprun-test",
    ...overrides
  };
}

function writeSnapshot(root, snapshot) {
  const snapshotFile = path.join(root, "snapshot.json");
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot), { mode: 0o600 });
  return snapshotFile;
}

test("pump claims a due intermediate and derives the canonical fresh report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-pump-intermediate-"));
  const dueAt = REPORT_CADENCE_MS;
  const fixture = writeStaticTransport({
    root,
    handle: "acp-pump-intermediate",
    events: [
      event(1, "started", 0),
      event(2, "activity", 480000, { activity: "model_output" })
    ],
    publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
  });
  const snapshotFile = writeSnapshot(root, {
    schemaVersion: ACP_REPORT_PUMP_SNAPSHOT_SCHEMA_VERSION,
    phaseIndex: 2,
    phaseStartedCadence: 0,
    executionState: "구현 진행 중",
    inProgress: "수정 작업 진행",
    verification: "테스트 준비",
    next: "테스트 실행",
    newResultDelta: 1,
    newResult: "구현 1건 완료"
  });
  const result = runReportPump(pumpInput(fixture, { snapshotFile }), {
    ...ACTIVE_TMUX,
    nowMs: dueAt
  });
  assert.equal(result.type, "report_pump_result");
  assert.equal(result.status, "delivery_pending");
  assert.equal(result.reportKind, "intermediate");
  assert.equal(result.cadence, 1);
  // The rendered message is byte-identical to the canonical builder output
  // for the machine-derived structured inputs: cadence-derived minutes, the
  // live activity age, and the snapshot's bounded slots.
  const expected = buildAcpIntermediateReport({
    agent: "codex",
    model: "test-model[medium]",
    roundIndex: 1,
    repository: "openclaw-skills",
    branch: "fix/acp-automated-report-pump",
    timeKst: "09:10",
    phaseIndex: 2,
    totalMinutes: 10,
    phaseMinutes: 10,
    lastAcpActivityMinutesAgo: 2,
    newResultDelta: 1,
    newResult: "구현 1건 완료",
    executionState: "구현 진행 중",
    inProgress: "수정 작업 진행",
    verification: "테스트 준비",
    next: "테스트 실행"
  });
  assert.equal(result.message, expected);
  assert.equal(
    result.messageDigest,
    crypto.createHash("sha256").update(expected, "utf8").digest("hex")
  );
  // The claim was handed to the delivery layer: the fenced attempt persists
  // as delivery_pending and carries the pump's opaque run token.
  const record = JSON.parse(fs.readFileSync(fixture.transportFile, "utf8"));
  assert.equal(record.publication.attempt.state, "delivery_pending");
  assert.equal(record.publication.attempt.runToken, "pumprun-test");
  assert.equal(record.publication.attempt.attemptId, result.attemptId);
  assert.equal(record.publication.fence, result.fence);
  // Private identifiers never appear inside the public report text.
  for (const secret of [
    result.attemptId,
    result.reportId,
    fixture.processHandle,
    PUMP_JOB_ID,
    CONTROL_CONVERSATION_ID
  ]) {
    assert.equal(result.message.includes(secret), false);
  }
});

test("pump output closes cleanly through ack-report with the digest-bound receipt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-pump-ack-"));
  const dueAt = REPORT_CADENCE_MS;
  const fixture = writeStaticTransport({
    root,
    handle: "acp-pump-ack",
    events: [event(1, "started", 0)],
    publication: publicationFixture({ nextDueAt: new Date(dueAt).toISOString() })
  });
  const result = runReportPump(pumpInput(fixture), { ...ACTIVE_TMUX, nowMs: dueAt });
  assert.equal(result.status, "delivery_pending");
  // Without an owner snapshot the pump renders canonical bounded defaults —
  // fixed neutral slot values, machine-derived times — and no ACP activity
  // event keeps the fail-closed maximum age instead of a fabricated instant.
  assert.match(result.message, /마지막 ACP 활동 10분 전/);
  const record = JSON.parse(fs.readFileSync(fixture.transportFile, "utf8"));
  const acked = acknowledgeHostTransportReport({
    transportFile: fixture.transportFile,
    processHandle: fixture.processHandle,
    reportId: result.reportId,
    reportKind: result.reportKind,
    cadence: result.cadence,
    attemptId: result.attemptId,
    fence: result.fence,
    report: {
      agent: "codex",
      model: "test-model[medium]",
      roundIndex: 1,
      repository: "openclaw-skills",
      branch: "fix/acp-automated-report-pump",
      timeKst: "09:10",
      phaseIndex: 2,
      totalMinutes: 10,
      phaseMinutes: 10,
      lastAcpActivityMinutesAgo: 10,
      newResultDelta: 0,
      executionState: "ACP 실행 계속 중",
      inProgress: "ACP 작업 진행 중",
      verification: "자체 검증 대기",
      next: "작업 계속"
    },
    receipt: {
      conversationId: CONTROL_CONVERSATION_ID,
      messageId: "100000000000000050",
      deliveredAt: new Date(dueAt).toISOString(),
      deliveryStatus: "delivered",
      messageDigest: result.messageDigest
    }
  }, { nowMs: dueAt });
  assert.equal(acked.type, "host_transport_report_acknowledged");
  assert.equal(record.publication.pumpJobId, PUMP_JOB_ID);
});

test("pump derives the terminal report from live terminal evidence and the snapshot terminal slots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-pump-terminal-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-pump-terminal",
    events: [
      event(1, "started", 0),
      event(2, "terminal", 660000, { status: "cancelled" })
    ],
    exitCode: 20
  });
  const snapshotFile = writeSnapshot(root, {
    schemaVersion: ACP_REPORT_PUMP_SNAPSHOT_SCHEMA_VERSION,
    terminal: {
      summary: "취소 요청 반영",
      verification: "부분 결과 검토 필요",
      result: "부분 구현 상태",
      next: "소유자 판단 대기",
      externalAction: "없음"
    }
  });
  const result = runReportPump(pumpInput(fixture, { snapshotFile }), {
    ...DEAD_TMUX,
    nowMs: 660000
  });
  assert.equal(result.status, "delivery_pending");
  assert.equal(result.reportKind, "terminal");
  assert.equal(result.cadence, 0);
  const expected = buildAcpTerminalReport({
    agent: "codex",
    model: "test-model[medium]",
    roundIndex: 1,
    repository: "openclaw-skills",
    branch: "fix/acp-automated-report-pump",
    timeKst: "09:11",
    elapsed: "11분",
    status: "cancelled",
    summary: "취소 요청 반영",
    verification: "부분 결과 검토 필요",
    result: "부분 구현 상태",
    next: "소유자 판단 대기",
    externalAction: "없음"
  });
  assert.equal(result.message, expected);
  // Distinct cancelled semantics reach the public title untouched.
  assert.match(result.message, /⛔ \*\*ACP 취소 보고/);
});

test("pump passes through none_due, terminal_acked, and tracking_lost without publishing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-pump-pass-"));
  const idle = writeStaticTransport({
    root,
    handle: "acp-pump-idle",
    events: [event(1, "started", 0)],
    publication: publicationFixture({ nextDueAt: new Date(REPORT_CADENCE_MS).toISOString() })
  });
  const none = runReportPump(pumpInput(idle), { ...ACTIVE_TMUX, nowMs: 1000 });
  assert.deepEqual(none, {
    schemaVersion: ACP_REPORT_PUMP_SCHEMA_VERSION,
    type: "report_pump_result",
    status: "none_due"
  });

  const acked = writeStaticTransport({
    root,
    handle: "acp-pump-acked",
    events: [event(1, "terminal", 1000, { status: "completed" })],
    publication: publicationFixture({
      state: "receipt_acked",
      kind: "terminal",
      cadence: 0,
      reportId: "report-final",
      requiredAt: new Date(1000).toISOString(),
      receiptMessageId: "100000000000000060",
      acknowledgedMessageIds: ["100000000000000060"],
      terminalSequence: 1,
      terminalStatus: "completed",
      lastAttemptOutcome: "acknowledged"
    }),
    exitCode: 0
  });
  const done = runReportPump(pumpInput(acked), { ...DEAD_TMUX, nowMs: 2000 });
  assert.equal(done.status, "terminal_acked");

  const lost = writeStaticTransport({
    root,
    handle: "acp-pump-lost",
    events: [event(1, "started", 0)],
    publication: publicationFixture({ nextDueAt: new Date(REPORT_CADENCE_MS).toISOString() })
  });
  const lostResult = runReportPump(pumpInput(lost), { ...DEAD_TMUX, nowMs: REPORT_CADENCE_MS });
  assert.equal(lostResult.status, "tracking_lost");
  const again = runReportPump(pumpInput(lost), { ...ACTIVE_TMUX, nowMs: REPORT_CADENCE_MS + 1 });
  assert.equal(again.status, "tracking_lost");
});

test("pump fails closed on job identity mismatch and malformed snapshots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-pump-mismatch-"));
  const fixture = writeStaticTransport({
    root,
    handle: "acp-pump-mismatch",
    events: [event(1, "started", 0)],
    publication: publicationFixture({ nextDueAt: new Date(REPORT_CADENCE_MS).toISOString() })
  });
  assert.throws(() => runReportPump(pumpInput(fixture, { jobId: "acp-report-pump-imposter" }), {
    ...ACTIVE_TMUX,
    nowMs: REPORT_CADENCE_MS
  }), /host_transport_pump_job_mismatch/);
  assert.throws(() => runReportPump(pumpInput(fixture, { destination: "999888777666555444" }), {
    ...ACTIVE_TMUX,
    nowMs: REPORT_CADENCE_MS
  }), /host_transport_pump_destination_mismatch/);

  const badSnapshot = writeSnapshot(root, {
    schemaVersion: ACP_REPORT_PUMP_SNAPSHOT_SCHEMA_VERSION,
    executionState: "정상",
    unexpectedKey: "value"
  });
  assert.throws(() => runReportPump(pumpInput(fixture, { snapshotFile: badSnapshot }), {
    ...ACTIVE_TMUX,
    nowMs: REPORT_CADENCE_MS
  }), /report_pump_snapshot_invalid/);
  // A rejected snapshot fails before any claim is minted.
  const record = JSON.parse(fs.readFileSync(fixture.transportFile, "utf8"));
  assert.equal(record.publication.kind, null);
});

test("pump CLI emits one bounded result event and one bounded error event", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-pump-cli-"));
  if (process.platform !== "win32") fs.chmodSync(root, 0o700);
  const fixture = writeStaticTransport({
    root,
    handle: "acp-pump-cli",
    events: [event(1, "started", 0)],
    publication: publicationFixture({ nextDueAt: new Date(REPORT_CADENCE_MS).toISOString() })
  });
  const inputFile = path.join(root, "pump-input.json");
  fs.writeFileSync(inputFile, JSON.stringify(pumpInput(fixture)), { mode: 0o600 });
  const results = [];
  const events = [];
  const okExit = await reportPumpMain(["--input", inputFile], {
    ...ACTIVE_TMUX,
    nowMs: 1000,
    writeResult: (value) => results.push(value),
    writeEvent: (value) => events.push(value)
  });
  assert.equal(okExit, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "none_due");
  assert.deepEqual(events, []);

  const badFile = path.join(root, "pump-bad.json");
  fs.writeFileSync(badFile, JSON.stringify({
    ...pumpInput(fixture),
    extraKey: true
  }), { mode: 0o600 });
  const badExit = await reportPumpMain(["--input", badFile], {
    ...ACTIVE_TMUX,
    nowMs: 1000,
    writeResult: (value) => results.push(value),
    writeEvent: (value) => events.push(value)
  });
  assert.equal(badExit, 64);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "report_pump_error");
  assert.equal(events[0].code, "report_pump_input_invalid");
  assert.equal(JSON.stringify(events[0]).includes(root), false);
});
