// Skill-side report pump imported in-process by the durable controller plugin.
// One enabled every-600000-ms OpenClaw script automation per exact ACP handle
// invokes the controller; each controller tick calls this entry point to claim a
// fresh report obligation from the host transport's closed `claim-report`
// action, derives the canonical public message from that live claim (never
// from a static public report snapshot), marks the fenced attempt
// `delivery_pending`, and hands the bounded result to the delivery layer.
// The pump has no chat credentials and performs no delivery itself. The
// controller script sends only an opaque publication token; trusted plugin
// policy injects the retained message, and message_sent closes the attempt
// with the exact returned structured report and digest-bound Discord receipt.
//
// Terminal acknowledgement is the deterministic self-cleanup boundary: a
// claim returning `terminal_acked` means publication is complete and the
// automation must disable/delete itself. A claim returning `tracking_lost`
// means publication is halted permanently — stop the automation and never
// relaunch ACP.

import crypto from "node:crypto";
import path from "node:path";

import {
  beginHostTransportReportDelivery,
  claimHostTransportReport,
  REPORT_CADENCE_MS
} from "./acp-host-transport.mjs";
import {
  buildAcpIntermediateReport,
  buildAcpTerminalReport,
  ACP_REPORT_PHASES,
  isReportPumpId,
  MAX_REPORT_RESULT_DELTA
} from "./acp-reporting-contract.mjs";
import {
  assertExactKeys,
  isCliEntry,
  isPlainObject,
  parsePrivateJsonInputCli,
  readPrivateJsonInput,
  safeCode
} from "./acp-private-json-input.mjs";

export const ACP_REPORT_PUMP_SCHEMA_VERSION = "acp-report-pump.v1";
export const ACP_REPORT_PUMP_SNAPSHOT_SCHEMA_VERSION = "acp-report-pump-snapshot.v1";
export const MAX_REPORT_PUMP_INPUT_BYTES = 8192;
export const MAX_REPORT_PUMP_SNAPSHOT_BYTES = 8192;

const INVALID_INPUT_EXIT = 64;
const PUMP_ERROR_EXIT = 22;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DECIMAL_ID = /^[0-9]{1,32}$/;
const KST_OFFSET_MS = 9 * 3600000;
const CADENCE_MINUTES = REPORT_CADENCE_MS / 60000;

// Canonical bounded fallback slot content used when the owner-maintained
// structured snapshot omits a slot. These are fixed neutral values, not a
// replayed public report: every time, cadence, terminal-status, and identity
// value in the rendered message is machine-derived from the live claim.
const DEFAULT_INTERMEDIATE_SLOTS = Object.freeze({
  executionState: "ACP 실행 계속 중",
  inProgress: "ACP 작업 진행 중",
  verification: "자체 검증 대기",
  next: "작업 계속"
});
const DEFAULT_TERMINAL_SLOTS = Object.freeze({
  summary: "ACP 종료 상태 확인됨",
  verification: "소유자 확인 대기",
  result: "소유자 확인 대기",
  next: "소유자 검증 시작",
  externalAction: "없음"
});

function pumpFail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function validateReportPumpInput(parsed) {
  if (!isPlainObject(parsed)) {
    pumpFail("report_pump_input_invalid");
  }
  assertExactKeys(
    parsed,
    ["schemaVersion"],
    ["transportFile", "processHandle", "jobId", "destination", "snapshotFile", "runToken"],
    pumpFail,
    "report_pump_input_invalid"
  );
  if (parsed.schemaVersion !== ACP_REPORT_PUMP_SCHEMA_VERSION) {
    pumpFail("report_pump_input_schema");
  }
  if (typeof parsed.transportFile !== "string" || !path.isAbsolute(parsed.transportFile)) {
    pumpFail("report_pump_transport_file_invalid");
  }
  if (typeof parsed.processHandle !== "string" || !SAFE_TOKEN.test(parsed.processHandle)) {
    pumpFail("report_pump_process_handle_invalid");
  }
  if (!isReportPumpId(parsed.jobId)) {
    pumpFail("report_pump_job_id_invalid");
  }
  if (typeof parsed.destination !== "string" || !DECIMAL_ID.test(parsed.destination)) {
    pumpFail("report_pump_destination_invalid");
  }
  if (parsed.snapshotFile !== undefined &&
      (typeof parsed.snapshotFile !== "string" || !path.isAbsolute(parsed.snapshotFile))) {
    pumpFail("report_pump_input_invalid");
  }
  if (parsed.runToken !== undefined &&
    (typeof parsed.runToken !== "string" || !SAFE_TOKEN.test(parsed.runToken))) {
    pumpFail("report_pump_input_invalid");
  }
  return parsed;
}

export function readReportPumpInput(inputPath, dependencies = {}) {
  return validateReportPumpInput(readPrivateJsonInput(inputPath, {
    maxBytes: MAX_REPORT_PUMP_INPUT_BYTES,
    fail: pumpFail,
    fileSystem: dependencies.fileSystem
  }));
}

function readSnapshot(snapshotFile, dependencies) {
  if (snapshotFile === undefined) {
    return {};
  }
  const parsed = readPrivateJsonInput(snapshotFile, {
    maxBytes: MAX_REPORT_PUMP_SNAPSHOT_BYTES,
    fail: pumpFail,
    fileSystem: dependencies.fileSystem
  });
  if (!isPlainObject(parsed) || parsed.schemaVersion !== ACP_REPORT_PUMP_SNAPSHOT_SCHEMA_VERSION) {
    pumpFail("report_pump_snapshot_invalid");
  }
  assertExactKeys(
    parsed,
    ["schemaVersion"],
    [
      "phaseIndex", "phaseStartedCadence", "executionState", "inProgress",
      "verification", "next", "newResultDelta", "newResult", "issue", "terminal"
    ],
    pumpFail,
    "report_pump_snapshot_invalid"
  );
  for (const key of ["executionState", "inProgress", "verification", "next", "newResult", "issue"]) {
    if (parsed[key] !== undefined && typeof parsed[key] !== "string") {
      pumpFail("report_pump_snapshot_invalid");
    }
  }
  for (const key of ["phaseIndex", "phaseStartedCadence", "newResultDelta"]) {
    if (parsed[key] !== undefined && (!Number.isSafeInteger(parsed[key]) || parsed[key] < 0)) {
      pumpFail("report_pump_snapshot_invalid");
    }
  }
  if (parsed.phaseIndex !== undefined && !Object.hasOwn(ACP_REPORT_PHASES, parsed.phaseIndex)) {
    pumpFail("report_pump_snapshot_invalid");
  }
  if (parsed.newResultDelta !== undefined && parsed.newResultDelta > MAX_REPORT_RESULT_DELTA) {
    pumpFail("report_pump_snapshot_invalid");
  }
  if ((parsed.newResultDelta ?? 0) > 0 && parsed.newResult === undefined) {
    pumpFail("report_pump_snapshot_invalid");
  }
  if (parsed.terminal !== undefined) {
    if (!isPlainObject(parsed.terminal)) {
      pumpFail("report_pump_snapshot_invalid");
    }
    assertExactKeys(
      parsed.terminal,
      [],
      ["summary", "verification", "result", "next", "externalAction"],
      pumpFail,
      "report_pump_snapshot_invalid"
    );
    for (const value of Object.values(parsed.terminal)) {
      if (typeof value !== "string") {
        pumpFail("report_pump_snapshot_invalid");
      }
    }
  }
  // Exercise the canonical builders with fixed valid machine fields so every
  // owner-controlled slot is proven acceptable before claim-report can mint
  // an attempt. Live identity/time/cadence values are still supplied only
  // after the claim and are never taken from this validation fixture.
  try {
    const newResultDelta = parsed.newResultDelta ?? 0;
    buildAcpIntermediateReport({
      agent: "claude",
      model: "runtime-default",
      roundIndex: 1,
      repository: "snapshot-validation",
      branch: "snapshot-validation",
      timeKst: "00:00",
      phaseIndex: parsed.phaseIndex ?? 2,
      totalMinutes: 0,
      phaseMinutes: 0,
      lastAcpActivityMinutesAgo: 0,
      newResultDelta,
      ...(newResultDelta > 0 ? { newResult: parsed.newResult } : {}),
      executionState: parsed.executionState ?? DEFAULT_INTERMEDIATE_SLOTS.executionState,
      inProgress: parsed.inProgress ?? DEFAULT_INTERMEDIATE_SLOTS.inProgress,
      verification: parsed.verification ?? DEFAULT_INTERMEDIATE_SLOTS.verification,
      next: parsed.next ?? DEFAULT_INTERMEDIATE_SLOTS.next,
      ...(parsed.issue !== undefined ? { issue: parsed.issue } : {})
    });
    const terminal = { ...DEFAULT_TERMINAL_SLOTS, ...(parsed.terminal ?? {}) };
    buildAcpTerminalReport({
      agent: "claude",
      model: "runtime-default",
      roundIndex: 1,
      repository: "snapshot-validation",
      branch: "snapshot-validation",
      timeKst: "00:00",
      elapsed: "측정 불가",
      status: "failed",
      ...terminal
    });
  } catch {
    pumpFail("report_pump_snapshot_invalid");
  }
  return parsed;
}

function timeKstFrom(nowMs) {
  return new Date(nowMs + KST_OFFSET_MS).toISOString().slice(11, 16);
}

function clampMinutes(value, maximum) {
  return Math.min(Math.max(value, 0), maximum);
}

// Derive the canonical structured report input from the live claim plus the
// bounded owner snapshot. Cadence-derived minutes, the activity age, and the
// terminal status always come from the claim — a stale snapshot can never
// move a machine-derived value.
function buildClaimedReport(claim, snapshot, nowMs) {
  const identity = { ...claim.identity, timeKst: timeKstFrom(nowMs) };
  if (claim.reportKind === "terminal") {
    const slots = { ...DEFAULT_TERMINAL_SLOTS, ...(snapshot.terminal ?? {}) };
    return {
      ...identity,
      status: claim.terminalStatus,
      elapsed: claim.elapsedMs === null
        ? "측정 불가"
        : `${Math.floor(claim.elapsedMs / 60000)}분`,
      summary: slots.summary,
      verification: slots.verification,
      result: slots.result,
      next: slots.next,
      externalAction: slots.externalAction
    };
  }
  const totalMinutes = claim.cadence * CADENCE_MINUTES;
  const activityMs = claim.lastAcpActivityAt === null
    ? null
    : Date.parse(claim.lastAcpActivityAt);
  const phaseStartedCadence = snapshot.phaseStartedCadence ?? 0;
  const newResultDelta = snapshot.newResultDelta ?? 0;
  return {
    ...identity,
    phaseIndex: snapshot.phaseIndex ?? 2,
    totalMinutes,
    phaseMinutes: clampMinutes(
      (claim.cadence - phaseStartedCadence) * CADENCE_MINUTES,
      totalMinutes
    ),
    // Without a normalized ACP activity event the age stays the fail-closed
    // maximum (the whole elapsed run), never a fabricated fresh instant.
    lastAcpActivityMinutesAgo: activityMs === null
      ? totalMinutes
      : clampMinutes(Math.floor((nowMs - activityMs) / 60000), totalMinutes),
    newResultDelta,
    ...(newResultDelta > 0 ? { newResult: snapshot.newResult } : {}),
    executionState: snapshot.executionState ?? DEFAULT_INTERMEDIATE_SLOTS.executionState,
    inProgress: snapshot.inProgress ?? DEFAULT_INTERMEDIATE_SLOTS.inProgress,
    verification: snapshot.verification ?? DEFAULT_INTERMEDIATE_SLOTS.verification,
    next: snapshot.next ?? DEFAULT_INTERMEDIATE_SLOTS.next,
    ...(snapshot.issue !== undefined ? { issue: snapshot.issue } : {})
  };
}

export function runReportPump(input, dependencies = {}) {
  validateReportPumpInput(input);
  const snapshot = readSnapshot(input.snapshotFile, dependencies);
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
  // One opaque run identity per pump invocation, bound into the fenced
  // attempt so a claim is attributable to exactly one automation run.
  const runToken = input.runToken ?? `pumprun-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const claim = claimHostTransportReport({
    transportFile: input.transportFile,
    processHandle: input.processHandle,
    jobId: input.jobId,
    runToken,
    destination: input.destination
  }, dependencies);
  if (claim.status !== "claimed") {
    return {
      schemaVersion: ACP_REPORT_PUMP_SCHEMA_VERSION,
      type: "report_pump_result",
      status: claim.status
    };
  }
  const nowMs = typeof dependencies.nowMs === "function"
    ? dependencies.nowMs()
    : dependencies.nowMs ?? Date.now();
  const report = buildClaimedReport(claim, snapshot, nowMs);
  const message = claim.reportKind === "intermediate"
    ? buildAcpIntermediateReport(report)
    : buildAcpTerminalReport(report);
  beginHostTransportReportDelivery({
    transportFile: input.transportFile,
    processHandle: input.processHandle,
    attemptId: claim.attemptId,
    fence: claim.fence
  }, dependencies);
  return {
    schemaVersion: ACP_REPORT_PUMP_SCHEMA_VERSION,
    type: "report_pump_result",
    status: "delivery_pending",
    reportKind: claim.reportKind,
    cadence: claim.cadence,
    reportId: claim.reportId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    runToken,
    messageDigest: crypto.createHash("sha256").update(message, "utf8").digest("hex"),
    message,
    report
  };
}

function exitCodeFor(code) {
  return code === "usage" ||
    code.startsWith("invalid_") ||
    code.startsWith("report_pump_input_") ||
    [
      "report_pump_transport_file_invalid",
      "report_pump_process_handle_invalid",
      "report_pump_job_id_invalid",
      "report_pump_destination_invalid"
    ].includes(code) ||
    code === "report_pump_snapshot_invalid" ||
    code.startsWith("host_transport_pump_") ||
    code === "host_transport_handle_invalid" ||
    code === "host_transport_handle_mismatch" ||
    code.startsWith("invalid_reporting_")
    ? INVALID_INPUT_EXIT
    : PUMP_ERROR_EXIT;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const writeResult = dependencies.writeResult ?? ((value) => process.stdout.write(JSON.stringify(value) + "\n"));
  const writeEvent = dependencies.writeEvent ?? ((value) => process.stderr.write(JSON.stringify(value) + "\n"));
  try {
    const input = readReportPumpInput(parsePrivateJsonInputCli(argv, pumpFail), dependencies);
    writeResult(runReportPump(input, dependencies));
    return 0;
  } catch (error) {
    const code = safeCode(error && error.code, "report_pump_failed");
    writeEvent({
      schemaVersion: ACP_REPORT_PUMP_SCHEMA_VERSION,
      type: "report_pump_error",
      code
    });
    return exitCodeFor(code);
  }
}

if (isCliEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
