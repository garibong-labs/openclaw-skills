import fs from "node:fs";
import path from "node:path";

export const ACP_HOST_ACTIVATION_SCHEMA_VERSION = "acp-host-activation.v1";
export const ACP_LIFECYCLE_LEDGER_SCHEMA_VERSION = "acp-host-lifecycle.v1";
// A two-call host transport must first return the exact handle to the owner
// and only then deliver activation. Keep the barrier fail-closed, but allow a
// full minute for bounded tool round-trip latency before pre-runtime exit.
export const DEFAULT_HOST_ACTIVATION_TIMEOUT_MS = 60000;
export const LIFECYCLE_LEDGER_ACTIVITY_FLUSH_MS = 1000;

const PROCESS_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const LEDGER_STATES = new Set([
  "activation_required",
  "active",
  "terminal_intent",
  "exit_reconciled",
  "tracking_lost"
]);
const TERMINAL_EVENT_TYPES = new Set(["terminal", "supervisor_error"]);
const MAPPED_EXIT_CODES = new Set([0, 20, 21, 22, 64]);
const MAX_ACTIVATION_LINE_BYTES = 512;

function ledgerFail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, requiredKeys, optionalKeys = []) {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(value);
  return requiredKeys.every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.has(key));
}

function assertSafeId(value, code) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    ledgerFail(code);
  }
  return value;
}

export function assertProcessHandle(value) {
  if (typeof value !== "string" || !PROCESS_HANDLE.test(value)) {
    ledgerFail("activation_invalid_process_handle");
  }
  return value;
}

export function parseHostActivationLine(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_ACTIVATION_LINE_BYTES
  ) {
    ledgerFail("activation_invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    ledgerFail("activation_invalid");
  }
  if (
    !isPlainObject(parsed) ||
    !hasExactKeys(parsed, ["schemaVersion", "processHandle"]) ||
    parsed.schemaVersion !== ACP_HOST_ACTIVATION_SCHEMA_VERSION
  ) {
    ledgerFail("activation_invalid");
  }
  return {
    schemaVersion: ACP_HOST_ACTIVATION_SCHEMA_VERSION,
    processHandle: assertProcessHandle(parsed.processHandle)
  };
}

export function waitForHostActivation(input, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HOST_ACTIVATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    ledgerFail("activation_timeout_invalid");
  }
  if (!input || typeof input.on !== "function") {
    ledgerFail("activation_input_invalid");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    let timer;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      input.off?.("data", onData);
      input.off?.("end", onEnd);
      input.off?.("error", onError);
      input.pause?.();
    };
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback(value);
    };
    const rejectCode = (code) => {
      const error = new Error(code);
      error.code = code;
      finish(reject, error);
    };
    const onData = (chunk) => {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      buffer = Buffer.concat([buffer, incoming]);
      if (buffer.length > MAX_ACTIVATION_LINE_BYTES) {
        rejectCode("activation_invalid");
        return;
      }
      const newlineAt = buffer.indexOf(0x0a);
      if (newlineAt === -1) {
        return;
      }
      const line = buffer.subarray(0, newlineAt).toString("utf8").replace(/\r$/, "");
      const trailing = buffer.subarray(newlineAt + 1).toString("utf8");
      if (trailing.trim().length > 0) {
        rejectCode("activation_invalid");
        return;
      }
      try {
        finish(resolve, parseHostActivationLine(line));
      } catch (error) {
        finish(reject, error);
      }
    };
    const onEnd = () => rejectCode("activation_eof");
    const onError = () => rejectCode("activation_input_error");

    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    timer = setTimeout(() => rejectCode("activation_timeout"), timeoutMs);
    input.resume?.();
  });
}

function assertPrivateLedgerFile(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    ledgerFail("invalid_lifecycle_ledger_file");
  }
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      ledgerFail("lifecycle_ledger_missing");
    }
    ledgerFail("lifecycle_ledger_unreadable");
  }
  if (stat.isSymbolicLink()) {
    ledgerFail("lifecycle_ledger_symlink");
  }
  if (!stat.isFile()) {
    ledgerFail("lifecycle_ledger_not_regular");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    ledgerFail("lifecycle_ledger_permissions");
  }
  return path.normalize(filePath);
}

function serializeLedger(document) {
  return JSON.stringify(document, null, 2) + "\n";
}

function writeLedgerFile(filePath, document, create) {
  try {
    if (!create) {
      assertPrivateLedgerFile(filePath);
    }
    fs.writeFileSync(filePath, serializeLedger(document), {
      encoding: "utf8",
      mode: 0o600,
      flag: create ? "wx" : "w"
    });
    if (process.platform !== "win32") {
      fs.chmodSync(filePath, 0o600);
    }
  } catch (error) {
    if (error && typeof error.code === "string" && error.code.startsWith("lifecycle_")) {
      throw error;
    }
    ledgerFail(create && error && error.code === "EEXIST"
      ? "lifecycle_ledger_exists"
      : "lifecycle_ledger_write_failed");
  }
}

function validateLastEvent(value) {
  if (value === null) {
    return;
  }
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["type", "sequence", "timestamp"]) ||
    typeof value.type !== "string" ||
    !SAFE_ID.test(value.type) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !isIsoTimestamp(value.timestamp)
  ) {
    ledgerFail("invalid_lifecycle_ledger");
  }
}

function isIsoTimestamp(value) {
  if (typeof value !== "string") {
    return false;
  }
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) && new Date(timestampMs).toISOString() === value;
}

function isMappedExitCode(value) {
  return Number.isSafeInteger(value) && MAPPED_EXIT_CODES.has(value);
}

function validateTerminalIntent(value) {
  if (value === null) {
    return;
  }
  if (!isPlainObject(value) || !TERMINAL_EVENT_TYPES.has(value.type)) {
    ledgerFail("invalid_lifecycle_ledger");
  }
  if (value.type === "terminal") {
    if (
      !hasExactKeys(value, ["type", "status"]) ||
      typeof value.status !== "string" ||
      !SAFE_ID.test(value.status)
    ) {
      ledgerFail("invalid_lifecycle_ledger");
    }
    return;
  }
  if (
    !hasExactKeys(value, ["type", "code"]) ||
    typeof value.code !== "string" ||
    !SAFE_ID.test(value.code)
  ) {
    ledgerFail("invalid_lifecycle_ledger");
  }
}

function validateExitReconciliation(value) {
  if (!isPlainObject(value) || typeof value.status !== "string") {
    ledgerFail("invalid_lifecycle_ledger");
  }
  if (value.status === "pending") {
    if (
      !hasExactKeys(value, ["status"], ["expectedExitCode"]) ||
      ("expectedExitCode" in value && !isMappedExitCode(value.expectedExitCode))
    ) {
      ledgerFail("invalid_lifecycle_ledger");
    }
    return;
  }
  if (value.status === "confirmed") {
    if (
      !hasExactKeys(value, [
        "status",
        "expectedExitCode",
        "exitCode",
        "reconciledAt"
      ]) ||
      !isMappedExitCode(value.expectedExitCode) ||
      !isMappedExitCode(value.exitCode) ||
      value.expectedExitCode !== value.exitCode ||
      !isIsoTimestamp(value.reconciledAt)
    ) {
      ledgerFail("invalid_lifecycle_ledger");
    }
    return;
  }
  if (
    value.status !== "tracking_lost" ||
    !hasExactKeys(value, ["status", "reconciledAt"]) ||
    !isIsoTimestamp(value.reconciledAt)
  ) {
    ledgerFail("invalid_lifecycle_ledger");
  }
}

function validateTrackingFault(value) {
  if (value === null) {
    return;
  }
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["code", "observedAt"]) ||
    value.code !== "tracking_lost" ||
    !isIsoTimestamp(value.observedAt)
  ) {
    ledgerFail("invalid_lifecycle_ledger");
  }
}

function validateLedgerState(value) {
  const activated = value.processHandle !== null && value.activatedAt !== null;
  const notActivated = value.processHandle === null && value.activatedAt === null;
  const pending = value.exitReconciliation.status === "pending";
  const hasExpectedExit = "expectedExitCode" in value.exitReconciliation;

  if (value.state === "activation_required") {
    if (
      value.processHandle !== null ||
      value.activatedAt !== null ||
      value.terminalIntent !== null ||
      !pending ||
      hasExpectedExit ||
      value.trackingFault !== null
    ) {
      ledgerFail("invalid_lifecycle_ledger");
    }
    return;
  }
  if (value.state === "active") {
    if (
      !activated ||
      value.terminalIntent !== null ||
      !pending ||
      hasExpectedExit ||
      value.trackingFault !== null
    ) {
      ledgerFail("invalid_lifecycle_ledger");
    }
    return;
  }
  if (value.state === "terminal_intent") {
    if (
      (!activated && !notActivated) ||
      value.terminalIntent === null ||
      !pending ||
      !hasExpectedExit ||
      value.trackingFault !== null
    ) {
      ledgerFail("invalid_lifecycle_ledger");
    }
    return;
  }
  if (value.state === "exit_reconciled") {
    if (
      (!activated && !notActivated) ||
      value.terminalIntent === null ||
      value.exitReconciliation.status !== "confirmed" ||
      value.trackingFault !== null
    ) {
      ledgerFail("invalid_lifecycle_ledger");
    }
    return;
  }
  if (
    !activated ||
    value.terminalIntent !== null ||
    value.exitReconciliation.status !== "tracking_lost" ||
    value.trackingFault === null
  ) {
    ledgerFail("invalid_lifecycle_ledger");
  }
}

function validateLedgerDocument(value) {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "runId",
      "requestId",
      "processHandle",
      "state",
      "activatedAt",
      "lastEvent",
      "terminalIntent",
      "exitReconciliation",
      "trackingFault",
      "updatedAt"
    ]) ||
    value.schemaVersion !== ACP_LIFECYCLE_LEDGER_SCHEMA_VERSION
  ) {
    ledgerFail("invalid_lifecycle_ledger");
  }
  assertSafeId(value.runId, "invalid_lifecycle_ledger");
  assertSafeId(value.requestId, "invalid_lifecycle_ledger");
  if (
    value.processHandle !== null &&
    (typeof value.processHandle !== "string" || !PROCESS_HANDLE.test(value.processHandle))
  ) {
    ledgerFail("invalid_lifecycle_ledger");
  }
  if (!LEDGER_STATES.has(value.state)) {
    ledgerFail("invalid_lifecycle_ledger");
  }
  if (value.activatedAt !== null && !isIsoTimestamp(value.activatedAt)) {
    ledgerFail("invalid_lifecycle_ledger");
  }
  validateLastEvent(value.lastEvent);
  validateTerminalIntent(value.terminalIntent);
  validateExitReconciliation(value.exitReconciliation);
  validateTrackingFault(value.trackingFault);
  if (!isIsoTimestamp(value.updatedAt)) {
    ledgerFail("invalid_lifecycle_ledger");
  }
  validateLedgerState(value);
  return value;
}

export function lifecycleLedgerPath(stateDir, runId) {
  assertSafeId(runId, "invalid_lifecycle_run_id");
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir)) {
    ledgerFail("invalid_lifecycle_state_dir");
  }
  return path.join(path.normalize(stateDir), `supervisor-${runId}.lifecycle.json`);
}

export function createLifecycleLedger({ stateDir, runId, requestId, nowMs = Date.now() }) {
  assertSafeId(runId, "invalid_lifecycle_run_id");
  assertSafeId(requestId, "invalid_lifecycle_request_id");
  const timestamp = new Date(nowMs).toISOString();
  const writer = {
    filePath: lifecycleLedgerPath(stateDir, runId),
    lastPersistedAt: nowMs,
    document: {
      schemaVersion: ACP_LIFECYCLE_LEDGER_SCHEMA_VERSION,
      runId,
      requestId,
      processHandle: null,
      state: "activation_required",
      activatedAt: null,
      lastEvent: null,
      terminalIntent: null,
      exitReconciliation: { status: "pending" },
      trackingFault: null,
      updatedAt: timestamp
    }
  };
  writeLedgerFile(writer.filePath, writer.document, true);
  return writer;
}

function persistWriter(writer, nowMs) {
  writer.document.updatedAt = new Date(nowMs).toISOString();
  writeLedgerFile(writer.filePath, writer.document, false);
  writer.lastPersistedAt = nowMs;
}

export function activateLifecycleLedger(writer, processHandle, nowMs = Date.now()) {
  writer.document.processHandle = assertProcessHandle(processHandle);
  writer.document.state = "active";
  writer.document.activatedAt = new Date(nowMs).toISOString();
  persistWriter(writer, nowMs);
}

export function recordLifecycleEvent(writer, event, options = {}) {
  if (!writer) {
    return;
  }
  const timestampMs = Date.parse(event.timestamp);
  writer.document.lastEvent = {
    type: event.type,
    sequence: event.sequence,
    timestamp: event.timestamp
  };
  if (TERMINAL_EVENT_TYPES.has(event.type)) {
    writer.document.state = "terminal_intent";
    writer.document.terminalIntent = {
      type: event.type,
      ...(typeof event.status === "string" ? { status: event.status } : {}),
      ...(typeof event.code === "string" ? { code: event.code } : {})
    };
    if (MAPPED_EXIT_CODES.has(options.expectedExitCode)) {
      writer.document.exitReconciliation = {
        status: "pending",
        expectedExitCode: options.expectedExitCode
      };
    }
  }
  const force = options.force === true || TERMINAL_EVENT_TYPES.has(event.type);
  if (
    force ||
    event.type !== "activity" ||
    !Number.isFinite(timestampMs) ||
    timestampMs - writer.lastPersistedAt >= LIFECYCLE_LEDGER_ACTIVITY_FLUSH_MS
  ) {
    persistWriter(writer, Number.isFinite(timestampMs) ? timestampMs : Date.now());
  }
}

// A normalized terminal write can itself fail after the terminal intent was
// persisted. The process will then return the supervisor-error exit instead
// of the earlier mapped result, so the private ledger must be corrected even
// when the public output latch prevents a second event.
export function recordLifecycleFailureIntent(
  writer,
  code,
  expectedExitCode,
  nowMs = Date.now()
) {
  if (!writer) {
    return;
  }
  if (
    typeof code !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(code) ||
    !MAPPED_EXIT_CODES.has(expectedExitCode)
  ) {
    ledgerFail("invalid_lifecycle_failure_intent");
  }
  writer.document.state = "terminal_intent";
  writer.document.terminalIntent = {
    type: "supervisor_error",
    code
  };
  writer.document.exitReconciliation = {
    status: "pending",
    expectedExitCode
  };
  persistWriter(writer, nowMs);
}

export function loadLifecycleLedger(ledgerFile) {
  const checked = assertPrivateLedgerFile(ledgerFile);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(checked, "utf8"));
  } catch {
    ledgerFail("invalid_lifecycle_ledger");
  }
  return {
    filePath: checked,
    document: validateLedgerDocument(parsed)
  };
}

export function reconcileLifecycleLedger({
  ledgerFile,
  processHandle,
  outcome,
  exitCode,
  nowMs = Date.now()
}) {
  const loaded = loadLifecycleLedger(ledgerFile);
  const activated = loaded.document.processHandle !== null;
  if (activated) {
    const handle = assertProcessHandle(processHandle);
    if (loaded.document.processHandle !== handle) {
      ledgerFail("lifecycle_handle_mismatch");
    }
  } else if (processHandle !== null) {
    // A supervisor can fail before host activation (for example EOF or an
    // activation timeout). In that state there is deliberately no process
    // handle in the ledger. Reconciliation must require an explicit null
    // rather than accepting a guessed host handle that was never bound.
    ledgerFail("lifecycle_handle_unexpected");
  }
  if (loaded.document.state === "exit_reconciled") {
    if (outcome !== "exited") {
      ledgerFail("lifecycle_reconciliation_outcome_mismatch");
    }
    if (!MAPPED_EXIT_CODES.has(exitCode)) {
      ledgerFail("lifecycle_exit_code_invalid");
    }
    const stored = loaded.document.exitReconciliation;
    if (stored.expectedExitCode !== exitCode || stored.exitCode !== exitCode) {
      ledgerFail("lifecycle_exit_code_mismatch");
    }
    return loaded.document;
  }
  if (loaded.document.state === "tracking_lost") {
    if (outcome !== "tracking_lost") {
      ledgerFail("lifecycle_tracking_lost");
    }
    if (exitCode !== undefined) {
      ledgerFail("lifecycle_exit_code_unexpected");
    }
    return loaded.document;
  }
  const observedAt = new Date(nowMs).toISOString();
  if (outcome === "exited") {
    if (!MAPPED_EXIT_CODES.has(exitCode)) {
      ledgerFail("lifecycle_exit_code_invalid");
    }
    if (!loaded.document.terminalIntent) {
      ledgerFail("lifecycle_terminal_missing");
    }
    const expected = loaded.document.exitReconciliation.expectedExitCode;
    if (expected !== exitCode) {
      ledgerFail("lifecycle_exit_code_mismatch");
    }
    loaded.document.state = "exit_reconciled";
    loaded.document.exitReconciliation = {
      status: "confirmed",
      expectedExitCode: expected,
      exitCode,
      reconciledAt: observedAt
    };
  } else if (outcome === "tracking_lost") {
    if (!activated) {
      ledgerFail("lifecycle_tracking_not_activated");
    }
    if (loaded.document.terminalIntent) {
      ledgerFail("lifecycle_terminal_already_present");
    }
    loaded.document.state = "tracking_lost";
    loaded.document.trackingFault = {
      code: "tracking_lost",
      observedAt
    };
    loaded.document.exitReconciliation = {
      status: "tracking_lost",
      reconciledAt: observedAt
    };
  } else {
    ledgerFail("lifecycle_outcome_invalid");
  }
  loaded.document.updatedAt = observedAt;
  writeLedgerFile(loaded.filePath, loaded.document, false);
  return loaded.document;
}
