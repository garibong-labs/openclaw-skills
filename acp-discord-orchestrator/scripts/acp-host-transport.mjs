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
  loadSupervisorConfig
} from "./acpx-foreground-supervisor.mjs";

export const ACP_HOST_TRANSPORT_SCHEMA_VERSION = "acp-host-transport.v1";
export const DEFAULT_TRANSPORT_EVENT_WAIT_MS = 5000;

const SAFE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_EVENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_EVENT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_RETURNED_EVENTS = 64;
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
    "createdAt"
  ];
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== required.length ||
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
    createdAt: new Date(dependencies.nowMs ?? Date.now()).toISOString()
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
  const activation = JSON.stringify({
    schemaVersion: ACP_HOST_ACTIVATION_SCHEMA_VERSION,
    processHandle: handle
  }) + "\n";
  const bufferName = `acp-${crypto.randomBytes(8).toString("hex")}`;
  const setResult = runTmux(["set-buffer", "-b", bufferName, activation], { timeoutMs: 5000 });
  if (setResult.error || setResult.status !== 0) {
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

export function statusHostTransport(input, dependencies = {}) {
  const loaded = loadHostTransportRecord(input.transportFile);
  const handle = assertHandle(input.processHandle);
  if (loaded.record.processHandle !== handle) {
    transportFail("host_transport_handle_mismatch");
  }
  const afterSequence = input.afterSequence ?? 0;
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    transportFail("host_transport_cursor_invalid");
  }
  const events = parseEvents(loaded.record.eventsFile);
  const selected = events
    .filter((event) => event.sequence > afterSequence)
    .slice(0, MAX_RETURNED_EVENTS);
  const latestSequence = events.at(-1)?.sequence ?? 0;
  const returnedSequence = selected.at(-1)?.sequence ?? Math.min(afterSequence, latestSequence);
  const exitCode = exitCodeFromFile(loaded.record.exitFile);
  const active = sessionExists(dependencies.runTmux ?? runTmuxDefault, handle);
  const terminal = events.find((event) => [
    "terminal",
    "supervisor_error",
    "launcher_error"
  ].includes(event.type));
  return {
    schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
    type: "host_transport_status",
    status: active ? "active" : exitCode === null ? "unavailable" : "exited",
    processHandle: handle,
    // Advance only through evidence returned in this response. Jumping to the
    // file tail while `truncated` would make the next poll skip events.
    lastSequence: returnedSequence,
    truncated: events.filter((event) => event.sequence > afterSequence).length > selected.length,
    events: selected,
    ...(terminal ? { terminalType: terminal.type } : {}),
    ...(exitCode === null ? {} : { exitCode })
  };
}

export function reconcileHostTransport(input) {
  const loaded = loadHostTransportRecord(input.transportFile);
  const handle = assertHandle(input.processHandle);
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
    return {
      schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
      type: "host_transport_reconciled",
      status: "pre_activation_exit_reconciled"
    };
  }
  const runId = events.at(0)?.runId;
  if (!runId) {
    transportFail("host_transport_run_missing");
  }
  const ledgerFile = lifecycleLedgerPath(path.dirname(loaded.record.eventsFile), runId);
  const ledger = loadLifecycleLedger(ledgerFile).document;
  const reconciled = reconcileLifecycleLedger({
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
  const loaded = loadHostTransportRecord(input.transportFile);
  const handle = assertHandle(input.processHandle);
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
}
