import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ACP_REPORT_RUNTIME_DEFAULT_MODEL_LABEL,
  ACP_SUPPORTED_AGENTS,
  AcpReportingContractError,
  validateAcpReportingContract
} from "./acp-reporting-contract.mjs";

export { ACP_AGENT_PRESENTATIONS, ACP_SUPPORTED_AGENTS } from "./acp-reporting-contract.mjs";

export const SCHEMA_VERSION = "acp-discord-orchestrator.v1";
export const EXIT_CODES = Object.freeze({
  completed: 0,
  cancelled: 20,
  failed: 21,
  supervisorError: 22,
  invalidConfig: 64
});

export const CLAUDE_AGENT = "claude";
export const CODEX_AGENT = "codex";
// The supervisor runs every turn as a oneshot ACP session; the constant keeps
// the ensureSession request and the codex cleanup-fallback gate bound to the
// same mode value.
const ACP_SESSION_MODE = "oneshot";
// Stable public error code the ACPX runtime raises when a backend adapter
// does not implement a requested control (for cleanup: session/close).
export const ACPX_UNSUPPORTED_CONTROL_ERROR_CODE = "ACP_BACKEND_UNSUPPORTED_CONTROL";
export const CLAUDE_AUTH_KIND = "claude-setup-token-env-file";
export const CLAUDE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
// Credential-selection variables that would silently override or compete with
// the injected setup token inside the Claude ACP adapter.
export const CLAUDE_FORBIDDEN_ENV = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY"
]);
// Agent-neutral ACP process-integrity baseline: variables that can preload
// code into, redirect the module resolution of, or reroute the traffic of
// the supervisor process itself, independent of which provider the agent
// talks to. NODE_OPTIONS-injected flags never appear in process.execArgv, so
// the exec-argv proof cannot see them; they are rejected as environment
// state instead.
export const ACP_INJECTION_ENV = Object.freeze([
  // Node.js process injection and module-resolution redirection
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  // Dynamic-linker code injection (Linux / macOS)
  "LD_PRELOAD",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  // Proxy selectors that would route credential-bearing traffic; POSIX
  // environments are case-sensitive, so both spellings are listed.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy"
]);
// The process-integrity contract enforced automatically for every supported
// agent, independent of the caller-declared requiredEnv/forbiddenEnv arrays.
export const ACP_BASELINE_ENV_CONTRACT = Object.freeze({
  requiredEnv: Object.freeze([]),
  forbiddenEnv: ACP_INJECTION_ENV
});
// Anthropic/Claude-specific endpoint, header, and config-directory selectors,
// layered on top of the agent-neutral baseline for Claude runs only.
export const CLAUDE_PROVIDER_INJECTION_ENV = Object.freeze([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CONFIG_DIR"
]);
// Full injection-capable set for the token-bearing Claude supervisor: the
// agent-neutral baseline plus the Anthropic-specific selectors.
export const CLAUDE_INJECTION_ENV = Object.freeze([
  ...ACP_INJECTION_ENV,
  ...CLAUDE_PROVIDER_INJECTION_ENV
]);
// The credential contract enforced automatically for every Claude run,
// independent of the caller-declared requiredEnv/forbiddenEnv arrays.
export const CLAUDE_IMPLICIT_ENV_CONTRACT = Object.freeze({
  requiredEnv: Object.freeze([CLAUDE_OAUTH_TOKEN_ENV]),
  forbiddenEnv: Object.freeze([...CLAUDE_FORBIDDEN_ENV, ...CLAUDE_INJECTION_ENV])
});
const MAX_CLAUDE_ENV_FILE_BYTES = 4096;
// Exactly one assignment with an optional final newline. The value charset
// excludes quotes, whitespace, comments, and interpolation so the file cannot
// mean something different to Node's --env-file parser than it does here.
const CLAUDE_ENV_FILE_ASSIGNMENT = new RegExp(
  "^" + CLAUDE_OAUTH_TOKEN_ENV + "=([A-Za-z0-9_-]+)\\n?$"
);

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

const CONFIGURABLE_TOOL_KINDS = new Set(
  [...VALID_TOOL_KINDS].filter((kind) => kind !== "other")
);
const COMMAND_KEYS = new Set([
  "command",
  "cmd",
  "shell",
  "script",
  "args",
  "argv",
  "commandline",
  "run",
  "exec"
]);
const BACKGROUND_KEYS = new Set([
  "runinbackground",
  "background",
  "detached",
  "detach",
  "daemon",
  "daemonize"
]);
const ENABLED_FLAG_VALUES = new Set([
  "1",
  "true",
  "yes",
  "on",
  "background",
  "detached",
  "daemon",
  "daemonized"
]);
const MAX_INSPECTION_DEPTH = 12;
const MAX_COLLECTION_ITEMS = 256;
const MAX_INSPECTION_NODES = 4096;
const MAX_INSPECTED_STRING_BYTES = 65536;
const MAX_ENV_CONTRACT_ITEMS = 32;
const MAX_ENV_NAME_LENGTH = 64;
const PORTABLE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DISCORD_ID = /^[0-9]{1,32}$/;
const MAX_DELIVERED_AT_LENGTH = 40;
// Discord serializes message timestamps with microsecond precision and a
// numeric offset, for example 2026-08-22T07:47:48.530000+00:00, so the
// fractional part is bounded at six digits rather than three. The explicit
// zone suffix stays mandatory: a local time without one is ambiguous.
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const DEFAULT_MAX_START_RECEIPT_AGE_MS = 300000;
const MIN_MAX_START_RECEIPT_AGE_MS = 1000;
const MAX_MAX_START_RECEIPT_AGE_MS = 3600000;
// Delivery timestamps come from a remote chat clock, so a bounded forward
// skew keeps an honest receipt usable without widening the freshness window.
const START_RECEIPT_FUTURE_SKEW_MS = 1000;

const EXECUTION_CONTRACT = [
  "",
  "Execution boundary for this ACP turn:",
  "- Run every completion-critical tool and test in the foreground.",
  "- Do not use run_in_background, background Task or Agent launches, nohup, disown, setsid, or shell ampersand detachment.",
  "- Foreground parallel runners that block until every child finishes are allowed.",
  "- Do not return until implementation and required checks have reached their terminal state."
].join("\n");

export function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

// ACPX normalizes agent names with trim/lowercase, so any spelling that
// normalizes to "claude" resolves to the Claude adapter and must receive the
// Claude credential contract.
export function isClaudeAgent(value) {
  return typeof value === "string" && value.trim().toLowerCase() === CLAUDE_AGENT;
}

// Centralized closed-set agent gate, shared by the config loader and the
// in-memory runSupervisor path so both surface the same stable codes for
// every supported agent. ACPX trims and lowercases agent names, so "Claude"
// or " codex " would still resolve to a supported adapter while bypassing
// every exact-match gate: a spelling that normalizes to a supported agent
// but is not the exact canonical lowercase value fails
// invalid_agent_not_canonical, and anything outside the closed set fails
// invalid_agent_unsupported.
export function assertCanonicalSupportedAgent(value) {
  const normalized = typeof value === "string"
    ? value.trim().toLowerCase()
    : undefined;
  if (normalized === undefined || !ACP_SUPPORTED_AGENTS.includes(normalized)) {
    fail("invalid_agent_unsupported");
  }
  if (value !== normalized) {
    fail("invalid_agent_not_canonical");
  }
  return value;
}

// Realpath-safe CLI entry guard. import.meta.url of an ESM main entry is
// realpath-resolved while process.argv[1] is not, so a symlinked entry path
// (including macOS /tmp -> /private/tmp) would make a naive href comparison
// silently skip main() with exit 0.
export function isCliEntry(argvPath, moduleUrl) {
  if (typeof argvPath !== "string" || argvPath.length === 0) {
    return false;
  }
  try {
    return fs.realpathSync(path.resolve(argvPath)) ===
      fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
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

function parseEnvContractList(value, code) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_ENV_CONTRACT_ITEMS) {
    fail(code);
  }
  const names = [];
  const identities = new Set();
  for (const name of value) {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > MAX_ENV_NAME_LENGTH ||
      !PORTABLE_ENV_NAME.test(name)
    ) {
      fail(code + "_name");
    }
    // Windows process.env is case-insensitive, so name identity is
    // case-insensitive on every platform to keep contracts portable.
    const identity = name.toUpperCase();
    if (identities.has(identity)) {
      fail(code + "_duplicate");
    }
    identities.add(identity);
    names.push(name);
  }
  return names;
}

function isDiscordId(value) {
  return typeof value === "string" && DISCORD_ID.test(value);
}

function isBoundedStartReceiptAge(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_MAX_START_RECEIPT_AGE_MS &&
    value <= MAX_MAX_START_RECEIPT_AGE_MS
  );
}

function assertDiscordId(value, code) {
  if (!isDiscordId(value)) {
    fail(code);
  }
  return value;
}

function parseDeliveredAt(value, code) {
  if (
    typeof value !== "string" ||
    value.length > MAX_DELIVERED_AT_LENGTH ||
    !ISO_INSTANT.test(value)
  ) {
    fail(code);
  }
  const deliveredAtMs = Date.parse(value);
  if (!Number.isSafeInteger(deliveredAtMs)) {
    fail(code);
  }
  return deliveredAtMs;
}

function parseLifecycleContract(value) {
  if (!isPlainObject(value)) {
    fail("invalid_lifecycle");
  }
  if (!isPlainObject(value.startReceipt)) {
    fail("invalid_start_receipt");
  }

  const controlConversationId = assertDiscordId(
    value.controlConversationId,
    "invalid_control_conversation_id"
  );
  const conversationId = assertDiscordId(
    value.startReceipt.conversationId,
    "invalid_start_receipt_conversation_id"
  );
  const messageId = assertDiscordId(
    value.startReceipt.messageId,
    "invalid_start_receipt_message_id"
  );
  if (conversationId !== controlConversationId) {
    fail("invalid_start_receipt_conversation_mismatch");
  }

  const maxStartReceiptAgeMs = value.maxStartReceiptAgeMs === undefined
    ? DEFAULT_MAX_START_RECEIPT_AGE_MS
    : value.maxStartReceiptAgeMs;
  if (!isBoundedStartReceiptAge(maxStartReceiptAgeMs)) {
    fail("invalid_max_start_receipt_age_ms");
  }

  // The original deliveredAt spelling is kept alongside its parsed instant:
  // the reporting contract binds the attested start message to the receipt by
  // byte-for-byte spelling, both at load time and in the in-memory
  // runReportingPreflight backstop.
  const deliveredAt = value.startReceipt.deliveredAt;
  return {
    controlConversationId,
    maxStartReceiptAgeMs,
    startReceipt: {
      conversationId,
      messageId,
      deliveredAt,
      deliveredAtMs: parseDeliveredAt(
        deliveredAt,
        "invalid_start_receipt_delivered_at"
      )
    }
  };
}

// Caller-attested metadata only: the supervisor holds no Discord credentials
// and makes no network call, so it cannot read the announced message itself.
// This is the backstop for configs built in memory rather than loaded from
// disk, so it re-asserts the parsed shape instead of trusting or coercing it:
// a numeric identifier is not the same value as its decimal spelling, and an
// out-of-range freshness window would silently reopen the documented bound.
export function runStartReceiptPreflight(config, nowMs) {
  const lifecycle = config.lifecycle;
  const receipt = lifecycle && lifecycle.startReceipt;
  if (
    !isPlainObject(lifecycle) ||
    !isPlainObject(receipt) ||
    !isDiscordId(lifecycle.controlConversationId) ||
    !isDiscordId(receipt.conversationId) ||
    !isDiscordId(receipt.messageId) ||
    !Number.isSafeInteger(receipt.deliveredAtMs) ||
    !isBoundedStartReceiptAge(lifecycle.maxStartReceiptAgeMs)
  ) {
    fail("start_receipt_missing");
  }
  if (receipt.conversationId !== lifecycle.controlConversationId) {
    fail("start_receipt_conversation_mismatch");
  }

  const ageMs = nowMs - receipt.deliveredAtMs;
  if (ageMs < -START_RECEIPT_FUTURE_SKEW_MS) {
    fail("start_receipt_future");
  }
  if (ageMs > lifecycle.maxStartReceiptAgeMs) {
    fail("start_receipt_stale");
  }
}

// Maps a contract rejection onto the supervisor's bounded fail() codes so the
// stable invalid_reporting_* code is the whole diagnostic; anything else
// (a programming error) propagates unchanged.
function assertReportingContract(reporting, context) {
  try {
    return validateAcpReportingContract(reporting, context);
  } catch (error) {
    if (error instanceof AcpReportingContractError) {
      fail(error.code);
    }
    throw error;
  }
}

// In-memory backstop mirroring runStartReceiptPreflight: a config assembled
// without loadSupervisorConfig must still carry a reporting bundle satisfying
// the full pure reporting contract (acp-reporting-v2, or v1 for the bounded
// canonical-Claude migration), bound to the canonical config agent, and it
// must fail closed with the same bounded invalid_reporting_* codes before any
// runtime module import, probe, or adapter startup.
export function runReportingPreflight(config) {
  const lifecycle = isPlainObject(config.lifecycle) ? config.lifecycle : undefined;
  const receipt = lifecycle && isPlainObject(lifecycle.startReceipt)
    ? lifecycle.startReceipt
    : undefined;
  assertReportingContract(config.reporting, {
    agent: config.agent,
    model: config.model,
    controlConversationId: lifecycle ? lifecycle.controlConversationId : undefined,
    lifecycleStartReceipt: receipt
      ? {
          conversationId: receipt.conversationId,
          messageId: receipt.messageId,
          deliveredAt: receipt.deliveredAt
        }
      : undefined
  });
}

export function runEnvironmentPreflight(config, env) {
  for (const name of config.requiredEnv || []) {
    const value = env[name];
    if (typeof value !== "string" || value.length === 0) {
      fail(
        (typeof value === "string" ? "required_env_empty:" : "required_env_missing:") + name
      );
    }
  }
  for (const name of config.forbiddenEnv || []) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      fail("forbidden_env_present:" + name);
    }
  }
}

// Maps filesystem errors on the env-file path to bounded diagnostic codes
// without disclosing the path, the error text, or any file content.
function envFileAccessFailureCode(error) {
  const code = error && error.code;
  if (code === "EACCES" || code === "EPERM") {
    return "claude_env_file_open_denied";
  }
  if (code === "ENOTDIR") {
    return "claude_env_file_parent_not_directory";
  }
  if (code === "ELOOP" || code === "EMLINK") {
    return "claude_env_file_symlink";
  }
  if (code === "ENOENT") {
    return "claude_env_file_missing";
  }
  return "claude_env_file_open_failed";
}

// Validates the private Claude setup-token env file without ever exposing its
// content. Returns the assigned token value for source comparison only; every
// failure carries a sanitized code with no path, value, hash, or length.
export function validateClaudeAuthEnvFile(envFilePath) {
  if (typeof envFilePath !== "string" || !path.isAbsolute(envFilePath)) {
    fail("claude_env_file_not_absolute");
  }
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    fail("claude_env_file_unsupported_platform");
  }
  const uid = process.getuid();

  const parent = path.dirname(envFilePath);
  let parentStat;
  try {
    parentStat = fs.lstatSync(parent);
  } catch {
    fail("claude_env_file_parent_missing");
  }
  if (parentStat.isSymbolicLink()) {
    fail("claude_env_file_parent_symlink");
  }
  if (!parentStat.isDirectory()) {
    fail("claude_env_file_parent_not_directory");
  }
  if (parentStat.uid !== uid) {
    fail("claude_env_file_parent_owner");
  }
  if ((parentStat.mode & 0o777) !== 0o700) {
    fail("claude_env_file_parent_permissions");
  }

  // lstat before open so a FIFO (or other non-regular file) is rejected
  // without the blocking open a FIFO would otherwise cause.
  let pathStat;
  try {
    pathStat = fs.lstatSync(envFilePath);
  } catch (error) {
    fail(envFileAccessFailureCode(error));
  }
  if (pathStat.isSymbolicLink()) {
    fail("claude_env_file_symlink");
  }
  if (!pathStat.isFile()) {
    fail("claude_env_file_not_regular");
  }

  // Open with O_NOFOLLOW and re-check the open descriptor so the checked file
  // is the read file, without a symlink or replacement race in between.
  // O_NONBLOCK is harmless for a regular file and keeps a FIFO swapped in
  // after the lstat from blocking the open; fstat below still rejects it.
  let fd;
  try {
    fd = fs.openSync(
      envFilePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
  } catch (error) {
    fail(envFileAccessFailureCode(error));
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      fail("claude_env_file_not_regular");
    }
    if (stat.uid !== uid) {
      fail("claude_env_file_owner");
    }
    if ((stat.mode & 0o777) !== 0o600) {
      fail("claude_env_file_permissions");
    }
    if (stat.size === 0 || stat.size > MAX_CLAUDE_ENV_FILE_BYTES) {
      fail("claude_env_file_size");
    }
    const buffer = Buffer.alloc(Number(stat.size));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) {
      fail("claude_env_file_size");
    }
    const match = CLAUDE_ENV_FILE_ASSIGNMENT.exec(buffer.toString("utf8"));
    if (!match) {
      fail("claude_env_file_format");
    }
    return match[1];
  } finally {
    fs.closeSync(fd);
  }
}

// Supervisor-side bypass guard. Runs before dynamic runtime import, probing,
// or adapter startup, and re-asserts the auth profile rather than trusting a
// config object assembled in memory. For agent "claude" it requires proof that
// this exact process was started through the canonical --env-file injection,
// and enforces the Claude credential contract even when the generic
// requiredEnv/forbiddenEnv arrays are empty.
export function runClaudeSupervisorPreflight(config, env, execArgv) {
  if (!isClaudeAgent(config.agent)) {
    if (config.auth !== undefined) {
      fail("claude_auth_not_applicable");
    }
    return;
  }
  // A spelling that ACPX would normalize to "claude" but is not the exact
  // canonical value gets the Claude gate, not a pass into the generic path.
  // runSupervisor's centralized closed-set gate already rejects it with
  // invalid_agent_not_canonical; this branch keeps the guard fail-closed as
  // defense in depth when it is invoked directly.
  if (config.agent !== CLAUDE_AGENT) {
    fail("claude_agent_not_canonical");
  }

  const auth = config.auth;
  if (
    !isPlainObject(auth) ||
    auth.kind !== CLAUDE_AUTH_KIND ||
    typeof auth.envFile !== "string" ||
    !path.isAbsolute(auth.envFile)
  ) {
    fail("claude_auth_missing");
  }

  // Exactly one Node option: the exact canonical single-token spelling bound
  // to the declared file. An absent or empty exec argv is a bare launch and
  // fails as missing; every other shape — a split "--env-file path" pair, an
  // -if-exists variant, a different path, a duplicate, or any extra Node
  // option — is one mismatch class.
  if (!Array.isArray(execArgv) || execArgv.length === 0) {
    fail("claude_env_file_option_missing");
  }
  if (execArgv.length !== 1 || execArgv[0] !== "--env-file=" + auth.envFile) {
    fail("claude_env_file_option_mismatch");
  }

  runEnvironmentPreflight(CLAUDE_IMPLICIT_ENV_CONTRACT, env);

  const fileToken = validateClaudeAuthEnvFile(auth.envFile);
  // Compare the loaded environment value to the file assignment without
  // disclosing either; fixed-size digests avoid a value or length leak.
  const digestOf = (value) => crypto.createHash("sha256").update(value, "utf8").digest();
  if (!crypto.timingSafeEqual(digestOf(env[CLAUDE_OAUTH_TOKEN_ENV]), digestOf(fileToken))) {
    fail("claude_env_token_source_mismatch");
  }
}

function parseClaudeAuthProfile(value) {
  if (!isPlainObject(value)) {
    fail("invalid_auth");
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("envFile")) {
    fail("invalid_auth");
  }
  if (value.kind !== CLAUDE_AUTH_KIND) {
    fail("invalid_auth_kind");
  }
  return {
    kind: CLAUDE_AUTH_KIND,
    envFile: resolveAbsolute(value.envFile, "invalid_auth_env_file")
  };
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

  const agent = assertIdentifier(raw.agent, "invalid_agent", 128);
  // The closed supported set is enforced before any other filesystem access
  // or config parsing: an unsupported or non-canonical agent never reaches
  // the cwd/prompt/response probes, the auth parser, or the reporting
  // contract, and fails with the same stable code on every path.
  assertCanonicalSupportedAgent(agent);
  let auth;
  if (agent === CLAUDE_AGENT) {
    auth = parseClaudeAuthProfile(raw.auth);
  } else if (raw.auth !== undefined) {
    // A Claude auth profile on a non-Claude agent is misleading: it would
    // never be enforced, so it is rejected rather than silently ignored.
    fail("invalid_auth_agent");
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
  const timeoutMs = assertPositiveInteger(raw.timeoutMs, "invalid_timeout_ms");
  const progressMs = raw.progressMs === undefined
    ? 0
    : assertPositiveInteger(raw.progressMs, "invalid_progress_ms", { allowZero: true });
  if (progressMs > 0 && progressMs < 1000) {
    fail("invalid_progress_ms");
  }

  const requiredEnv = parseEnvContractList(raw.requiredEnv, "invalid_required_env");
  const forbiddenEnv = parseEnvContractList(raw.forbiddenEnv, "invalid_forbidden_env");
  const requiredEnvIdentities = new Set(requiredEnv.map((name) => name.toUpperCase()));
  for (const name of forbiddenEnv) {
    if (requiredEnvIdentities.has(name.toUpperCase())) {
      fail("invalid_env_contract_overlap");
    }
  }
  // An implicit environment contract is enforced automatically at run time
  // for every supported agent — the agent-neutral process-integrity baseline,
  // widened to the full Claude credential contract for agent "claude" — so a
  // caller-declared contract that contradicts it is invalid config: requiring
  // an implicitly forbidden variable (or forbidding an implicitly required
  // one) under any letter case fails invalid_env_contract_overlap.
  const implicitContract = agent === CLAUDE_AGENT
    ? CLAUDE_IMPLICIT_ENV_CONTRACT
    : ACP_BASELINE_ENV_CONTRACT;
  const implicitForbidden = new Set(
    implicitContract.forbiddenEnv.map((name) => name.toUpperCase())
  );
  const implicitRequired = new Set(
    implicitContract.requiredEnv.map((name) => name.toUpperCase())
  );
  for (const name of requiredEnv) {
    if (implicitForbidden.has(name.toUpperCase())) {
      fail("invalid_env_contract_overlap");
    }
  }
  for (const name of forbiddenEnv) {
    if (implicitRequired.has(name.toUpperCase())) {
      fail("invalid_env_contract_overlap");
    }
  }

  const lifecycle = parseLifecycleContract(raw.lifecycle);

  if (!Array.isArray(raw.allowKinds) || raw.allowKinds.length === 0) {
    fail("invalid_allow_kinds");
  }
  const allowKinds = new Set();
  for (const value of raw.allowKinds) {
    if (typeof value !== "string" || !CONFIGURABLE_TOOL_KINDS.has(value)) {
      fail("invalid_allow_kind");
    }
    allowKinds.add(value);
  }

  const model = raw.model === undefined
    ? undefined
    : assertIdentifier(raw.model, "invalid_model", 256);

  // Mandatory reporting bundle, validated last so every structural field it
  // binds to (agent, model, lifecycle receipt) is already trusted, and before
  // any runtime import, probe, or adapter startup can occur. Binding the
  // canonical agent here is what makes the public harness label unforgeable:
  // the contract derives the label from its closed mapping and this agent,
  // and rejects an unsupported agent with invalid_reporting_agent. The
  // context receipt uses the parsed lifecycle's original deliveredAt
  // spelling: the contract compares it byte-for-byte against the
  // caller-attested lifecycle receipt.
  const reporting = assertReportingContract(raw.reporting, {
    agent,
    model,
    controlConversationId: lifecycle.controlConversationId,
    lifecycleStartReceipt: {
      conversationId: lifecycle.startReceipt.conversationId,
      messageId: lifecycle.startReceipt.messageId,
      deliveredAt: lifecycle.startReceipt.deliveredAt
    }
  });

  return {
    agent,
    auth,
    model,
    cwd,
    sessionKey: assertString(raw.sessionKey, "invalid_session_key", 256),
    promptText,
    responseFile,
    stateDir,
    timeoutMs,
    progressMs,
    allowKinds,
    lifecycle,
    reporting,
    requiredEnv,
    forbiddenEnv,
    maxResponseBytes: raw.maxResponseBytes === undefined
      ? 1024 * 1024
      : assertPositiveInteger(raw.maxResponseBytes, "invalid_max_response_bytes"),
    runtimeModule: resolveAbsolute(raw.runtimeModule, "invalid_runtime_module")
  };
}

function normalizedKey(value) {
  return String(value).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEnabledFlag(value) {
  if (value === true || value === 1) {
    return true;
  }
  return typeof value === "string" &&
    ENABLED_FLAG_VALUES.has(normalizedKey(value));
}

function containsPermissionBypass(command) {
  return /(?:^|\s)--dangerously-skip-permissions(?:\s|=|$)/i.test(command) ||
    /(?:^|\s)--permission-mode(?:=|\s+)(?:bypasspermissions|bypass-permissions)(?=\s|$)/i.test(command);
}

function containsNestedAgentRoute(command) {
  return /(?:^|[;&|]\s*|\b(?:npx|pnpm\s+dlx|yarn\s+dlx)\s+)acpx(?:@[a-zA-Z0-9_.-]+)?(?:\s|$)/i.test(command) ||
    /\bopenclaw\s+(?:acp\s+spawn\b|sessions?\s+spawn\b[^\n]*--runtime(?:=|\s+)acp\b)/i.test(command) ||
    /(?:^|\s)claude(?:\s|$)[^\n]*(?:--bg|--background)(?:\s|=|$)/i.test(command);
}

function inspectPermissionInput(rawInput) {
  if (!isPlainObject(rawInput)) {
    return { complete: false, background: false, bypass: false, commands: [] };
  }

  const state = {
    complete: true,
    nodes: 0,
    background: false,
    bypass: false,
    commands: []
  };

  const recordCommand = (value) => {
    if (typeof value === "string") {
      state.commands.push(value);
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_COLLECTION_ITEMS) {
        state.complete = false;
        return;
      }
      for (const item of value) {
        if (typeof item === "string") {
          state.commands.push(item);
        } else if (typeof item !== "number") {
          state.complete = false;
        }
      }
      return;
    }
    state.complete = false;
  };

  const walk = (value, depth) => {
    if (!state.complete) {
      return;
    }
    if (depth > MAX_INSPECTION_DEPTH) {
      state.complete = false;
      return;
    }
    state.nodes += 1;
    if (state.nodes > MAX_INSPECTION_NODES) {
      state.complete = false;
      return;
    }

    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > MAX_INSPECTED_STRING_BYTES) {
        state.complete = false;
      }
      return;
    }
    if (value === null || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_COLLECTION_ITEMS) {
        state.complete = false;
        return;
      }
      for (const item of value) {
        walk(item, depth + 1);
      }
      return;
    }
    if (!isPlainObject(value)) {
      state.complete = false;
      return;
    }

    const entries = Object.entries(value);
    if (entries.length > MAX_COLLECTION_ITEMS) {
      state.complete = false;
      return;
    }
    for (const [key, child] of entries) {
      const keyName = normalizedKey(key);
      if (BACKGROUND_KEYS.has(keyName) && isEnabledFlag(child)) {
        state.background = true;
      }
      if (
        keyName === "dangerouslyskippermissions" &&
        isEnabledFlag(child)
      ) {
        state.bypass = true;
      }
      if (
        typeof child === "string" &&
        (
          normalizedKey(child) === "bypasspermissions" ||
          normalizedKey(child) === "dangerouslyskippermissions" ||
          (
            keyName.includes("permission") &&
            normalizedKey(child).includes("bypasspermissions")
          )
        )
      ) {
        state.bypass = true;
      }
      if (COMMAND_KEYS.has(keyName)) {
        recordCommand(child);
      }
      walk(child, depth + 1);
    }
  };

  walk(rawInput, 0);
  for (const command of state.commands) {
    if (containsPermissionBypass(command)) {
      state.bypass = true;
    }
  }
  return state;
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
  if (kind === "other") {
    return { allowed: false, reason: "unclassified_tool_kind", kind };
  }
  if (!allowKinds.has(kind)) {
    return { allowed: false, reason: "tool_kind_not_allowed", kind };
  }

  const inspection = inspectPermissionInput(toolCall && toolCall.rawInput);
  if (!inspection.complete) {
    return { allowed: false, reason: "uninspectable_input", kind };
  }
  if (inspection.bypass) {
    return { allowed: false, reason: "permission_bypass", kind };
  }
  if (inspection.background) {
    return { allowed: false, reason: "background_flag", kind };
  }
  for (const command of inspection.commands) {
    if (containsNestedAgentRoute(command)) {
      return { allowed: false, reason: "nested_agent_route", kind };
    }
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
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    fail("invalid_runtime_module_symlink");
  }
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
  const moduleStat = fs.lstatSync(location.modulePath);
  if (moduleStat.isSymbolicLink()) {
    fail("acpx_runtime_module_symlink");
  }
  if (!moduleStat.isFile()) {
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

function safeSessionReference(sessionKey) {
  return crypto.createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
}

function safeStopReason(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  return /^[a-zA-Z0-9_.:-]{1,96}$/.test(value) ? value : undefined;
}

export function safeDiagnosticCode(value, fallback, maxLength = 128) {
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

function bindCancellationSignals(getTurn, emit, signalSource) {
  let requestedSignal;
  let cancellationStarted = false;
  const handlers = new Map();

  const requestCancellation = () => {
    if (!requestedSignal || cancellationStarted) {
      return;
    }
    const currentTurn = getTurn();
    if (!currentTurn) {
      return;
    }
    cancellationStarted = true;
    try {
      Promise.resolve(currentTurn.cancel({
        reason: "signal:" + requestedSignal
      })).catch(() => {
        emit("activity", {
          activity: "cancellation_request_failed",
          signal: requestedSignal
        });
      });
    } catch {
      emit("activity", {
        activity: "cancellation_request_failed",
        signal: requestedSignal
      });
    }
  };

  for (const signalName of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (requestedSignal) {
        return;
      }
      requestedSignal = signalName;
      emit("activity", {
        activity: "cancellation_requested",
        signal: signalName
      });
      requestCancellation();
    };
    handlers.set(signalName, handler);
    signalSource.on(signalName, handler);
  }

  return {
    attachTurn: requestCancellation,
    stop() {
      for (const [signalName, handler] of handlers) {
        signalSource.off(signalName, handler);
      }
    }
  };
}

async function waitForTurnResult(turn, timeoutMs, emit, graceMs) {
  let deadlineTimer;
  const settled = Promise.resolve(turn.result).then(
    (value) => ({ type: "result", value }),
    (error) => ({ type: "error", error })
  );
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
  });
  let outcome = await Promise.race([settled, deadline]);
  clearTimeout(deadlineTimer);

  if (outcome.type === "result") {
    return outcome.value;
  }
  if (outcome.type === "error") {
    throw outcome.error;
  }

  emit("activity", { activity: "timeout_cancellation_requested" });
  try {
    Promise.resolve(turn.cancel({ reason: "supervisor_timeout" })).catch(() => {
      emit("activity", { activity: "timeout_cancellation_failed" });
    });
  } catch {
    emit("activity", { activity: "timeout_cancellation_failed" });
  }

  let graceTimer;
  const grace = new Promise((resolve) => {
    graceTimer = setTimeout(() => resolve({ type: "grace_timeout" }), graceMs);
  });
  outcome = await Promise.race([settled, grace]);
  clearTimeout(graceTimer);
  if (outcome.type === "result") {
    return outcome.value;
  }
  if (outcome.type === "error") {
    throw outcome.error;
  }
  fail("supervisor_timeout");
}

// A close rejection counts as "backend does not implement session/close" only
// through the runtime's structured error code, never through message text:
// runtime.close with discardPersistentState requests exactly one backend
// control, so an ACP_BACKEND_UNSUPPORTED_CONTROL rejection of that call is
// unambiguous. Anything else — other codes, code-less errors whose message
// merely mentions session/close, timeouts — is not an unsupported-close
// signal.
export function isUnsupportedSessionCloseCleanupError(error) {
  return error !== null &&
    typeof error === "object" &&
    error.code === ACPX_UNSUPPORTED_CONTROL_ERROR_CODE;
}

// Like settleEventPump, but keeps the rejection value: the cleanup fallback
// gate has to distinguish the structured unsupported-control rejection from
// every other cleanup failure. The error never reaches normalized output.
async function settleCleanupClose(closeTask, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs);
  });
  const settled = closeTask.then(
    () => ({ ok: true, timedOut: false }),
    (error) => ({ ok: false, timedOut: false, error })
  );
  const result = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return result;
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
  let progressTimer;
  let eventIterator;
  let eventPumpStopped = false;
  let outputClosed = false;
  let response = "";
  let responseTruncated = false;
  const deadlineGraceMs = dependencies.deadlineGraceMs ?? 5000;
  const eventDrainTimeoutMs = dependencies.eventDrainTimeoutMs ?? 2000;
  const eventCloseGraceMs = dependencies.eventCloseGraceMs ?? 500;
  const cleanupTimeoutMs = dependencies.cleanupTimeoutMs ?? 5000;

  const emit = (type, payload = {}) => {
    if (outputClosed) {
      return false;
    }
    const closesOutput = type === "terminal" || type === "supervisor_error";
    if (closesOutput) {
      outputClosed = true;
    }
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
    return true;
  };

  const signalBinding = dependencies.bindSignals === false
    ? { attachTurn() {}, stop() {} }
    : bindCancellationSignals(
        () => turn,
        emit,
        dependencies.signalSource || process
      );

  // Property presence, not truthiness: an explicitly injected undefined must
  // exercise the invalid-shape branches instead of silently picking up the
  // host process's own environment or exec argv.
  const environment = "env" in dependencies ? dependencies.env : process.env;
  const execArgv = "execArgv" in dependencies
    ? dependencies.execArgv
    : process.execArgv;

  try {
    // The closed-set agent gate runs first so a config assembled in memory
    // carries the same stable canonical error semantics as the loader for
    // every supported agent — no order-dependent asymmetry between the
    // Claude route guard and the reporting backstop.
    assertCanonicalSupportedAgent(config.agent);
    runStartReceiptPreflight(config, now());
    // Agent-neutral process-integrity baseline, enforced for every supported
    // agent before any runtime module import — even when the caller-declared
    // requiredEnv/forbiddenEnv arrays are empty. The Claude route guard then
    // layers the provider-specific credential contract on top.
    runEnvironmentPreflight(ACP_BASELINE_ENV_CONTRACT, environment);
    runClaudeSupervisorPreflight(config, environment, execArgv);
    runReportingPreflight(config);
    runEnvironmentPreflight(config, environment);
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
      mode: ACP_SESSION_MODE,
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

    signalBinding.attachTurn();

    emit("started", {
      agent: config.agent,
      model: config.model || ACP_REPORT_RUNTIME_DEFAULT_MODEL_LABEL,
      sessionRef: safeSessionReference(config.sessionKey),
      runtimeVersion: safeRuntimeVersion(loaded.version),
      allowedToolKinds: [...config.allowKinds].sort()
    });

    eventIterator = turn.events[Symbol.asyncIterator]();
    const eventPump = (async () => {
      while (!eventPumpStopped) {
        const next = await eventIterator.next();
        if (next.done || eventPumpStopped) {
          break;
        }
        const event = next.value;
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

    const result = await waitForTurnResult(
      turn,
      config.timeoutMs,
      emit,
      deadlineGraceMs
    );
    if (!result || !["completed", "cancelled", "failed"].includes(result.status)) {
      fail("acpx_turn_result_invalid");
    }

    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = undefined;
    }

    const streamState = await settleEventPump(eventPump, eventDrainTimeoutMs);
    if (!streamState.ok) {
      eventPumpStopped = true;
      const stopTasks = [];
      try {
        stopTasks.push(Promise.resolve(
          turn.closeStream({ reason: "terminal_result" })
        ));
      } catch {
        // The result remains authoritative even when stream cleanup fails.
      }
      if (eventIterator && typeof eventIterator.return === "function") {
        try {
          stopTasks.push(Promise.resolve(eventIterator.return()));
        } catch {
          // The output latch still prevents post-terminal delivery.
        }
      }
      if (stopTasks.length > 0) {
        await settleEventPump(
          Promise.allSettled(stopTasks),
          eventCloseGraceMs
        );
      }
      await settleEventPump(eventPump, eventCloseGraceMs);
    } else {
      eventPumpStopped = true;
    }

    let cleanupOk = true;
    let cleanupFallback = false;
    const cleanupState = await settleCleanupClose(
      Promise.resolve().then(() => runtime.close({
        handle,
        reason: "supervisor_terminal",
        discardPersistentState: true
      })),
      cleanupTimeoutMs
    );
    if (cleanupState.ok) {
      runtime = undefined;
    } else if (
      // Bounded capability exception for one exact shape: the canonical codex
      // adapter completes the oneshot turn but does not implement the
      // session/close backend control, so the discardPersistentState close is
      // rejected with the runtime's structured unsupported-control code. Only
      // then — after an exact completed result, a fully drained event stream,
      // and an untruncated response, and never on a timeout — close is
      // retried once without requesting backend persistent-state disposal,
      // which still cancels and closes the local handle deterministically.
      // Every other agent, terminal status, cleanup error, and the
      // catch/finally cleanup path keeps the fail-closed contract unchanged.
      config.agent === CODEX_AGENT &&
      ACP_SESSION_MODE === "oneshot" &&
      result.status === "completed" &&
      streamState.ok &&
      !responseTruncated &&
      !cleanupState.timedOut &&
      isUnsupportedSessionCloseCleanupError(cleanupState.error)
    ) {
      emit("activity", { activity: "cleanup_unsupported_close_fallback" });
      const fallbackState = await settleCleanupClose(
        Promise.resolve().then(() => runtime.close({
          handle,
          reason: "supervisor_terminal_unsupported_close"
        })),
        cleanupTimeoutMs
      );
      if (fallbackState.ok) {
        cleanupFallback = true;
        runtime = undefined;
      } else {
        cleanupOk = false;
      }
    } else {
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
      responseTruncated,
      responseStored,
      eventStreamOk: streamState.ok,
      eventStreamTimedOut: streamState.timedOut,
      cleanupOk,
      counters: publicCounters(counters)
    };
    if (cleanupFallback) {
      terminal.cleanupFallback = true;
    }
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
    eventPumpStopped = true;
    if (runtime && turn) {
      await settleEventPump(
        Promise.resolve().then(() => turn.closeStream({
          reason: "supervisor_cleanup"
        })),
        eventCloseGraceMs
      );
    }
    if (runtime && handle) {
      await settleEventPump(
        Promise.resolve().then(() => runtime.close({
          handle,
          reason: "supervisor_cleanup",
          discardPersistentState: true
        })),
        cleanupTimeoutMs
      );
    }
    signalBinding.stop();
  }
}

// Shared by the supervisor and the canonical Claude launcher: both accept
// exactly one private config-file path behind --config.
export function parseConfigCli(argv) {
  if (argv.length !== 2 || argv[0] !== "--config") {
    fail("usage");
  }
  return argv[1];
}

export async function main(argv = process.argv.slice(2)) {
  let config;
  try {
    const configPath = parseConfigCli(argv);
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

const PROCESS_EXIT_FLUSH_TIMEOUT_MS = 1000;

function flushWritable(stream, timeoutMs = PROCESS_EXIT_FLUSH_TIMEOUT_MS) {
  if (!stream || typeof stream.write !== "function") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (typeof stream.off === "function") {
        stream.off("error", finish);
      }
      resolve();
    };
    timer = setTimeout(finish, timeoutMs);
    timer.unref();
    if (typeof stream.once === "function") {
      stream.once("error", finish);
    }
    try {
      stream.write("", finish);
    } catch {
      finish();
    }
  });
}

async function exitCli(exitCode) {
  process.exitCode = exitCode;
  await Promise.allSettled([
    flushWritable(process.stdout),
    flushWritable(process.stderr)
  ]);
  process.exit(exitCode);
}

if (isCliEntry(process.argv[1], import.meta.url)) {
  await exitCli(await main());
}
