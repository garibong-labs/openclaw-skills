import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SCHEMA_VERSION = "acp-discord-orchestrator.v1";
export const EXIT_CODES = Object.freeze({
  completed: 0,
  cancelled: 20,
  failed: 21,
  supervisorError: 22,
  invalidConfig: 64
});

const VALID_TOOL_KINDS = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other"
]);

const EXECUTION_CONTRACT = [
  "",
  "Execution boundary for this ACP turn:",
  "- Run every completion-critical tool and test in the foreground.",
  "- Do not use run_in_background, background Task or Agent launches, nohup, disown, setsid, or shell ampersand detachment.",
  "- Foreground parallel runners that block until every child finishes are allowed.",
  "- Do not return until implementation and required checks have reached their terminal state."
].join("\n");

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function assertString(value, code, maxLength = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail(code);
  }
  return value;
}

function assertIdentifier(value, code, maxLength) {
  const checked = assertString(value, code, maxLength);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]*$/.test(checked)) {
    fail(code);
  }
  return checked;
}

function assertPositiveInteger(value, code, options = {}) {
  const allowZero = options.allowZero === true;
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    fail(code);
  }
  return value;
}

function assertPrivateFile(filePath, code) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    fail(code + "_symlink");
  }
  if (!stat.isFile()) {
    fail(code);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    fail(code + "_permissions");
  }
}

function resolveAbsolute(value, code) {
  const checked = assertString(value, code);
  if (!path.isAbsolute(checked)) {
    fail(code + "_not_absolute");
  }
  return path.normalize(checked);
}

function preparePrivateStateDirectory(directory) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) {
    fail("invalid_state_dir_symlink");
  }
  if (!stat.isDirectory()) {
    fail("invalid_state_dir_directory");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    fail("invalid_state_dir_permissions");
  }
}

export function loadSupervisorConfig(configPath) {
  const absoluteConfigPath = resolveAbsolute(configPath, "invalid_config_path");
  assertPrivateFile(absoluteConfigPath, "invalid_config_file");

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(absoluteConfigPath, "utf8"));
  } catch {
    fail("invalid_config_json");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("invalid_config_object");
  }

  const cwd = resolveAbsolute(raw.cwd, "invalid_cwd");
  const cwdStat = fs.statSync(cwd);
  if (!cwdStat.isDirectory()) {
    fail("invalid_cwd_directory");
  }

  const promptFile = resolveAbsolute(raw.promptFile, "invalid_prompt_file");
  assertPrivateFile(promptFile, "invalid_prompt_file");
  const promptText = fs.readFileSync(promptFile, "utf8");
  if (promptText.length === 0 || Buffer.byteLength(promptText, "utf8") > 1024 * 1024) {
    fail("invalid_prompt_size");
  }

  const responseFile = resolveAbsolute(raw.responseFile, "invalid_response_file");
  if (fs.existsSync(responseFile)) {
    fail("response_file_exists");
  }

  const stateDir = resolveAbsolute(raw.stateDir, "invalid_state_dir");
  const timeoutMs = raw.timeoutMs === undefined
    ? undefined
    : assertPositiveInteger(raw.timeoutMs, "invalid_timeout_ms");
  const progressMs = raw.progressMs === undefined
    ? 0
    : assertPositiveInteger(raw.progressMs, "invalid_progress_ms", { allowZero: true });
  if (progressMs > 0 && progressMs < 1000) {
    fail("invalid_progress_ms");
  }

  if (!Array.isArray(raw.allowKinds) || raw.allowKinds.length === 0) {
    fail("invalid_allow_kinds");
  }
  const allowKinds = new Set();
  for (const value of raw.allowKinds) {
    if (typeof value !== "string" || !VALID_TOOL_KINDS.has(value)) {
      fail("invalid_allow_kind");
    }
    allowKinds.add(value);
  }

  return {
    agent: assertIdentifier(raw.agent, "invalid_agent", 128),
    model: raw.model === undefined ? undefined : assertIdentifier(raw.model, "invalid_model", 256),
    cwd,
    sessionKey: assertString(raw.sessionKey, "invalid_session_key", 256),
    promptText,
    responseFile,
    stateDir,
    timeoutMs,
    progressMs,
    allowKinds,
    maxResponseBytes: raw.maxResponseBytes === undefined
      ? 1024 * 1024
      : assertPositiveInteger(raw.maxResponseBytes, "invalid_max_response_bytes"),
    runtimeModule: resolveAbsolute(raw.runtimeModule, "invalid_runtime_module")
  };
}

function normalizedKey(value) {
  return String(value).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function walkObject(value, visitor, depth = 0) {
  if (depth > 12 || value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 256)) {
      walkObject(item, visitor, depth + 1);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    if (count >= 256) {
      break;
    }
    count += 1;
    visitor(key, child);
    walkObject(child, visitor, depth + 1);
  }
}

function hasBackgroundFlag(value) {
  let found = false;
  walkObject(value, (key, child) => {
    const keyName = normalizedKey(key);
    const enabled = child === true ||
      child === 1 ||
      (typeof child === "string" && normalizedKey(child) === "true");
    if ((keyName === "runinbackground" || keyName === "background") && enabled) {
      found = true;
    }
  });
  return found;
}

function hasPermissionBypass(value) {
  let found = false;
  walkObject(value, (key, child) => {
    const keyName = normalizedKey(key);
    if (typeof child === "string" && normalizedKey(child) === "bypasspermissions") {
      found = true;
    }
    if (keyName === "dangerouslyskippermissions" && child === true) {
      found = true;
    }
    if (keyName.includes("permission") && typeof child === "string") {
      if (normalizedKey(child).includes("bypasspermissions")) {
        found = true;
      }
    }
  });
  return found;
}

function collectCommandStrings(value) {
  const commands = [];
  walkObject(value, (key, child) => {
    const keyName = normalizedKey(key);
    if (
      typeof child === "string" &&
      (keyName === "command" || keyName === "cmd" || keyName === "shell" || keyName === "script")
    ) {
      commands.push(child);
    }
  });
  return commands;
}

export function containsDetachedShell(command) {
  if (typeof command !== "string") {
    return false;
  }
  if (/\b(?:nohup|disown|setsid)\b/i.test(command)) {
    return true;
  }

  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && !singleQuoted) {
      escaped = true;
      continue;
    }
    if (character === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (character === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (character !== "&" || singleQuoted || doubleQuoted) {
      continue;
    }

    const previous = command[index - 1];
    const next = command[index + 1];
    if (previous === "&" || next === "&" || previous === ">" || next === ">") {
      continue;
    }
    return true;
  }
  return false;
}

export function classifyPermissionRequest(request, allowKinds) {
  const raw = request && request.raw;
  const toolCall = raw && raw.toolCall;
  const kind = request && request.inferredKind
    ? request.inferredKind
    : toolCall && toolCall.kind;

  if (typeof kind !== "string" || !VALID_TOOL_KINDS.has(kind)) {
    return { allowed: false, reason: "unknown_tool_kind", kind: "unknown" };
  }
  if (!allowKinds.has(kind)) {
    return { allowed: false, reason: "tool_kind_not_allowed", kind };
  }

  const rawInput = toolCall && toolCall.rawInput;
  if (rawInput === undefined) {
    return { allowed: false, reason: "uninspectable_input", kind };
  }
  if (hasPermissionBypass(rawInput)) {
    return { allowed: false, reason: "permission_bypass", kind };
  }
  if (hasBackgroundFlag(rawInput)) {
    return { allowed: false, reason: "background_flag", kind };
  }
  for (const command of collectCommandStrings(rawInput)) {
    if (containsDetachedShell(command)) {
      return { allowed: false, reason: "detached_shell", kind };
    }
  }
  return { allowed: true, reason: "foreground_once", kind };
}

export function buildPermissionHandler(options) {
  return async (request, context) => {
    if (context && context.signal && context.signal.aborted) {
      options.counters.permissionsCancelled += 1;
      return { outcome: "cancel" };
    }

    const decision = classifyPermissionRequest(request, options.allowKinds);
    if (!decision.allowed) {
      options.counters.permissionsRejected += 1;
      options.emit("permission_rejected", {
        reason: decision.reason,
        toolKind: decision.kind
      });
      return { outcome: "reject_once" };
    }

    options.counters.permissionsApproved += 1;
    return { outcome: "allow_once" };
  };
}

function withSafeTag(payload, value) {
  if (
    typeof value === "string" &&
    /^[a-zA-Z0-9_.:/+-]{1,64}$/.test(value)
  ) {
    return { ...payload, tag: value };
  }
  return payload;
}

export function normalizeRuntimeEvent(event, counters) {
  if (!event || typeof event !== "object") {
    counters.unknownEvents += 1;
    return { activity: "unknown" };
  }

  if (event.type === "text_delta") {
    if (event.stream === "thought") {
      counters.thoughtEvents += 1;
      return withSafeTag({ activity: "model_thought" }, event.tag);
    }
    counters.outputEvents += 1;
    return withSafeTag({ activity: "model_output" }, event.tag);
  }

  if (event.type === "status") {
    counters.statusEvents += 1;
    const normalized = withSafeTag({ activity: "status" }, event.tag);
    if (Number.isFinite(event.used)) {
      normalized.used = event.used;
    }
    if (Number.isFinite(event.size)) {
      normalized.size = event.size;
    }
    return normalized;
  }

  if (event.type === "tool_call") {
    counters.toolEvents += 1;
    return withSafeTag({
      activity: "tool",
      toolKind: VALID_TOOL_KINDS.has(event.kind) ? event.kind : "unknown",
      toolStatus: ["pending", "in_progress", "completed", "failed"].includes(event.status)
        ? event.status
        : "unknown"
    }, event.tag);
  }

  if (event.type === "done" || event.type === "error") {
    counters.compatibilityTerminalEvents += 1;
    return { activity: "compatibility_terminal_ignored" };
  }

  counters.unknownEvents += 1;
  return { activity: "unknown" };
}
function runtimeLocationFromOverride(value) {
  const absolute = path.resolve(value);
  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) {
    return {
      modulePath: path.join(absolute, "dist", "runtime.js"),
      packageRoot: absolute
    };
  }
  if (stat.isFile()) {
    return {
      modulePath: absolute,
      packageRoot: path.basename(path.dirname(absolute)) === "dist"
        ? path.dirname(path.dirname(absolute))
        : path.dirname(absolute)
    };
  }
  fail("invalid_runtime_module");
}

export function discoverRuntimeLocation(options = {}) {
  if (!options.runtimeModule) {
    fail("acpx_runtime_module_required");
  }
  return runtimeLocationFromOverride(options.runtimeModule);
}
function readPackageVersion(packageRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function validateRuntimeModuleExports(runtimeModule) {
  for (const name of ["createAcpRuntime", "createRuntimeStore", "createAgentRegistry"]) {
    if (!runtimeModule || typeof runtimeModule[name] !== "function") {
      fail("acpx_runtime_capability_missing_" + name);
    }
  }
}

async function loadRuntimeModule(config, dependencies) {
  if (dependencies.runtimeModule) {
    validateRuntimeModuleExports(dependencies.runtimeModule);
    return {
      module: dependencies.runtimeModule,
      version: dependencies.runtimeVersion || "mock"
    };
  }

  const location = discoverRuntimeLocation(config);
  if (!fs.existsSync(location.modulePath)) {
    fail("acpx_runtime_module_missing");
  }
  const imported = await import(pathToFileURL(location.modulePath).href);
  validateRuntimeModuleExports(imported);
  return {
    module: imported,
    version: readPackageVersion(location.packageRoot)
  };
}

function createCounters() {
  return {
    outputEvents: 0,
    thoughtEvents: 0,
    statusEvents: 0,
    toolEvents: 0,
    unknownEvents: 0,
    compatibilityTerminalEvents: 0,
    permissionsApproved: 0,
    permissionsRejected: 0,
    permissionsCancelled: 0
  };
}

function publicCounters(counters) {
  return { ...counters };
}

function safeWorkspaceName(cwd) {
  return path.basename(path.resolve(cwd));
}

function safeSessionReference(sessionKey) {
  return crypto.createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
}

function safeStopReason(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  return /^[a-zA-Z0-9_.:-]{1,96}$/.test(value) ? value : undefined;
}

function safeDiagnosticCode(value, fallback, maxLength = 128) {
  if (typeof value !== "string") {
    return fallback;
  }
  return new RegExp("^[a-zA-Z0-9_.:-]{1," + String(maxLength) + "}$").test(value)
    ? value
    : fallback;
}

function safeErrorCode(value) {
  return safeDiagnosticCode(value, "acp_turn_failed");
}

function safeRuntimeVersion(value) {
  return safeDiagnosticCode(value, "unknown", 64);
}

function takeUtf8Prefix(value, maxBytes) {
  if (maxBytes <= 0) {
    return "";
  }
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let prefix = value.slice(0, low);
  if (prefix.length > 0 && /[\uD800-\uDBFF]/.test(prefix.at(-1))) {
    prefix = prefix.slice(0, -1);
  }
  return prefix;
}

function writePrivateResponse(responseFile, content) {
  const parent = path.dirname(responseFile);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  } else if (!fs.statSync(parent).isDirectory()) {
    fail("invalid_response_parent");
  }
  fs.writeFileSync(responseFile, content, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
}

function bindCancellationSignals(turn, emit) {
  let requested = false;
  const handlers = new Map();

  for (const signalName of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (requested) {
        return;
      }
      requested = true;
      emit("activity", { activity: "cancellation_requested", signal: signalName });
      Promise.resolve(turn.cancel({ reason: "signal:" + signalName })).catch(() => {
        emit("activity", { activity: "cancellation_request_failed", signal: signalName });
      });
    };
    handlers.set(signalName, handler);
    process.on(signalName, handler);
  }

  return () => {
    for (const [signalName, handler] of handlers) {
      process.off(signalName, handler);
    }
  };
}

async function settleEventPump(eventPump, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs);
  });
  const settled = eventPump.then(
    () => ({ ok: true, timedOut: false }),
    () => ({ ok: false, timedOut: false })
  );
  const result = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return result;
}

export async function runSupervisor(config, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const randomUUID = dependencies.randomUUID || crypto.randomUUID;
  const writeEvent = dependencies.writeEvent || ((event) => {
    process.stdout.write(JSON.stringify(event) + "\n");
  });
  const runId = randomUUID();
  const requestId = randomUUID();
  const startedAt = now();
  const counters = createCounters();
  let sequence = 0;
  let lastActivityAt = startedAt;
  let runtime;
  let handle;
  let turn;
  let stopSignals = () => {};
  let progressTimer;
  let response = "";
  let responseTruncated = false;

  const emit = (type, payload = {}) => {
    const timestampMs = now();
    sequence += 1;
    writeEvent({
      schemaVersion: SCHEMA_VERSION,
      runId,
      requestId,
      sequence,
      timestamp: new Date(timestampMs).toISOString(),
      elapsedMs: Math.max(0, timestampMs - startedAt),
      type,
      ...payload
    });
  };

  try {
    preparePrivateStateDirectory(config.stateDir);
    if (fs.existsSync(config.responseFile)) {
      fail("response_file_exists");
    }

    const loaded = await loadRuntimeModule(config, dependencies);
    const permissionHandler = buildPermissionHandler({
      allowKinds: config.allowKinds,
      counters,
      emit
    });

    runtime = loaded.module.createAcpRuntime({
      cwd: config.cwd,
      sessionStore: loaded.module.createRuntimeStore({ stateDir: config.stateDir }),
      agentRegistry: loaded.module.createAgentRegistry(),
      permissionMode: "deny-all",
      nonInteractivePermissions: "fail",
      timeoutMs: config.timeoutMs,
      probeAgent: config.agent,
      onPermissionRequest: permissionHandler
    });

    for (const name of ["ensureSession", "startTurn", "close"]) {
      if (!runtime || typeof runtime[name] !== "function") {
        fail("acpx_runtime_instance_missing_" + name);
      }
    }
    if (typeof runtime.probeAvailability === "function") {
      await runtime.probeAvailability();
    }

    handle = await runtime.ensureSession({
      sessionKey: config.sessionKey,
      agent: config.agent,
      mode: "oneshot",
      cwd: config.cwd,
      sessionOptions: {
        ...(config.model ? { model: config.model } : {}),
        systemPrompt: { append: EXECUTION_CONTRACT.trim() }
      }
    });

    turn = runtime.startTurn({
      handle,
      text: config.promptText + EXECUTION_CONTRACT,
      mode: "prompt",
      requestId,
      timeoutMs: config.timeoutMs
    });

    if (
      !turn ||
      turn.requestId !== requestId ||
      !turn.events ||
      typeof turn.events[Symbol.asyncIterator] !== "function" ||
      !turn.result ||
      typeof turn.result.then !== "function" ||
      typeof turn.cancel !== "function" ||
      typeof turn.closeStream !== "function"
    ) {
      fail("acpx_turn_contract_invalid");
    }

    emit("started", {
      agent: config.agent,
      model: config.model || "runtime-default",
      workspace: safeWorkspaceName(config.cwd),
      sessionRef: safeSessionReference(config.sessionKey),
      runtimeVersion: safeRuntimeVersion(loaded.version),
      allowedToolKinds: [...config.allowKinds].sort()
    });

    const eventPump = (async () => {
      for await (const event of turn.events) {
        lastActivityAt = now();
        if (
          event &&
          event.type === "text_delta" &&
          event.stream !== "thought" &&
          typeof event.text === "string"
        ) {
          const remainingBytes = config.maxResponseBytes - Buffer.byteLength(response, "utf8");
          const prefix = takeUtf8Prefix(event.text, remainingBytes);
          response += prefix;
          if (prefix.length < event.text.length) {
            responseTruncated = true;
          }
        }
        emit("activity", normalizeRuntimeEvent(event, counters));
      }
    })();

    if (config.progressMs > 0) {
      progressTimer = setInterval(() => {
        const snapshotAt = now();
        emit("progress", {
          evidenceAgeMs: Math.max(0, snapshotAt - lastActivityAt),
          counters: publicCounters(counters)
        });
      }, config.progressMs);
      progressTimer.unref();
    }

    stopSignals = dependencies.bindSignals === false
      ? () => {}
      : bindCancellationSignals(turn, emit);

    const result = await turn.result;
    if (!result || !["completed", "cancelled", "failed"].includes(result.status)) {
      fail("acpx_turn_result_invalid");
    }

    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = undefined;
    }
    stopSignals();
    stopSignals = () => {};

    const streamState = await settleEventPump(eventPump, 2000);
    if (!streamState.ok) {
      try {
        await turn.closeStream({ reason: "terminal_result" });
      } catch {
        // The result remains authoritative even when stream cleanup fails.
      }
      await settleEventPump(eventPump, 500);
    }

    let cleanupOk = true;
    try {
      await runtime.close({
        handle,
        reason: "supervisor_terminal",
        discardPersistentState: true
      });
      runtime = undefined;
    } catch {
      cleanupOk = false;
    }

    let responseStored = true;
    try {
      writePrivateResponse(config.responseFile, response);
    } catch {
      responseStored = false;
    }
    const supervisorStatus = streamState.ok &&
      cleanupOk &&
      responseStored &&
      !responseTruncated
      ? "ok"
      : "degraded";
    const terminal = {
      status: result.status,
      supervisorStatus,
      stopReason: safeStopReason(result.stopReason),
      responseBytes: Buffer.byteLength(response, "utf8"),
      responseSha256: crypto.createHash("sha256").update(response).digest("hex"),
      responseTruncated,
      responseStored,
      eventStreamOk: streamState.ok,
      eventStreamTimedOut: streamState.timedOut,
      cleanupOk,
      counters: publicCounters(counters)
    };
    if (result.status === "failed" && result.error) {
      terminal.errorCode = safeErrorCode(result.error.code);
      terminal.retryable = result.error.retryable === true;
    }
    emit("terminal", terminal);
    return supervisorStatus === "ok"
      ? EXIT_CODES[result.status]
      : EXIT_CODES.supervisorError;
  } catch (error) {
    if (progressTimer) {
      clearInterval(progressTimer);
    }
    stopSignals();
    const code = safeDiagnosticCode(
      error && error.code,
      "supervisor_failure"
    );
    try {
      emit("supervisor_error", { code });
    } catch {
      // There is no safe secondary output channel after event delivery fails.
    }
    return EXIT_CODES.supervisorError;
  } finally {
    if (runtime && turn) {
      try {
        await turn.closeStream({ reason: "supervisor_cleanup" });
      } catch {
        // Best-effort cleanup only.
      }
    }
    if (runtime && handle) {
      try {
        await runtime.close({
          handle,
          reason: "supervisor_cleanup",
          discardPersistentState: true
        });
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== "--config") {
    fail("usage");
  }
  return argv[1];
}

export async function main(argv = process.argv.slice(2)) {
  let config;
  try {
    const configPath = parseCli(argv);
    config = loadSupervisorConfig(configPath);
  } catch (error) {
    const code = safeDiagnosticCode(
      error && error.code,
      "invalid_config"
    );
    process.stdout.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      type: "supervisor_error",
      code
    }) + "\n");
    return EXIT_CODES.invalidConfig;
  }
  return runSupervisor(config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
