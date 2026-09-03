import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACP_HOST_ACTIVATION_SCHEMA_VERSION,
  lifecycleLedgerPath,
  loadLifecycleLedger,
  reconcileLifecycleLedger
} from "./acp-lifecycle-ledger.mjs";
import {
  ACP_INJECTION_ENV,
  CLAUDE_FORBIDDEN_ENV,
  CLAUDE_INJECTION_ENV,
  CLAUDE_OAUTH_TOKEN_ENV,
  SCHEMA_VERSION as ACP_FOREGROUND_SCHEMA_VERSION,
  loadSupervisorConfig,
  modelReportingIdentity,
  parseDeliveredAt,
  REMOTE_PROVIDER_CLOCK_SKEW_MS
} from "./acpx-foreground-supervisor.mjs";
import {
  ACP_SUPPORTED_AGENTS,
  buildAcpIntermediateReport,
  buildAcpTerminalReport
} from "./acp-reporting-contract.mjs";

// v2 is an incompatible bump over acp-host-transport.v1: the private record
// gains the fenced publication-attempt state, `ack-report` requires the
// exact attempt/fencing identity, and the closed action set gains
// `claim-report` and `begin-delivery`. v1 records and inputs fail closed with
// the standard schema/record codes; complete or cancel an in-flight v1 run
// with the v1 skill before upgrading.
export const ACP_HOST_TRANSPORT_SCHEMA_VERSION = "acp-host-transport.v2";
export const ACP_HOST_CONTROLLER_LEASE_SCHEMA_VERSION = "acp-host-controller-lease.v1";
export const DEFAULT_TRANSPORT_EVENT_WAIT_MS = 5000;
export const REPORT_CADENCE_MS = 600000;
const REPORT_DELIVERY_SUCCESS_STATUSES = Object.freeze(["sent", "delivered"]);
export const MAX_REPORT_RECEIPT_AGE_MS = 300000;
export const MAX_SERVICE_CURSOR_REISSUES = 3;
// Bounded publication-attempt protocol: one report obligation allows at most
// this many claimed delivery attempts before the transport refuses to mint
// more and requires owner intervention.
export const MAX_REPORT_PUBLICATION_ATTEMPTS = 3;
// A claimed attempt is a live lease for this long. A newer claim may
// supersede only an expired attempt (recording its explicit missing/uncertain
// outcome); a live attempt is never silently stolen.
export const REPORT_ATTEMPT_TTL_MS = 300000;
// Exclusive record-mutation lock: bounded wait before failing closed, and the
// stale age after which a crashed holder's lock file may be taken over.
export const TRANSPORT_LOCK_WAIT_MS = 5000;
export const TRANSPORT_LOCK_STALE_MS = 30000;

const SAFE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_EVENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DECIMAL_ID = /^[0-9]{1,32}$/;
const MAX_EVENT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_RETURNED_EVENTS = 64;
const MAX_ACKNOWLEDGED_MESSAGE_IDS = 64;
const PASSTHROUGH_ENV = new Set([
  "HOME",
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "USER",
  "LOGNAME",
  "SHELL",
  "SSH_AUTH_SOCK",
  "NO_COLOR",
  "FORCE_COLOR"
]);
const RUNNER_ENV = new Set([
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "USER",
  "LOGNAME"
]);
const TMUX_CLEARED_ENV = Object.freeze([...new Set([
  ...ACP_INJECTION_ENV,
  ...CLAUDE_INJECTION_ENV,
  ...CLAUDE_FORBIDDEN_ENV,
  CLAUDE_OAUTH_TOKEN_ENV
])].sort());

function transportFail(code) {
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

function isPrivateMode(stat) {
  return process.platform === "win32" || (stat.mode & 0o077) === 0;
}

function assertAbsolute(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    transportFail(code);
  }
  return path.normalize(value);
}

function assertPrivateRegularFile(filePath, code) {
  const checked = assertAbsolute(filePath, code);
  let stat;
  try {
    stat = fs.lstatSync(checked);
  } catch (error) {
    transportFail(error && error.code === "ENOENT" ? `${code}_missing` : `${code}_unreadable`);
  }
  if (stat.isSymbolicLink()) {
    transportFail(`${code}_symlink`);
  }
  if (!stat.isFile()) {
    transportFail(`${code}_not_regular`);
  }
  if (!isPrivateMode(stat)) {
    transportFail(`${code}_permissions`);
  }
  return checked;
}

function preparePrivateDirectory(directory) {
  const checked = assertAbsolute(directory, "invalid_transport_state_dir");
  try {
    if (!fs.existsSync(checked)) {
      fs.mkdirSync(checked, { recursive: true, mode: 0o700 });
    }
    const stat = fs.lstatSync(checked);
    if (stat.isSymbolicLink()) {
      transportFail("invalid_transport_state_dir_symlink");
    }
    if (!stat.isDirectory()) {
      transportFail("invalid_transport_state_dir_not_directory");
    }
    if (!isPrivateMode(stat)) {
      transportFail("invalid_transport_state_dir_permissions");
    }
  } catch (error) {
    if (error && typeof error.code === "string" && error.code.startsWith("invalid_transport_")) {
      throw error;
    }
    transportFail("invalid_transport_state_dir");
  }
  return checked;
}

function writePrivateJson(filePath, value, flag = "wx") {
  try {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag
    });
    if (process.platform !== "win32") {
      fs.chmodSync(filePath, 0o600);
    }
  } catch (error) {
    transportFail(error && error.code === "EEXIST"
      ? "host_transport_record_exists"
      : "host_transport_record_write_failed");
  }
}

function replacePrivateJsonAtomically(filePath, value) {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, filePath);
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best-effort cleanup of the private sibling temp only.
    }
    transportFail("host_transport_record_write_failed");
  }
}

function sleepSyncMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Exclusive lease for every transport-record mutation. Atomic sibling-temp
// rename only prevents torn files; it is NOT serialization — two concurrent
// read-modify-write callers could still each rename a complete-but-stale
// record. This lock serializes the whole read-modify-write critical section,
// while the monotonic publication fence (record.publication.fence) orders the
// long-lived claim→deliver→acknowledge attempts that span multiple calls.
// A live lock is never silently stolen: takeover happens only after the
// bounded stale age, which only a crashed or wedged holder can reach because
// every action releases the lock before returning.
function acquireTransportLock(recordFile, action, dependencies = {}) {
  const lockFile = `${recordFile}.lock`;
  const waitMs = dependencies.lockWaitMs ?? TRANSPORT_LOCK_WAIT_MS;
  const staleMs = dependencies.lockStaleMs ?? TRANSPORT_LOCK_STALE_MS;
  const sleep = dependencies.sleepMs ?? sleepSyncMs;
  const ownerToken = crypto.randomUUID();
  const deadlineMs = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({
        schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
        type: "host_transport_lease",
        action,
        ownerToken,
        acquiredAtMs: Date.now()
      }) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        transportFail("host_transport_lock_failed");
      }
    }
    let stat = null;
    try {
      stat = fs.lstatSync(lockFile);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        continue;
      }
      transportFail("host_transport_lock_failed");
    }
    if (Date.now() - stat.mtimeMs > staleMs) {
      // Expired lease of a crashed holder — not a live lease. Remove it and
      // race for a fresh acquisition; losing that race just loops again.
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // Another taker may have removed it first.
      }
      continue;
    }
    if (Date.now() >= deadlineMs) {
      transportFail("host_transport_lock_timeout");
    }
    sleep(25);
  }
  return function releaseTransportLock() {
    try {
      const holder = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      if (holder && holder.ownerToken === ownerToken) {
        fs.unlinkSync(lockFile);
      }
    } catch {
      // Release is best-effort: an unreadable or foreign lock is left alone
      // and a leftover lease is reclaimed later through the stale-age path.
    }
  };
}

// Every record mutation runs through this wrapper: validate the private
// record path, take the exclusive lease, and only then read-modify-write the
// record, so no interleaved caller can act on a stale copy.
function withTransportRecord(transportFile, action, dependencies, fn) {
  const checked = assertPrivateRegularFile(transportFile, "host_transport_file");
  const release = acquireTransportLock(checked, action, dependencies);
  try {
    return fn(loadHostTransportRecord(checked));
  } finally {
    release();
  }
}

function exactKeys(value, required) {
  return isPlainObject(value) &&
    Object.keys(value).length === required.length &&
    required.every((key) => Object.hasOwn(value, key));
}

function validInstant(value) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function nowValue(dependencies) {
  const value = dependencies.nowMs;
  return typeof value === "function" ? value() : value ?? Date.now();
}

function newPrivateId(prefix, dependencies) {
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function initialPublicationState() {
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
    // Fenced publication-attempt protocol: `fence` increases monotonically on
    // every claimed attempt, `attempt` is the single live claim (delivery
    // states claim_acquired → delivery_pending), `attemptCount` bounds
    // retries per report obligation, and `lastAttemptOutcome` records the
    // explicit acknowledged/uncertain/missing end of the previous attempt.
    fence: 0,
    attempt: null,
    attemptCount: 0,
    lastAttemptOutcome: null,
    // `halted` stops all publication after tracking loss; `pumpJobId` binds
    // the one scheduler job identity allowed to claim reports for this run.
    halted: null,
    pumpJobId: null
  };
}

function initialControllerLeaseState() {
  return { phase: "prepared" };
}

function validateControllerLease(value) {
  if (!exactKeys(value, ["phase"]) || ![
    "prepared",
    "activation_in_progress",
    "activation_confirmed",
    "preactivation_aborted"
  ].includes(value.phase)) {
    transportFail("host_transport_record_invalid");
  }
  return value;
}

function isPumpJobId(value) {
  // Mirrors the reporting contract's reportPump.id rule: 1..200 characters
  // with no whitespace or control characters.
  return typeof value === "string" &&
    value.length >= 1 && value.length <= 200 &&
    !/[\s\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value);
}

// The public 마지막 ACP 활동 age is bound to normalized ACP activity events
// only — envelope `type: "activity"`, the model/tool/status activity of the
// exact execution handle. Host lifecycle/control marks (`activation_confirmed`,
// `started`) are not ACP activity, and neither are timer-driven `progress`
// bookkeeping, transport poll boundaries, report rendering and delivery
// receipts, phase bookkeeping, or owner-side work — none of these may move
// (or substitute for) the activity instant. With no normalized ACP activity
// event yet, the value stays a fail-closed null instead of borrowing a
// lifecycle timestamp.
function lastAcpActivityInstant(events) {
  let lastMs = null;
  for (const event of events) {
    if (event.type !== "activity") {
      continue;
    }
    const milliseconds = Date.parse(event.timestamp);
    if (Number.isFinite(milliseconds) && (lastMs === null || milliseconds > lastMs)) {
      lastMs = milliseconds;
    }
  }
  return lastMs === null ? null : new Date(lastMs).toISOString();
}

function validateReportingContext(value) {
  if (!exactKeys(value, [
    "agent", "model", "roundIndex", "repository", "branch", "controlConversationId"
  ]) || !ACP_SUPPORTED_AGENTS.includes(value.agent) ||
    typeof value.model !== "string" || value.model.length < 1 || value.model.length > 256 ||
    !Number.isSafeInteger(value.roundIndex) || value.roundIndex < 1 ||
    typeof value.repository !== "string" || typeof value.branch !== "string" ||
    typeof value.controlConversationId !== "string" || !DECIMAL_ID.test(value.controlConversationId)) {
    transportFail("host_transport_record_invalid");
  }
  return value;
}

function validatePublication(value) {
  const keys = [
    "state", "kind", "cadence", "reportId", "requiredAt",
    "evidenceThroughSequence", "receiptMessageId", "acknowledgedMessageIds", "nextCadence", "nextDueAt",
    "terminalSequence", "terminalStatus", "controlCursor", "controlCursorIssuedAt",
    "controlCursorReissues", "fence", "attempt", "attemptCount", "lastAttemptOutcome",
    "halted", "pumpJobId"
  ];
  if (!exactKeys(value, keys) ||
    !["report_required", "publication_pending", "receipt_acked"].includes(value.state) ||
    ![null, "intermediate", "terminal"].includes(value.kind) ||
    !Number.isSafeInteger(value.cadence) || value.cadence < 0 ||
    !Number.isSafeInteger(value.evidenceThroughSequence) || value.evidenceThroughSequence < 0 ||
    !Number.isSafeInteger(value.nextCadence) || value.nextCadence < 1 ||
    (value.reportId !== null && !SAFE_HANDLE.test(value.reportId)) ||
    (value.requiredAt !== null && !validInstant(value.requiredAt)) ||
    (value.nextDueAt !== null && !validInstant(value.nextDueAt)) ||
    (value.receiptMessageId !== null && !DECIMAL_ID.test(value.receiptMessageId)) ||
    !Array.isArray(value.acknowledgedMessageIds) ||
    value.acknowledgedMessageIds.length > MAX_ACKNOWLEDGED_MESSAGE_IDS ||
    value.acknowledgedMessageIds.some((messageId) => typeof messageId !== "string" || !DECIMAL_ID.test(messageId)) ||
    new Set(value.acknowledgedMessageIds).size !== value.acknowledgedMessageIds.length ||
    (value.terminalSequence !== null && (!Number.isSafeInteger(value.terminalSequence) || value.terminalSequence < 1)) ||
    ![null, "completed", "cancelled", "failed"].includes(value.terminalStatus) ||
    (value.controlCursor !== null && !SAFE_HANDLE.test(value.controlCursor)) ||
    (value.controlCursorIssuedAt !== null && !validInstant(value.controlCursorIssuedAt)) ||
    ((value.controlCursor === null) !== (value.controlCursorIssuedAt === null)) ||
    !Number.isSafeInteger(value.controlCursorReissues) ||
    value.controlCursorReissues < 0 || value.controlCursorReissues > MAX_SERVICE_CURSOR_REISSUES ||
    (value.controlCursor === null && value.controlCursorReissues !== 0) ||
    !Number.isSafeInteger(value.fence) || value.fence < 0 ||
    !Number.isSafeInteger(value.attemptCount) ||
    value.attemptCount < 0 || value.attemptCount > MAX_REPORT_PUBLICATION_ATTEMPTS ||
    ![null, "acknowledged", "uncertain", "missing"].includes(value.lastAttemptOutcome) ||
    ![null, "tracking_lost"].includes(value.halted) ||
    (value.pumpJobId !== null && !isPumpJobId(value.pumpJobId))) {
    transportFail("host_transport_record_invalid");
  }
  const attempt = value.attempt;
  const validAttempt = attempt === null || (
    exactKeys(attempt, [
      "attemptId", "fence", "state", "jobId", "runToken", "claimedAt", "expiresAt"
    ]) &&
    typeof attempt.attemptId === "string" && SAFE_HANDLE.test(attempt.attemptId) &&
    attempt.fence === value.fence && value.fence >= 1 &&
    ["claim_acquired", "delivery_pending"].includes(attempt.state) &&
    isPumpJobId(attempt.jobId) && attempt.jobId === value.pumpJobId &&
    typeof attempt.runToken === "string" && SAFE_HANDLE.test(attempt.runToken) &&
    validInstant(attempt.claimedAt) && validInstant(attempt.expiresAt) &&
    Date.parse(attempt.expiresAt) > Date.parse(attempt.claimedAt)
  );
  if (!validAttempt ||
    (attempt !== null && (value.state === "receipt_acked" || value.kind === null)) ||
    (attempt !== null && value.attemptCount < 1)) {
    transportFail("host_transport_record_invalid");
  }
  const hasReportIdentity = value.kind !== null && value.reportId !== null && value.requiredAt !== null;
  const validKindShape = value.kind === null
    ? value.cadence === 0 && value.reportId === null && value.requiredAt === null &&
      value.receiptMessageId === null && value.terminalSequence === null && value.terminalStatus === null
    : value.kind === "intermediate"
      ? value.cadence >= 1 && value.terminalSequence === null && value.terminalStatus === null
      : value.cadence === 0 && value.terminalSequence !== null && value.terminalStatus !== null;
  const validStateShape = value.state === "receipt_acked"
    ? value.kind === null || (hasReportIdentity && value.receiptMessageId !== null)
    : hasReportIdentity && value.receiptMessageId === null;
  if (!validKindShape || !validStateShape) {
    transportFail("host_transport_record_invalid");
  }
  return value;
}

function persistTransportRecord(loaded) {
  replacePrivateJsonAtomically(loaded.filePath, loaded.record);
}

function runTmuxDefault(args, options = {}) {
  return spawnSync("tmux", args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 5000,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function requireTmux(runTmux) {
  const result = runTmux(["-V"], { timeoutMs: 5000 });
  if (result.error && result.error.code === "ENOENT") {
    transportFail("host_transport_tmux_missing");
  }
  if (result.error || result.status !== 0 || !/^tmux \d/.test(String(result.stdout).trim())) {
    transportFail("host_transport_tmux_unavailable");
  }
}

function requireCleanEnvironmentCommand(statFile = fs.lstatSync) {
  let stat;
  try {
    stat = statFile("/usr/bin/env");
  } catch (error) {
    transportFail(error && error.code === "ENOENT"
      ? "host_transport_env_missing"
      : "host_transport_env_unavailable");
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (stat.mode & 0o111) === 0
  ) {
    transportFail("host_transport_env_unavailable");
  }
}

function assertHandle(value) {
  if (typeof value !== "string" || !SAFE_HANDLE.test(value)) {
    transportFail("host_transport_handle_invalid");
  }
  return value;
}

function createHandle(randomUUID) {
  const token = randomUUID().replaceAll("-", "").slice(0, 24);
  return assertHandle(`acp-${token}`);
}

function selectChildEnvironment(config, environment) {
  const selected = {};
  for (const name of PASSTHROUGH_ENV) {
    if (typeof environment[name] === "string") {
      selected[name] = environment[name];
    }
  }
  for (const name of config.requiredEnv) {
    if (typeof environment[name] === "string") {
      selected[name] = environment[name];
    }
  }
  if (config.agent === "codex" && typeof environment.CODEX_PATH === "string") {
    selected.CODEX_PATH = environment.CODEX_PATH;
  }
  return selected;
}

function selectRunnerEnvironmentArgs(environment) {
  const args = [];
  for (const name of RUNNER_ENV) {
    if (typeof environment[name] === "string") {
      args.push(`${name}=${environment[name]}`);
    }
  }
  return args;
}

function entryFileForAgent(agent) {
  const sibling = agent === "claude"
    ? "claude-acp-launcher.mjs"
    : "acpx-foreground-supervisor.mjs";
  return fileURLToPath(new URL(sibling, import.meta.url));
}

function runnerFile() {
  return fileURLToPath(new URL("acp-host-transport-runner.mjs", import.meta.url));
}

function parseTransportRecord(value) {
  const required = [
    "schemaVersion",
    "transportId",
    "processHandle",
    "configFile",
    "entryFile",
    "eventsFile",
    "stderrFile",
    "exitFile",
    "environmentFile",
    "createdAt",
    "reportingContext",
    "publication"
  ];
  if (
    !isPlainObject(value) ||
    !Object.keys(value).every((key) => required.includes(key) || key === "controllerLease") ||
    !required.every((key) => Object.hasOwn(value, key)) ||
    value.schemaVersion !== ACP_HOST_TRANSPORT_SCHEMA_VERSION ||
    typeof value.transportId !== "string" ||
    !SAFE_HANDLE.test(value.transportId) ||
    value.processHandle !== value.transportId ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    transportFail("host_transport_record_invalid");
  }
  for (const key of [
    "configFile",
    "entryFile",
    "eventsFile",
    "stderrFile",
    "exitFile",
    "environmentFile"
  ]) {
    assertAbsolute(value[key], "host_transport_record_invalid");
  }
  validateReportingContext(value.reportingContext);
  validatePublication(value.publication);
  if (value.controllerLease !== undefined) validateControllerLease(value.controllerLease);
  return value;
}

export function loadHostTransportRecord(transportFile) {
  const checked = assertPrivateRegularFile(transportFile, "host_transport_file");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(checked, "utf8"));
  } catch {
    transportFail("host_transport_record_invalid");
  }
  return {
    filePath: checked,
    record: parseTransportRecord(parsed)
  };
}

function parseEvents(eventsFile) {
  if (!fs.existsSync(eventsFile)) {
    return [];
  }
  let stat;
  try {
    stat = fs.lstatSync(eventsFile);
  } catch {
    transportFail("host_transport_events_unreadable");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || !isPrivateMode(stat)) {
    transportFail("host_transport_events_invalid");
  }
  if (stat.size > MAX_EVENT_FILE_BYTES) {
    transportFail("host_transport_events_oversize");
  }
  const text = fs.readFileSync(eventsFile, "utf8");
  if (text.length === 0) {
    return [];
  }
  const lines = text.split("\n");
  // A status poll can race a single append. Only newline-terminated NDJSON
  // records are evidence; keep a partial tail invisible until the next poll
  // instead of turning an ordinary write boundary into a transport failure.
  lines.pop();
  const events = [];
  let runId;
  let requestId;
  let lastSequence = 0;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line.replace(/\r$/, ""));
    } catch {
      transportFail("host_transport_events_invalid");
    }
    if (
      !isPlainObject(event) ||
      event.schemaVersion !== ACP_FOREGROUND_SCHEMA_VERSION ||
      typeof event.type !== "string" ||
      !SAFE_EVENT_TYPE.test(event.type)
    ) {
      transportFail("host_transport_events_invalid");
    }
    if (event.type === "launcher_error") {
      if (
        events.length !== 0 ||
        lines.length !== 1 ||
        typeof event.code !== "string" ||
        !SAFE_EVENT_TYPE.test(event.code)
      ) {
        transportFail("host_transport_events_invalid");
      }
      events.push({ ...event, sequence: 1 });
      continue;
    }
    if (
      !Number.isSafeInteger(event.sequence) ||
      event.sequence < 1 ||
      typeof event.runId !== "string" ||
      !SAFE_HANDLE.test(event.runId) ||
      typeof event.requestId !== "string" ||
      !SAFE_HANDLE.test(event.requestId) ||
      event.sequence <= lastSequence
    ) {
      transportFail("host_transport_events_invalid");
    }
    if (
      (runId !== undefined && event.runId !== runId) ||
      (requestId !== undefined && event.requestId !== requestId)
    ) {
      transportFail("host_transport_events_invalid");
    }
    runId = event.runId;
    requestId = event.requestId;
    lastSequence = event.sequence;
    events.push(event);
  }
  return events;
}

function sessionExists(runTmux, handle) {
  const result = runTmux(["has-session", "-t", `=${handle}`], { timeoutMs: 5000 });
  if (result.error) {
    transportFail("host_transport_tmux_unavailable");
  }
  return result.status === 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvent(record, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TRANSPORT_EVENT_WAIT_MS;
  const sleep = options.delay ?? delay;
  const startedAt = Date.now();
  let waitMs = 25;
  while (Date.now() - startedAt <= timeoutMs) {
    const events = parseEvents(record.eventsFile);
    const matched = events.find(predicate);
    if (matched) {
      return { event: matched, events };
    }
    await sleep(waitMs);
    waitMs = Math.min(waitMs * 2, 250);
  }
  transportFail("host_transport_event_timeout");
}

function exitCodeFromFile(exitFile) {
  if (!fs.existsSync(exitFile)) {
    return null;
  }
  const checked = assertPrivateRegularFile(exitFile, "host_transport_exit_file");
  const raw = fs.readFileSync(checked, "utf8").trim();
  if (!/^(?:0|20|21|22|64)$/.test(raw)) {
    transportFail("host_transport_exit_invalid");
  }
  return Number.parseInt(raw, 10);
}

export function probeHostTransport(dependencies = {}) {
  if ((dependencies.platform ?? process.platform) === "win32") {
    transportFail("host_transport_platform_unsupported");
  }
  requireCleanEnvironmentCommand(dependencies.statFile ?? fs.lstatSync);
  requireTmux(dependencies.runTmux ?? runTmuxDefault);
  return {
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    type: "host_transport_ready"
  };
}

export function prepareHostTransport(input, dependencies = {}) {
  probeHostTransport(dependencies);
  const configFile = assertPrivateRegularFile(input.configFile, "host_transport_config_file");
  const config = (dependencies.loadConfig ?? loadSupervisorConfig)(configFile);
  const stateDir = preparePrivateDirectory(config.stateDir);
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
  const handle = createHandle(randomUUID);
  const prefix = path.join(stateDir, `host-transport-${handle}`);
  const recordFile = `${prefix}.json`;
  const eventsFile = `${prefix}.events.ndjson`;
  const stderrFile = `${prefix}.stderr.log`;
  const exitFile = `${prefix}.exit`;
  const environmentFile = `${prefix}.env.json`;
  const entryFile = entryFileForAgent(config.agent);
  const record = {
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    transportId: handle,
    processHandle: handle,
    configFile,
    entryFile,
    eventsFile,
    stderrFile,
    exitFile,
    environmentFile,
    createdAt: new Date(nowValue(dependencies)).toISOString(),
    reportingContext: {
      agent: config.agent,
      // Bind acknowledgements to the same deterministic public identity that
      // config/reporting validation and the supervisor's started event use.
      // The base Codex model remains separate in the supervisor config and is
      // never replaced by this display-only composite value.
      model: modelReportingIdentity(
        config.agent,
        config.model,
        config.reasoningEffort
      ),
      roundIndex: config.reporting.roundIndex,
      repository: config.reporting.repository,
      branch: config.reporting.branch,
      controlConversationId: config.lifecycle.controlConversationId
    },
    publication: {
      ...initialPublicationState(),
      // An acp-reporting-v3 config attests the enabled report-pump automation
      // id; bind it now so only that exact scheduler job can claim reports.
      // v1/v2 watchdog configs stay accepted (bounded migration): their
      // records bind the pump job on its first successful claim instead.
      pumpJobId: typeof config.reporting?.reportPump?.id === "string"
        ? config.reporting.reportPump.id
        : null
    },
    controllerLease: initialControllerLeaseState()
  };
  const environment = dependencies.environment ?? process.env;
  writePrivateJson(environmentFile, selectChildEnvironment(
    config,
    environment
  ));
  writePrivateJson(recordFile, record);

  const runTmux = dependencies.runTmux ?? runTmuxDefault;
  const result = runTmux([
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_name}",
    "-s",
    handle,
    ...TMUX_CLEARED_ENV.flatMap((name) => ["-e", `${name}=`]),
    "--",
    "/usr/bin/env",
    "-i",
    ...selectRunnerEnvironmentArgs(environment),
    process.execPath,
    runnerFile(),
    "--transport",
    recordFile
  ], { timeoutMs: 5000 });
  if (result.error || result.status !== 0 || String(result.stdout).trim() !== handle) {
    if (!result.error && result.status === 0) {
      try {
        runTmux(["kill-session", "-t", `=${handle}`], { timeoutMs: 5000 });
      } catch {
        // The session name is random and owned by this successful launch;
        // cleanup failure must not turn an invalid prepare result into success.
      }
    }
    for (const file of [recordFile, environmentFile]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Best-effort cleanup of private preparation files only.
      }
    }
    transportFail("host_transport_prepare_failed");
  }
  return {
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    type: "host_transport_prepared",
    processHandle: handle,
    transportFile: recordFile
  };
}

export async function activateHostTransport(input, dependencies = {}) {
  const loaded = loadHostTransportRecord(input.transportFile);
  const handle = assertHandle(input.processHandle);
  if (loaded.record.processHandle !== handle) {
    transportFail("host_transport_handle_mismatch");
  }
  const runTmux = dependencies.runTmux ?? runTmuxDefault;
  if (!sessionExists(runTmux, handle)) {
    transportFail("host_transport_not_running");
  }
  const required = await waitForEvent(
    loaded.record,
    (event) => ["activation_required", "supervisor_error", "launcher_error"].includes(event.type),
    dependencies
  );
  if (required.event.type !== "activation_required") {
    transportFail("host_transport_pre_activation_failed");
  }
  withTransportRecord(input.transportFile, "activate-begin", dependencies, (locked) => {
    if (locked.record.processHandle !== handle) {
      transportFail("host_transport_handle_mismatch");
    }
    if (locked.record.controllerLease.phase !== "prepared") {
      transportFail("host_transport_activation_state_invalid");
    }
    const events = parseEvents(locked.record.eventsFile);
    if (!events.some((event) => event.type === "activation_required") ||
        events.some((event) => event.type !== "activation_required")) {
      transportFail("host_transport_activation_state_uncertain");
    }
    if (!sessionExists(runTmux, handle)) {
      transportFail("host_transport_not_running");
    }
    locked.record.controllerLease.phase = "activation_in_progress";
    persistTransportRecord(locked);
  });
  const activation = JSON.stringify({
    schemaVersion: ACP_HOST_ACTIVATION_SCHEMA_VERSION,
    processHandle: handle
  }) + "\n";
  const bufferName = `acp-${crypto.randomBytes(8).toString("hex")}`;
  const setResult = runTmux(["set-buffer", "-b", bufferName, activation], { timeoutMs: 5000 });
  if (setResult.error || setResult.status !== 0) {
    withTransportRecord(input.transportFile, "activate-reset", dependencies, (locked) => {
      if (locked.record.processHandle !== handle ||
          locked.record.controllerLease.phase !== "activation_in_progress") {
        transportFail("host_transport_activation_state_uncertain");
      }
      locked.record.controllerLease.phase = "prepared";
      persistTransportRecord(locked);
    });
    transportFail("host_transport_activation_write_failed");
  }
  const pasteResult = runTmux([
    "paste-buffer",
    "-d",
    "-b",
    bufferName,
    "-t",
    `=${handle}:0.0`
  ], { timeoutMs: 5000 });
  if (pasteResult.error || pasteResult.status !== 0) {
    transportFail("host_transport_activation_write_failed");
  }
  const confirmed = await waitForEvent(
    loaded.record,
    (event) => event.type === "activation_confirmed" || event.type === "supervisor_error",
    dependencies
  );
  if (confirmed.event.type !== "activation_confirmed") {
    transportFail("host_transport_activation_rejected");
  }
  const activatedAtMs = Date.parse(confirmed.event.timestamp);
  const elapsedAtActivation = Number.isSafeInteger(confirmed.event.elapsedMs) && confirmed.event.elapsedMs >= 0
    ? confirmed.event.elapsedMs
    : 0;
  const elapsedOriginMs = (Number.isFinite(activatedAtMs) ? activatedAtMs : nowValue(dependencies)) -
    elapsedAtActivation;
  // Reload under the exclusive record lease for the read-modify-write of the
  // cadence anchor; the earlier load only served pre-activation event waits.
  withTransportRecord(input.transportFile, "activate", dependencies, (locked) => {
    if (locked.record.processHandle !== handle ||
        locked.record.controllerLease.phase !== "activation_in_progress") {
      transportFail("host_transport_activation_state_uncertain");
    }
    const events = parseEvents(locked.record.eventsFile);
    if (!events.some((event) => event.type === "activation_confirmed")) {
      transportFail("host_transport_activation_state_uncertain");
    }
    locked.record.controllerLease.phase = "activation_confirmed";
    locked.record.publication.nextDueAt = new Date(
      elapsedOriginMs + REPORT_CADENCE_MS
    ).toISOString();
    persistTransportRecord(locked);
  });
  return {
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    type: "host_transport_activated",
    processHandle: handle,
    lifecycleLedgerFile: lifecycleLedgerPath(
      path.dirname(loaded.record.eventsFile),
      confirmed.event.runId
    )
  };
}

function controllerLeaseResult(type, processHandle) {
  return {
    schemaVersion: ACP_HOST_CONTROLLER_LEASE_SCHEMA_VERSION,
    type,
    processHandle
  };
}

// Plugin-facing proof surface. The proof comes only from the exact private
// record after activate has durably fenced and observed activation_confirmed.
export function confirmHostTransportActivation(input, dependencies = {}) {
  const handle = assertHandle(input.processHandle);
  return withTransportRecord(input.transportFile, "confirm-activation", dependencies, (loaded) => {
    if (loaded.record.processHandle !== handle ||
        loaded.record.controllerLease.phase !== "activation_confirmed") {
      transportFail("host_transport_activation_not_confirmed");
    }
    const events = parseEvents(loaded.record.eventsFile);
    if (!events.some((event) => event.type === "activation_confirmed")) {
      transportFail("host_transport_activation_not_confirmed");
    }
    return controllerLeaseResult("host_transport_activation_confirmed", handle);
  });
}

function hasUnsafePreactivationEvidence(events) {
  return events.some((event) => !["activation_required", "launcher_error"].includes(event.type));
}

const NORMALIZED_EVENT_BASE_KEYS = Object.freeze([
  "schemaVersion",
  "runId",
  "requestId",
  "sequence",
  "timestamp",
  "elapsedMs",
  "type"
]);

function isExactNormalizedEvent(event, type, payloadKeys) {
  return exactKeys(event, [...NORMALIZED_EVENT_BASE_KEYS, ...payloadKeys]) &&
    event.schemaVersion === ACP_FOREGROUND_SCHEMA_VERSION &&
    event.type === type &&
    typeof event.runId === "string" && SAFE_HANDLE.test(event.runId) &&
    typeof event.requestId === "string" && SAFE_HANDLE.test(event.requestId) &&
    Number.isSafeInteger(event.sequence) && event.sequence >= 1 &&
    validInstant(event.timestamp) &&
    Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= 0;
}

// `activation_in_progress` normally means that the activation line may have
// reached the PTY and therefore cannot be rolled back. The sole safe
// exception is the supervisor's closed, canonical rejection sequence: its
// first event requests activation and its second (and final) event rejects it
// before activation confirmation or any ACP mutation/activity evidence.
// Exact keys keep arbitrary event payloads and message-text classifications
// out of this proof boundary.
function hasExactPreactivationSupervisorRejection(events) {
  if (events.length !== 2) return false;
  const [required, rejected] = events;
  if (!isExactNormalizedEvent(required, "activation_required", ["activationSchemaVersion"]) ||
      required.activationSchemaVersion !== ACP_HOST_ACTIVATION_SCHEMA_VERSION ||
      required.sequence !== 1 ||
      !isExactNormalizedEvent(rejected, "supervisor_error", ["code"]) ||
      typeof rejected.code !== "string" || !SAFE_EVENT_TYPE.test(rejected.code) ||
      rejected.sequence !== 2) {
    return false;
  }
  return rejected.runId === required.runId &&
    rejected.requestId === required.requestId &&
    Date.parse(rejected.timestamp) >= Date.parse(required.timestamp) &&
    rejected.elapsedMs >= required.elapsedMs;
}

// Plugin-facing preactivation rollback. The record lease serializes this
// decision with activate-begin. No process id is accepted or inferred: only
// the exact tmux session handle created by prepare may be stopped.
export function abortHostTransportPreactivation(input, dependencies = {}) {
  const handle = assertHandle(input.processHandle);
  return withTransportRecord(input.transportFile, "abort-preactivation", dependencies, (loaded) => {
    if (loaded.record.processHandle !== handle) {
      transportFail("host_transport_handle_mismatch");
    }
    if (loaded.record.controllerLease.phase === "preactivation_aborted") {
      return controllerLeaseResult("host_transport_preactivation_aborted", handle);
    }
    const phase = loaded.record.controllerLease.phase;
    if (!["prepared", "activation_in_progress"].includes(phase)) {
      transportFail("host_transport_preactivation_abort_denied");
    }
    const events = parseEvents(loaded.record.eventsFile);
    const rejectedBeforeActivation = phase === "activation_in_progress" &&
      hasExactPreactivationSupervisorRejection(events);
    if ((phase === "activation_in_progress" && !rejectedBeforeActivation) ||
        (phase === "prepared" && hasUnsafePreactivationEvidence(events))) {
      transportFail("host_transport_preactivation_abort_denied");
    }
    const runTmux = dependencies.runTmux ?? runTmuxDefault;
    const active = sessionExists(runTmux, handle);
    if (active) {
      const stopped = runTmux(["kill-session", "-t", `=${handle}`], { timeoutMs: 5000 });
      if (stopped.error || stopped.status !== 0) {
        transportFail("host_transport_preactivation_abort_denied");
      }
    } else {
      const exitCode = exitCodeFromFile(loaded.record.exitFile);
      const mappedExit = rejectedBeforeActivation ? exitCode === 22 : [22, 64].includes(exitCode);
      if (!mappedExit || events.length === 0) {
        transportFail("host_transport_preactivation_abort_denied");
      }
    }
    loaded.record.controllerLease.phase = "preactivation_aborted";
    persistTransportRecord(loaded);
    return controllerLeaseResult("host_transport_preactivation_aborted", handle);
  });
}

function validateServiceCursorAck(loaded, acknowledgement, reissue, nowMs) {
  const publication = loaded.record.publication;
  if (reissue !== undefined && reissue !== true) {
    transportFail("host_transport_service_cursor_reissue_invalid");
  }
  if (publication.controlCursor === null) {
    if (acknowledgement !== undefined || reissue === true) {
      transportFail("host_transport_service_cursor_unexpected");
    }
    return false;
  }
  if (reissue === true) {
    if (acknowledgement !== undefined) {
      transportFail("host_transport_service_cursor_reissue_invalid");
    }
    if (nowMs - Date.parse(publication.controlCursorIssuedAt) > MAX_REPORT_RECEIPT_AGE_MS) {
      transportFail("host_transport_service_cursor_reissue_expired");
    }
    if (publication.controlCursorReissues >= MAX_SERVICE_CURSOR_REISSUES) {
      transportFail("host_transport_service_cursor_reissue_exhausted");
    }
    publication.controlCursorReissues += 1;
    return true;
  }
  if (!exactKeys(acknowledgement, ["cursor", "conversationId", "servicedAt"]) ||
    acknowledgement.cursor !== publication.controlCursor ||
    acknowledgement.conversationId !== loaded.record.reportingContext.controlConversationId ||
    !validInstant(acknowledgement.servicedAt)) {
    transportFail("host_transport_service_cursor_invalid");
  }
  const servicedAt = Date.parse(acknowledgement.servicedAt);
  const issuedAt = Date.parse(publication.controlCursorIssuedAt);
  if (servicedAt < issuedAt || servicedAt > nowMs || nowMs - servicedAt > MAX_REPORT_RECEIPT_AGE_MS) {
    transportFail("host_transport_service_cursor_stale");
  }
  publication.controlCursor = null;
  publication.controlCursorIssuedAt = null;
  publication.controlCursorReissues = 0;
  return false;
}

function terminalStatus(event) {
  return event.type === "terminal" && ["completed", "cancelled", "failed"].includes(event.status)
    ? event.status
    : "failed";
}

export function requireReport(loaded, kind, cadence, requiredAtMs, evidenceThroughSequence, terminal = null, dependencies = {}) {
  const publication = loaded.record.publication;
  publication.state = "report_required";
  publication.kind = kind;
  publication.cadence = cadence;
  publication.reportId = newPrivateId("report", dependencies);
  publication.requiredAt = new Date(requiredAtMs).toISOString();
  publication.evidenceThroughSequence = evidenceThroughSequence;
  publication.receiptMessageId = null;
  if (terminal) {
    publication.terminalSequence = terminal.sequence;
    publication.terminalStatus = terminalStatus(terminal);
  } else {
    // An intermediate writer must always produce the shape accepted by
    // validatePublication, even if it is reused against mutated test state.
    publication.terminalSequence = null;
    publication.terminalStatus = null;
  }
}

function reportBoundary(publication, events) {
  if (publication.kind === null) return null;
  return {
    state: publication.state,
    // Explicit delivery-state model of the fenced attempt protocol:
    // claim_acquired → delivery_pending → acknowledged. `unclaimed` marks an
    // obligation whose attempt slot is empty (a superseded attempt awaiting
    // its bounded re-claim).
    deliveryState: publication.state === "receipt_acked"
      ? "acknowledged"
      : publication.attempt !== null
        ? publication.attempt.state
        : "unclaimed",
    lastAttemptOutcome: publication.lastAttemptOutcome,
    reportId: publication.reportId,
    kind: publication.kind,
    cadence: publication.cadence,
    requiredAt: publication.requiredAt,
    ...(publication.kind === "terminal"
      ? { terminalStatus: publication.terminalStatus }
      : {
          // Recomputed from the exact handle's event log on every status, so
          // a poll, a receipt, or bookkeeping can never reset it. It is the
          // only derived value here: the transport sees raw normalized
          // events and cannot classify material result artifacts (a
          // completed tool call is activity, never a result), so the public
          // Δ count and its result cursor live in the owner-confirmed
          // reporting snapshot, not on this boundary.
          lastAcpActivityAt: lastAcpActivityInstant(events)
        })
  };
}

function findTerminalEvent(events) {
  return events.find((event) => [
    "terminal",
    "supervisor_error",
    "launcher_error"
  ].includes(event.type));
}

// Observation only. `status` reports the stored publication boundary, issues
// service cursors, and returns bounded evidence, but it never mints,
// supersedes, or re-claims a report obligation: publication transitions are
// owned exclusively by the closed `claim-report` action, so a status poll can
// never race a claimer into double-minting an obligation.
export function statusHostTransport(input, dependencies = {}) {
  const handle = assertHandle(input.processHandle);
  const afterSequence = input.afterSequence ?? 0;
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    transportFail("host_transport_cursor_invalid");
  }
  return withTransportRecord(input.transportFile, "status", dependencies, (loaded) => {
    if (loaded.record.processHandle !== handle) {
      transportFail("host_transport_handle_mismatch");
    }
    const nowMs = nowValue(dependencies);
    const reissuingCursor = validateServiceCursorAck(
      loaded,
      input.serviceCursorAck,
      input.reissueServiceCursor,
      nowMs
    );
    const events = parseEvents(loaded.record.eventsFile);
    const terminal = findTerminalEvent(events);
    const publication = loaded.record.publication;
    const evidenceLimit = publication.state === "receipt_acked"
      ? Number.POSITIVE_INFINITY
      : publication.evidenceThroughSequence;
    const selected = events
      .filter((event) => event.sequence > afterSequence)
      .filter((event) => event.sequence <= evidenceLimit || event.sequence === publication.terminalSequence)
      .slice(0, MAX_RETURNED_EVENTS);
    const selectedSequences = new Set(selected.map((event) => event.sequence));
    let returnedSequence = afterSequence;
    // A terminal may be exposed out of order while an intermediate boundary
    // hides newer evidence. Advance only across the consecutive event-log
    // prefix actually returned; after terminal receipt acknowledgement the
    // lifted boundary makes the hidden gap available to the next poll.
    for (const event of events) {
      if (event.sequence <= afterSequence) continue;
      if (!selectedSequences.has(event.sequence)) break;
      returnedSequence = event.sequence;
    }
    const exitCode = exitCodeFromFile(loaded.record.exitFile);
    const active = sessionExists(dependencies.runTmux ?? runTmuxDefault, handle);
    const cursor = reissuingCursor
      ? publication.controlCursor
      : newPrivateId("service", dependencies);
    if (!reissuingCursor) {
      publication.controlCursor = cursor;
      publication.controlCursorIssuedAt = new Date(nowMs).toISOString();
      publication.controlCursorReissues = 0;
    }
    persistTransportRecord(loaded);
    const terminalAcked = publication.kind === "terminal" && publication.state === "receipt_acked";
    const terminalPending = terminal && !terminalAcked;
    const boundary = reportBoundary(publication, events);
    return {
      schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
      type: "host_transport_status",
      status: terminalPending
        ? "terminal_publication_pending"
        : active ? "active" : exitCode === null ? "unavailable" : "exited",
      processHandle: handle,
      // Advance only through evidence returned in this response. Jumping to the
      // file tail while `truncated` would make the next poll skip events.
      lastSequence: returnedSequence,
      truncated: events.filter((event) =>
        event.sequence > afterSequence &&
        (event.sequence <= evidenceLimit || event.sequence === publication.terminalSequence)
      ).length > selected.length,
      events: selected,
      serviceCursor: cursor,
      ...(boundary ? { reportPublication: boundary } : {}),
      ...(publication.halted === null ? {} : { publicationHalted: publication.halted }),
      ...(terminal ? { terminalType: terminal.type } : {}),
      ...(exitCode === null ? {} : { exitCode })
    };
  });
}

function claimResult(status, extra = {}) {
  return {
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    type: "host_transport_report_claim",
    status,
    ...extra
  };
}

// The one closed publication-minting action. Under the exclusive record
// lease it atomically checks the exact handle, destination, and bound pump
// job identity, derives a fresh canonical intermediate or terminal report
// boundary from the current normalized evidence, records exactly one fenced
// publication attempt (delivery state `claim_acquired`), and returns only the
// bounded data the delivery layer needs. No static report snapshot is ever
// replayed: cadence, terminal status, and the activity instant come from the
// live record and event log at claim time.
export function claimHostTransportReport(input, dependencies = {}) {
  const handle = assertHandle(input.processHandle);
  if (!isPumpJobId(input.jobId)) {
    transportFail("host_transport_pump_job_invalid");
  }
  if (typeof input.runToken !== "string" || !SAFE_HANDLE.test(input.runToken)) {
    transportFail("host_transport_pump_run_token_invalid");
  }
  return withTransportRecord(input.transportFile, "claim-report", dependencies, (loaded) => {
    const record = loaded.record;
    if (record.processHandle !== handle) {
      transportFail("host_transport_handle_mismatch");
    }
    if (input.destination !== record.reportingContext.controlConversationId) {
      transportFail("host_transport_pump_destination_mismatch");
    }
    const publication = record.publication;
    if (publication.pumpJobId !== null && publication.pumpJobId !== input.jobId) {
      transportFail("host_transport_pump_job_mismatch");
    }
    if (publication.halted === "tracking_lost") {
      return claimResult("tracking_lost");
    }
    if (publication.kind === "terminal" && publication.state === "receipt_acked") {
      // Terminal receipt is acknowledged: publication is complete, no lease
      // remains held, and the pump must deterministically clean itself up
      // (disable/delete its automation) instead of claiming again.
      return claimResult("terminal_acked");
    }
    const nowMs = nowValue(dependencies);
    const events = parseEvents(record.eventsFile);
    const terminal = findTerminalEvent(events);
    const exitCode = exitCodeFromFile(record.exitFile);
    const active = sessionExists(dependencies.runTmux ?? runTmuxDefault, handle);
    const bindingJob = publication.pumpJobId === null;
    if (bindingJob) {
      publication.pumpJobId = input.jobId;
    }
    if (!terminal && exitCode === null && !active) {
      // The exact tracked session is gone without terminal or exit evidence:
      // control-plane tracking loss. Stop publication permanently — a report
      // that claims ACP is still running would be false — and never relaunch.
      publication.halted = "tracking_lost";
      persistTransportRecord(loaded);
      return claimResult("tracking_lost");
    }
    const recordPreviousAttemptOutcome = () => {
      const attempt = publication.attempt;
      if (attempt === null) return;
      // Explicit, never-inferred outcomes: a crash after the Discord handoff
      // (delivery_pending) is `uncertain` — the message may or may not exist
      // — while a crash before the handoff (claim_acquired) is a safe
      // `missing`. Neither is ever recorded as success.
      publication.lastAttemptOutcome = attempt.state === "delivery_pending"
        ? "uncertain"
        : "missing";
      publication.attempt = null;
    };
    const mintAttempt = () => {
      if (publication.attemptCount >= MAX_REPORT_PUBLICATION_ATTEMPTS) {
        transportFail("host_transport_report_attempts_exhausted");
      }
      publication.fence += 1;
      publication.attemptCount += 1;
      publication.attempt = {
        attemptId: newPrivateId("attempt", dependencies),
        fence: publication.fence,
        state: "claim_acquired",
        jobId: input.jobId,
        runToken: input.runToken,
        claimedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + REPORT_ATTEMPT_TTL_MS).toISOString()
      };
    };
    if (terminal && publication.terminalSequence !== terminal.sequence) {
      // Canonical terminal evidence supersedes any overdue intermediate
      // report; a pending intermediate attempt ends with its explicit
      // missing/uncertain outcome and its stale fence can never acknowledge
      // the terminal report.
      const terminalEvidenceLimit = publication.kind === "intermediate" &&
        publication.state !== "receipt_acked"
        ? publication.evidenceThroughSequence
        : terminal.sequence;
      recordPreviousAttemptOutcome();
      const terminalTimestampMs = Date.parse(terminal.timestamp);
      requireReport(
        loaded,
        "terminal",
        0,
        Number.isFinite(terminalTimestampMs) ? terminalTimestampMs : nowMs,
        terminalEvidenceLimit,
        terminal,
        dependencies
      );
      publication.state = "publication_pending";
      publication.attemptCount = 0;
      mintAttempt();
    } else if (publication.state !== "receipt_acked") {
      const attempt = publication.attempt;
      if (attempt !== null && nowMs < Date.parse(attempt.expiresAt)) {
        // A live claim is never silently stolen, not even by the same job.
        transportFail("host_transport_report_claim_held");
      }
      recordPreviousAttemptOutcome();
      mintAttempt();
    } else if (
      !terminal &&
      publication.nextDueAt !== null && nowMs >= Date.parse(publication.nextDueAt)
    ) {
      requireReport(
        loaded,
        "intermediate",
        publication.nextCadence,
        Date.parse(publication.nextDueAt),
        events.at(-1)?.sequence ?? 0,
        null,
        dependencies
      );
      publication.state = "publication_pending";
      publication.attemptCount = 0;
      mintAttempt();
    } else {
      if (bindingJob) {
        persistTransportRecord(loaded);
      }
      return claimResult("none_due");
    }
    persistTransportRecord(loaded);
    const context = record.reportingContext;
    return claimResult("claimed", {
      attemptId: publication.attempt.attemptId,
      fence: publication.attempt.fence,
      attemptCount: publication.attemptCount,
      reportId: publication.reportId,
      reportKind: publication.kind,
      cadence: publication.cadence,
      requiredAt: publication.requiredAt,
      identity: {
        agent: context.agent,
        model: context.model,
        roundIndex: context.roundIndex,
        repository: context.repository,
        branch: context.branch
      },
      ...(publication.kind === "terminal"
        ? {
            terminalStatus: publication.terminalStatus,
            elapsedMs: Number.isSafeInteger(terminal?.elapsedMs) && terminal.elapsedMs >= 0
              ? terminal.elapsedMs
              : null
          }
        : { lastAcpActivityAt: lastAcpActivityInstant(events) })
    });
  });
}

// Marks the exact fenced attempt as handed to the delivery layer. Persisting
// `delivery_pending` BEFORE the Discord handoff is what makes a later crash
// classifiable: an expired claim_acquired attempt was provably never handed
// off (`missing`), while an expired delivery_pending attempt has an
// `uncertain` outcome that is never inferred as success.
export function beginHostTransportReportDelivery(input, dependencies = {}) {
  const handle = assertHandle(input.processHandle);
  return withTransportRecord(input.transportFile, "begin-delivery", dependencies, (loaded) => {
    if (loaded.record.processHandle !== handle) {
      transportFail("host_transport_handle_mismatch");
    }
    const publication = loaded.record.publication;
    if (publication.halted !== null) {
      transportFail("host_transport_publication_halted");
    }
    const attempt = publication.attempt;
    if (
      attempt === null ||
      input.attemptId !== attempt.attemptId ||
      input.fence !== attempt.fence
    ) {
      transportFail("host_transport_report_fencing_stale");
    }
    if (nowValue(dependencies) >= Date.parse(attempt.expiresAt)) {
      transportFail("host_transport_report_attempt_expired");
    }
    if (attempt.state !== "claim_acquired") {
      transportFail("host_transport_report_delivery_already_pending");
    }
    attempt.state = "delivery_pending";
    persistTransportRecord(loaded);
    return {
      schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
      type: "host_transport_report_delivery_pending",
      reportKind: publication.kind,
      cadence: publication.cadence
    };
  });
}

function canonicalAcknowledgedReport(record, publication, report) {
  if (!isPlainObject(report)) {
    transportFail("host_transport_report_ack_invalid_report");
  }
  const context = record.reportingContext;
  for (const key of ["agent", "model", "roundIndex", "repository", "branch"]) {
    if (report[key] !== context[key]) {
      transportFail("host_transport_report_ack_identity_mismatch");
    }
  }
  if (publication.kind === "terminal" && report.status !== publication.terminalStatus) {
    transportFail("host_transport_report_ack_identity_mismatch");
  }
  try {
    return publication.kind === "intermediate"
      ? buildAcpIntermediateReport(report)
      : buildAcpTerminalReport(report);
  } catch {
    transportFail("host_transport_report_ack_invalid_report");
  }
}

export function acknowledgeHostTransportReport(input, dependencies = {}) {
  const handle = assertHandle(input.processHandle);
  return withTransportRecord(input.transportFile, "ack-report", dependencies, (loaded) =>
    acknowledgeLockedReport(loaded, handle, input, dependencies));
}

function acknowledgeLockedReport(loaded, handle, input, dependencies) {
  if (loaded.record.processHandle !== handle) {
    transportFail("host_transport_handle_mismatch");
  }
  const publication = loaded.record.publication;
  if (publication.halted !== null) {
    transportFail("host_transport_publication_halted");
  }
  if (publication.state === "receipt_acked") {
    transportFail(publication.kind === null
      ? "host_transport_report_not_required"
      : "host_transport_report_ack_duplicate");
  }
  if (input.reportId !== publication.reportId || input.reportKind !== publication.kind || input.cadence !== publication.cadence) {
    transportFail("host_transport_report_ack_mismatch");
  }
  // Acknowledgement requires the exact fenced attempt identity minted by
  // claim-report: a superseded (stale-fence) claimer can never close a newer
  // attempt's obligation, and an attempt that never persisted the
  // delivery_pending handoff cannot claim a receipt exists for it.
  const attempt = publication.attempt;
  if (
    attempt === null ||
    input.attemptId !== attempt.attemptId ||
    input.fence !== attempt.fence
  ) {
    transportFail("host_transport_report_fencing_stale");
  }
  if (attempt.state !== "delivery_pending") {
    transportFail("host_transport_report_ack_state");
  }
  const canonicalReport = canonicalAcknowledgedReport(loaded.record, publication, input.report);
  const canonicalDigest = crypto.createHash("sha256").update(canonicalReport, "utf8").digest("hex");
  const receipt = input.receipt;
  if (!exactKeys(receipt, ["conversationId", "messageId", "deliveredAt", "deliveryStatus", "messageDigest"]) ||
    !REPORT_DELIVERY_SUCCESS_STATUSES.includes(receipt.deliveryStatus) ||
    receipt.conversationId !== loaded.record.reportingContext.controlConversationId ||
    typeof receipt.messageId !== "string" || !DECIMAL_ID.test(receipt.messageId) ||
    receipt.messageDigest !== canonicalDigest) {
    transportFail("host_transport_report_receipt_invalid");
  }
  const nowMs = nowValue(dependencies);
  // Reuse the supervisor's bounded wire parser. Report delivery comes from a
  // remote provider clock, unlike canonical owner-clock transport timestamps.
  const deliveredAt = parseDeliveredAt(
    receipt.deliveredAt,
    "host_transport_report_receipt_invalid"
  );
  if (publication.acknowledgedMessageIds.includes(receipt.messageId)) {
    transportFail("host_transport_report_receipt_duplicate");
  }
  if (
    deliveredAt < Date.parse(publication.requiredAt) - REMOTE_PROVIDER_CLOCK_SKEW_MS ||
    deliveredAt > nowMs + REMOTE_PROVIDER_CLOCK_SKEW_MS ||
    nowMs - deliveredAt > MAX_REPORT_RECEIPT_AGE_MS
  ) {
    transportFail("host_transport_report_receipt_stale");
  }
  publication.state = "receipt_acked";
  publication.receiptMessageId = receipt.messageId;
  // The attempt lease is released deterministically on acknowledgement and
  // its outcome is recorded explicitly; the next obligation starts with a
  // fresh bounded attempt budget.
  publication.attempt = null;
  publication.attemptCount = 0;
  publication.lastAttemptOutcome = "acknowledged";
  publication.acknowledgedMessageIds = [
    ...publication.acknowledgedMessageIds,
    receipt.messageId
  ].slice(-MAX_ACKNOWLEDGED_MESSAGE_IDS);
  let skippedCadences = 0;
  if (publication.kind === "intermediate") {
    skippedCadences = Math.max(0, Math.floor(
      (nowMs - Date.parse(publication.requiredAt)) / REPORT_CADENCE_MS
    ));
    publication.nextCadence = publication.cadence + skippedCadences + 1;
    publication.nextDueAt = new Date(
      Date.parse(publication.requiredAt) + ((skippedCadences + 1) * REPORT_CADENCE_MS)
    ).toISOString();
  }
  persistTransportRecord(loaded);
  return {
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    type: "host_transport_report_acknowledged",
    kind: publication.kind,
    cadence: publication.cadence,
    skippedCadences
  };
}

export function reconcileHostTransport(input, dependencies = {}) {
  const handle = assertHandle(input.processHandle);
  return withTransportRecord(input.transportFile, "reconcile", dependencies, (loaded) =>
    reconcileLockedTransport(loaded, handle));
}

function reconcileLockedTransport(loaded, handle) {
  if (loaded.record.processHandle !== handle) {
    transportFail("host_transport_handle_mismatch");
  }
  const events = parseEvents(loaded.record.eventsFile);
  const exitCode = exitCodeFromFile(loaded.record.exitFile);
  if (exitCode === null) {
    transportFail("host_transport_exit_pending");
  }
  if (events.length === 1 && events[0].type === "launcher_error") {
    if (![22, 64].includes(exitCode)) {
      transportFail("host_transport_exit_mismatch");
    }
    const terminalAcked = loaded.record.publication.kind === "terminal" &&
      loaded.record.publication.state === "receipt_acked";
    return {
      schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
      type: "host_transport_reconciled",
      status: terminalAcked
        ? "pre_activation_exit_reconciled"
        : "terminal_publication_pending"
    };
  }
  const runId = events.at(0)?.runId;
  if (!runId) {
    transportFail("host_transport_run_missing");
  }
  const ledgerFile = lifecycleLedgerPath(path.dirname(loaded.record.eventsFile), runId);
  const ledger = loadLifecycleLedger(ledgerFile).document;
  const terminalAcked = loaded.record.publication.kind === "terminal" &&
    loaded.record.publication.state === "receipt_acked";
  // Publication is part of completion, not a presentation afterthought: do
  // not irreversibly close the private lifecycle ledger until the canonical
  // terminal message receipt has been acknowledged.
  if (!terminalAcked) {
    return {
      schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
      type: "host_transport_reconciled",
      status: "terminal_publication_pending"
    };
  }
  const reconciled = ledger.state === "exit_reconciled"
    ? reconcileLifecycleLedger({
        ledgerFile,
        processHandle: ledger.processHandle,
        outcome: "exited",
        exitCode
      })
    : reconcileLifecycleLedger({
        ledgerFile,
        processHandle: ledger.processHandle,
        outcome: "exited",
        exitCode
      });
  return {
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    type: "host_transport_reconciled",
    status: reconciled.state
  };
}

export function cancelHostTransport(input, dependencies = {}) {
  const handle = assertHandle(input.processHandle);
  return withTransportRecord(input.transportFile, "cancel", dependencies, (loaded) => {
    if (loaded.record.processHandle !== handle) {
      transportFail("host_transport_handle_mismatch");
    }
    const runTmux = dependencies.runTmux ?? runTmuxDefault;
    if (!sessionExists(runTmux, handle)) {
      transportFail("host_transport_not_running");
    }
    const result = runTmux(["send-keys", "-t", `=${handle}:0.0`, "C-c"], { timeoutMs: 5000 });
    if (result.error || result.status !== 0) {
      transportFail("host_transport_cancel_failed");
    }
    return {
      schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
      type: "host_transport_cancel_signalled"
    };
  });
}
