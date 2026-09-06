/**
 * ACP reporting contract (current acp-reporting-v3, with bounded v2 and v1
 * compatibility paths).
 *
 * Pure, deterministic, dependency-free validation of the reporting bundle an
 * ACP turn must register before doing any work: the public round-start
 * message, the lifecycle start receipt, control-channel routing, and the
 * public-only watchdog payload. Fail-closed by design: anything that does not
 * match the exact public templates below is rejected with a stable
 * `invalid_reporting_*` error code. Error messages never echo secrets or the
 * full rejected payload — at most a key name or a forbidden-pattern label.
 * No I/O, no clock access, no randomness.
 *
 * The public harness label on the ACP identity lines is never caller-chosen:
 * it is resolved from the closed ACP_AGENT_PRESENTATIONS mapping keyed by the
 * canonical config agent that the caller binds through the validation
 * context. An agent outside the mapping, or any non-canonical spelling of a
 * supported agent, is rejected with `invalid_reporting_agent` before any
 * template content is examined.
 *
 * The module also owns the one production preparation path for the start
 * message: buildAcpStartMessage derives the complete 13-line round-start
 * template — round title included — from structured inputs and self-checks
 * the result through the same validator, so callers never hand-assemble the
 * template or choose its title or harness label.
 */

const MAX_DISCORD_MESSAGE_LENGTH = 1400;
const MAX_PAYLOAD_MESSAGE_LENGTH = 2000;
const MAX_REPOSITORY_LENGTH = 100;
const MAX_BRANCH_LENGTH = 200;
const MAX_WATCHDOG_ID_LENGTH = 200;
const MAX_ROUND_INDEX = 1000;
// Context bounds mirror the supervisor's own config bounds so the pure
// contract and the loader accept the same values: identifiers use the
// supervisor's 1..32-digit DISCORD_ID shape, model the 256-character
// invalid_model bound, and deliveredAt the 40-character lifecycle bound.
const MAX_MODEL_LENGTH = 256;
const MAX_DELIVERED_AT_LENGTH = 40;
// Legacy v1/v2 disabled-watchdog schedule, retained only so validateWatchdog
// still recognizes already-prepared v1/v2 bundles. It mirrors the transport's
// REPORT_CADENCE_MS (acp-host-transport.mjs) and is unrelated to the v3
// report pump, which polls on ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS below.
const WATCHDOG_EVERY_MS = 600000;
const MAX_WATCHDOG_TIMEOUT_SECONDS = 60;

// Non-secret structural identity of the deterministic OpenClaw 2026.8.1
// controller job. The digest is over the exact public script template with
// its literal LEASE_TOKEN and JOB_ID placeholders, never over a substituted
// job. The actual lease token and the substituted scheduler-returned job id
// exist only in scheduler-private job state.
export const ACP_REPORT_CONTROLLER_SCRIPT_VERSION = 'acp-report-controller-script.v1';
export const ACP_REPORT_CONTROLLER_SCRIPT_SHA256 = '1dd0ccd2d2bd25ef25c002672a2b6ac4ccf7721b2b9e6304bdf4ddd8ce8ca6f2';
export const ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS = 60000;
export const ACP_REPORT_CONTROLLER_TIMEOUT_SECONDS = 60;
export const ACP_REPORT_CONTROLLER_TOOL_BUDGET = 5;
export const ACP_REPORT_CONTROLLER_TOOLS_ALLOW = Object.freeze([
  'acp_report_controller',
  'message',
  'automations',
]);

export const ACP_REPORTING_SCHEMA_VERSION_V1 = 'acp-reporting-v1';
export const ACP_REPORTING_SCHEMA_VERSION_V2 = 'acp-reporting-v2';
export const ACP_REPORTING_SCHEMA_VERSION_V3 = 'acp-reporting-v3';
export const ACP_REPORTING_SCHEMA_VERSIONS = Object.freeze([
  ACP_REPORTING_SCHEMA_VERSION_V1,
  ACP_REPORTING_SCHEMA_VERSION_V2,
  ACP_REPORTING_SCHEMA_VERSION_V3,
]);

// Closed, fail-closed agent presentation mapping. The key is the canonical
// ACP agent name a supervisor config may declare; the value is the only
// public harness label the reporting templates may show for it. Extending
// support to another agent means adding it here (and updating the runtime
// contract) — a caller can never introduce a label through config data.
export const ACP_AGENT_PRESENTATIONS = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
});
export const ACP_SUPPORTED_AGENTS = Object.freeze(Object.keys(ACP_AGENT_PRESENTATIONS));

// The one agent whose runs may still present the legacy acp-reporting-v1
// bundle shape during the bounded v1 → v2 migration. Every other agent —
// including codex — must use acp-reporting-v2 from its first supported run,
// so no v1 bundle ever exists that names a non-Claude label.
export const ACP_REPORTING_V1_COMPAT_AGENT = 'claude';

// Label used on the ACP identity line when the run has no pinned model. The
// supervisor emits the same label in its `started` event, so the public
// message and the normalized event stream agree.
export const ACP_REPORT_RUNTIME_DEFAULT_MODEL_LABEL = 'runtime-default';

export const ACP_REPORT_INSTRUCTION =
  '다음 구분자 사이의 메시지만 그대로 반환해. 앞말·뒷말·설명·코드펜스·바꿔쓰기·두 번째 메시지를 추가하지 마.';
export const ACP_REPORT_BEGIN_DELIMITER = '---BEGIN ACP REPORT---';
export const ACP_REPORT_END_DELIMITER = '---END ACP REPORT---';

// Canonical middle-report section headers, in required order. 실행 상태 is a
// metadata line (report line 7), never a section. The optional 이슈 section,
// when present, must come last.
export const ACP_REPORT_SECTION_HEADERS = Object.freeze([
  '✅ **새 결과**',
  '🛠️ **ACP 진행 중**',
  '🧪 **ACP 자체 검증**',
  '⏭️ **ACP 다음**',
]);
export const ACP_REPORT_ISSUE_HEADER = '⚠️ **이슈**';
export const ACP_TERMINAL_REPORT_STATUSES = Object.freeze([
  'completed',
  'cancelled',
  'failed',
]);
// Canonical 새 결과 bullet content when no material ACP result completed since
// the last successfully delivered intermediate report. The Δ counter and the
// 마지막 ACP 활동 age are independent by contract: fresh ACP activity (reads,
// edits, searches, command completions) with no newly completed material
// result renders `Δ0 · 새로 확인된 ACP 결과 없음` next to an activity age of
// `0분 전`.
export const ACP_REPORT_NO_NEW_RESULT = '새로 확인된 ACP 결과 없음';

export function isReportPumpId(value) {
  return typeof value === 'string' &&
    value.length >= 1 && value.length <= MAX_WATCHDOG_ID_LENGTH &&
    !NO_WHITESPACE_OR_CONTROL_RE.test(value);
}

// The only valid phaseIndex → phaseName mappings for the 라운드 metadata line.
export const ACP_REPORT_PHASES = Object.freeze({
  1: '분석',
  2: '구현',
  3: '자체 검증',
  4: '완료 준비',
});

export const ACP_REPORTING_ERROR_CODES = Object.freeze([
  'invalid_reporting_context',
  'invalid_reporting_agent',
  'invalid_reporting_root',
  'invalid_reporting_unknown_key',
  'invalid_reporting_schema_version',
  'invalid_reporting_round_index',
  'invalid_reporting_repository',
  'invalid_reporting_branch',
  'invalid_reporting_start_message',
  'invalid_reporting_destination',
  'invalid_reporting_start_receipt',
  'invalid_reporting_watchdog',
  'invalid_reporting_watchdog_round',
  'invalid_reporting_watchdog_schedule',
  'invalid_reporting_watchdog_delivery',
  'invalid_reporting_watchdog_payload',
  'invalid_reporting_watchdog_message',
  'invalid_reporting_report_pump',
  'invalid_reporting_report_pump_round',
  'invalid_reporting_report_pump_schedule',
  'invalid_reporting_report_pump_delivery',
  'invalid_reporting_report_pump_payload',
  'invalid_reporting_report',
  'invalid_reporting_forbidden_content',
]);

export class AcpReportingContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AcpReportingContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AcpReportingContractError(code, message);
}

// All C0 controls, DEL, the C1 range (U+0080-U+009F, which carries NEL and
// the raw ANSI CSI introducer), and the U+2028/U+2029 line separators that
// many renderers treat as newlines. The multi-line variant excludes LF
// (U+000A) so legitimate newlines pass while CR and every other line/control
// character fails.
const SINGLE_LINE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const MULTILINE_CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/;
const NO_WHITESPACE_OR_CONTROL_RE = /[\s\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
// Zero-width and directionality format characters that render as nothing (or
// only reorder surrounding text): a free-text slot made only of these is
// visually empty. Emoji presentation selectors (U+FE0E/U+FE0F) are
// deliberately absent -- they accompany visible emoji in the fixed headers.
const INVISIBLE_FORMAT_RE =
  /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const DECIMAL_ID_RE = /^[0-9]{1,32}$/;
const HHMM = '(?:[01][0-9]|2[0-3]):[0-5][0-9]';

// Conservative, bounded forbidden-content list for the FREE-TEXT SLOTS of the
// start message and the rendered report (bullets, elapsed-time value, 실행
// 상태 value). It is a tripwire for known operational patterns, not a
// semantic filter: novel paraphrases are out of its scope, and the
// exact-template layout checks remain the primary control. Metadata
// (repository/branch/model lines) is bound by its own validators and is never
// screened, so names that merely contain a denylisted word stay legal. Each
// entry pairs a short label (safe to put in error messages) with a
// case-insensitive pattern anchored on word boundaries or Korean collocations
// so ordinary public words (ACP, 작업, 진행, 상태, 라운드, …) never match on
// their own.
const FORBIDDEN_CONTENT_PATTERNS = Object.freeze([
  ['session-json', /세션\s*json/iu],
  ['session-internals', /세션\s*(파일|핸들|경로|조회|검사)/u],
  ['process-id', /\bpid\b/iu],
  ['ps-p', /\bps\s+-p\b/iu],
  ['ps-listing', /\bps\s+(aux|-ef)\b/iu],
  ['git-status', /git\s+status/iu],
  ['git-log', /git\s+log\b/iu],
  ['git-inspect', /git\s+(diff|show|reflog)\b/iu],
  ['absolute-path', /(^|[^\p{L}\p{N}])\/(users|home|tmp|var|etc|opt|srv|proc|private)\//iu],
  ['home-path', /(^|[^\p{L}\p{N}])~\//u],
  ['windows-path', /\b[a-z]:\\/iu],
  ['shell-ls', /\bls\s+-[a-z]/iu],
  ['shell-cat', /\bcat\s+\S*\//iu],
  ['shell-tail', /\btail\s+-f\b/iu],
  ['shell-grep', /\bgrep\b/iu],
  ['shell-kill', /\b(kill\s+-?[0-9]|pkill|killall)\b/iu],
  ['shell-detach', /\b(nohup|disown|setsid)\b/iu],
  ['shell-exec', /\b(sh|bash|zsh)\s+-c\b/iu],
  ['process-inspection', /(프로세스|세션)\s*(핸들|목록|조회|확인)/u],
  ['message-inspection', /메시지\s*(검색|조회|검사)/u],
  ['file-inspection', /파일\s*(조회|검사|열람)/u],
  ['snapshot-internals', /(스냅샷|\bsnapshot\b)/iu],
  ['routing-internals', /(라우팅|\brouting\b)/iu],
  ['scheduler-internals', /(스케줄러|\bscheduler\b|\bcron\b)/iu],
  ['no-op', /\bno[\s-]?op\b/iu],
  ['silence', /(침묵|\bremain\s+silent\b|\bstay\s+silent\b|\bsuppress\b)/iu],
  ['suppress-report-ko', /(보내지|전송하지|응답하지|보고하지|알리지)\s*(마|말)/u],
  ['self-decide', /(스스로|알아서)\s*(판단|결정)/u],
  ['decide-whether', /\bdecide\s+whether\b/iu],
  ['do-nothing', /(아무\s*것도\s*하지\s*(마|말)|\bdo\s+nothing\b)/iu],
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Keys are attacker-controlled: bound the length and replace anything outside
// printable ASCII and letters/digits, so a hostile key cannot smuggle raw
// control bytes or ANSI escape sequences into a diagnostic message.
function describeKey(key) {
  return String(key)
    .slice(0, 40)
    .replace(/[^ -~\p{L}\p{N}]/gu, '?');
}

function assertExactKeys(value, keys, code, label) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(code, `${label} contains unsupported key "${describeKey(key)}"`);
  }
  for (const key of keys) {
    if (!(key in value)) fail(code, `${label} is missing required key "${key}"`);
  }
}

// "Non-empty" means visibly non-empty: a slot filled only with zero-width or
// directionality format characters renders as blank and is rejected.
function hasVisibleText(text) {
  return text.replace(INVISIBLE_FORMAT_RE, '').trim().length > 0;
}

function isBulletLine(line) {
  return typeof line === 'string' && line.startsWith('- ') && hasVisibleText(line.slice(2));
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// One shared model-string rule for every surface that renders a model on an
// ACP identity line, so the builder and the validator can never accept
// different model spellings.
function isValidModelString(model) {
  return (
    typeof model === 'string' &&
    model.length > 0 &&
    model.length <= MAX_MODEL_LENGTH &&
    !SINGLE_LINE_CONTROL_RE.test(model) &&
    !model.includes('`')
  );
}

function assertCanonicalAgent(agent, label) {
  // The agent is the supervisor's canonical config agent, not caller-chosen
  // presentation data. Only an exact canonical key of the closed presentation
  // mapping passes: an unsupported agent, a non-string, or any spelling that
  // merely normalizes to a supported agent ("Claude", " codex ", "CODEX")
  // fails closed before any template content is examined.
  if (
    typeof agent !== 'string' ||
    !Object.prototype.hasOwnProperty.call(ACP_AGENT_PRESENTATIONS, agent)
  ) {
    fail('invalid_reporting_agent', `${label} must be one of the canonical supported ACP agent names`);
  }
}

function validateContext(context) {
  if (!isPlainObject(context)) fail('invalid_reporting_context', 'context must be a plain object');
  const { agent, model, controlConversationId, lifecycleStartReceipt } = context;
  assertCanonicalAgent(agent, 'context.agent');
  // `model` is optional in the supervisor config. A run without a pinned
  // model identifies itself with the same fixed label the supervisor's
  // `started` event emits, so the public templates and the event stream never
  // disagree about the run's model.
  let resolvedModel;
  if (model === undefined) {
    resolvedModel = ACP_REPORT_RUNTIME_DEFAULT_MODEL_LABEL;
  } else if (!isValidModelString(model)) {
    fail('invalid_reporting_context', 'context.model must be omitted or a non-empty single-line model string');
  } else {
    if (agent !== 'claude' && model === ACP_REPORT_RUNTIME_DEFAULT_MODEL_LABEL) {
      fail('invalid_reporting_context', 'context.model must name the explicit effective model for this agent');
    }
    resolvedModel = model;
  }
  if (typeof controlConversationId !== 'string' || !DECIMAL_ID_RE.test(controlConversationId)) {
    fail('invalid_reporting_context', 'context.controlConversationId must be a decimal Discord conversation id');
  }
  if (!isPlainObject(lifecycleStartReceipt)) {
    fail('invalid_reporting_context', 'context.lifecycleStartReceipt must be a plain object');
  }
  const { conversationId, messageId, deliveredAt } = lifecycleStartReceipt;
  if (typeof conversationId !== 'string' || !DECIMAL_ID_RE.test(conversationId)) {
    fail('invalid_reporting_context', 'context.lifecycleStartReceipt.conversationId must be a decimal id');
  }
  // Same-conversation guarantee, enforced in the pure contract itself so a
  // standalone caller cannot bind reporting to a receipt earned elsewhere.
  if (conversationId !== controlConversationId) {
    fail('invalid_reporting_context', 'context.lifecycleStartReceipt.conversationId must equal controlConversationId');
  }
  if (typeof messageId !== 'string' || !DECIMAL_ID_RE.test(messageId)) {
    fail('invalid_reporting_context', 'context.lifecycleStartReceipt.messageId must be a decimal id');
  }
  if (
    typeof deliveredAt !== 'string' ||
    deliveredAt.length === 0 ||
    deliveredAt.length > MAX_DELIVERED_AT_LENGTH ||
    SINGLE_LINE_CONTROL_RE.test(deliveredAt)
  ) {
    fail('invalid_reporting_context', 'context.lifecycleStartReceipt.deliveredAt must be a non-empty single-line string');
  }
  return {
    agent,
    model: resolvedModel,
    controlConversationId,
    lifecycleStartReceipt: { conversationId, messageId, deliveredAt },
  };
}

function validateRepository(repository) {
  if (
    typeof repository !== 'string' ||
    repository.length < 1 ||
    repository.length > MAX_REPOSITORY_LENGTH
  ) {
    fail('invalid_reporting_repository', 'repository must be a 1..100 character basename');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(repository)) {
    fail('invalid_reporting_repository', 'repository may only contain letters, digits, dot, underscore, and hyphen');
  }
  if (repository === '.' || repository === '..') {
    fail('invalid_reporting_repository', 'repository must not be "." or ".."');
  }
  return repository;
}

function validateBranch(branch) {
  if (typeof branch !== 'string' || branch.length < 1 || branch.length > MAX_BRANCH_LENGTH) {
    fail('invalid_reporting_branch', 'branch must be a 1..200 character Git branch name');
  }
  if (NO_WHITESPACE_OR_CONTROL_RE.test(branch)) {
    fail('invalid_reporting_branch', 'branch must not contain whitespace or control characters');
  }
  if (/[\\~^:?*[\]`]/.test(branch)) {
    fail('invalid_reporting_branch', 'branch contains characters that are not allowed in Git branch names');
  }
  if (branch.includes('..') || branch.includes('@{')) {
    fail('invalid_reporting_branch', 'branch must not contain ".." or "@{"');
  }
  if (branch.startsWith('/') || branch.endsWith('/') || branch.includes('//')) {
    fail('invalid_reporting_branch', 'branch must not have leading, trailing, or repeated slashes');
  }
  if (branch.endsWith('.')) {
    fail('invalid_reporting_branch', 'branch must not end with a dot');
  }
  if (branch.split('/').some((part) => part.endsWith('.lock'))) {
    fail('invalid_reporting_branch', 'branch must not contain a ".lock" path component');
  }
  return branch;
}

function validateStartMessage(startMessage, expected) {
  if (typeof startMessage !== 'string' || startMessage.length === 0) {
    fail('invalid_reporting_start_message', 'startMessage must be a non-empty string');
  }
  if (startMessage.length > MAX_DISCORD_MESSAGE_LENGTH) {
    fail('invalid_reporting_start_message', `startMessage exceeds ${MAX_DISCORD_MESSAGE_LENGTH} characters`);
  }
  if (MULTILINE_CONTROL_RE.test(startMessage)) {
    fail('invalid_reporting_start_message', 'startMessage contains carriage returns or control characters');
  }
  if (startMessage.includes('```')) {
    fail('invalid_reporting_start_message', 'startMessage must not contain Markdown fences');
  }
  const lines = startMessage.split('\n');
  if (lines.length !== 13) {
    fail('invalid_reporting_start_message', 'startMessage must match the 13-line start template exactly');
  }
  const titleRe =
    expected.roundIndex === 1
      ? new RegExp(`^🚀 \\*\\*ACP 작업 시작 · ${HHMM} KST\\*\\*$`, 'u')
      : new RegExp(`^🔁 \\*\\*ACP 수정 라운드 ${expected.roundIndex} 시작 · ${HHMM} KST\\*\\*$`, 'u');
  if (!titleRe.test(lines[0])) {
    fail('invalid_reporting_start_message', 'startMessage line 1 must be the exact round title with an HH:MM KST timestamp');
  }
  const expectLine = (index, want, label) => {
    if (lines[index] !== want) {
      fail('invalid_reporting_start_message', `startMessage line ${index + 1} must be ${label}`);
    }
  };
  expectLine(1, '', 'blank');
  expectLine(2, `🤖 **ACP**: ${expected.agentLabel} · \`${expected.model}\``, 'the ACP identity line');
  expectLine(3, `📍 **작업**: \`${expected.repository}\` · \`${expected.branch}\``, 'the repository/branch line');
  expectLine(4, '', 'blank');
  expectLine(5, '🎯 **범위**', 'the 범위 section header');
  if (!isBulletLine(lines[6])) {
    fail('invalid_reporting_start_message', 'startMessage 범위 section must contain exactly one non-empty bullet');
  }
  expectLine(7, '', 'blank');
  expectLine(8, '🕒 **중간 보고**', 'the 중간 보고 section header');
  expectLine(9, '- ACP 실행 10분 이상일 때만 시작', 'the fixed 중간 보고 bullet');
  expectLine(10, '', 'blank');
  expectLine(11, '🔒 **외부 작업**', 'the 외부 작업 section header');
  if (!isBulletLine(lines[12])) {
    fail('invalid_reporting_start_message', 'startMessage 외부 작업 section must contain exactly one non-empty bullet');
  }
  // Screen the two free-text slots. Metadata lines are exact-matched against
  // the already-validated model/repository/branch above and are deliberately
  // NOT screened, so metadata that merely contains a denylisted word (branch
  // "fix/routing", repository "snapshot-tool") stays legal.
  assertNoForbiddenContent(lines[6], 'startMessage 범위 bullet');
  assertNoForbiddenContent(lines[12], 'startMessage 외부 작업 bullet');
}

function assertNoForbiddenContent(text, label) {
  for (const [patternId, pattern] of FORBIDDEN_CONTENT_PATTERNS) {
    if (pattern.test(text)) {
      fail('invalid_reporting_forbidden_content', `${label} contains forbidden operational content (${patternId})`);
    }
  }
}

// Input keys of buildAcpStartMessage. Deliberately closed: there is no title,
// label, or raw-line key, so a caller cannot smuggle presentation data into
// the builder — the round title and the public harness label are always
// derived from roundIndex and the closed presentation mapping.
const START_MESSAGE_INPUT_KEYS = Object.freeze([
  'agent',
  'model',
  'roundIndex',
  'repository',
  'branch',
  'timeKst',
  'scope',
  'externalAction',
]);
const TIME_KST_RE = new RegExp(`^${HHMM}$`);

// The two free-text slot inputs arrive as bullet content, not bullet lines:
// the builder owns the "- " prefix so a pre-assembled bullet (or a smuggled
// second line) cannot change the template shape. Error messages name only the
// slot, never the rejected text.
function validateStartBulletInput(value, label) {
  if (typeof value !== 'string' || value.length === 0 || SINGLE_LINE_CONTROL_RE.test(value)) {
    fail('invalid_reporting_start_message', `${label} must be a non-empty single-line string`);
  }
  if (value !== value.trim()) {
    fail('invalid_reporting_start_message', `${label} must not have leading or trailing whitespace`);
  }
  if (value.startsWith('- ')) {
    fail('invalid_reporting_start_message', `${label} must be bullet content without a leading "- " prefix`);
  }
  return value;
}

/**
 * Build the exact 13-line public round-start message from structured inputs.
 *
 * This is the one production preparation path for `startMessage`: the round
 * title (`🚀 ACP 작업 시작` for roundIndex 1, `🔁 ACP 수정 라운드 N 시작` for
 * every later round) and the public harness label are derived here — from
 * `roundIndex` and the closed ACP_AGENT_PRESENTATIONS mapping — and cannot be
 * supplied by the caller, so correction-round title drift is structurally
 * impossible. Pure like the validator: no I/O, no clock access (the caller
 * states the HH:MM KST delivery time), no randomness.
 *
 * The returned message is self-checked through validateStartMessage — the
 * same code path that gates run configs, including the forbidden-content
 * screen on the two free-text slots — so builder output can never drift from
 * the contract grammar.
 *
 * @param {{ agent: string, model?: string, roundIndex: number,
 *           repository: string, branch: string, timeKst: string,
 *           scope: string, externalAction: string }} input
 *   — `agent` must be a canonical key of ACP_AGENT_PRESENTATIONS. `model` may
 *   be omitted only for `claude` (the message then carries the literal
 *   `runtime-default` label); every other agent must state the run's
 *   effective model, because the supervisor normalizes its omitted config
 *   model to an explicit default before reporting validation. `scope` and
 *   `externalAction` are single-line bullet content without the "- " prefix.
 * @returns {string} the validated 13-line start message
 * @throws {AcpReportingContractError} with a stable `invalid_reporting_*` code
 */
export function buildAcpStartMessage(input) {
  if (!isPlainObject(input)) {
    fail('invalid_reporting_context', 'start-message input must be a plain object');
  }
  for (const key of Object.keys(input)) {
    if (!START_MESSAGE_INPUT_KEYS.includes(key)) {
      fail('invalid_reporting_context', `start-message input contains unsupported key "${describeKey(key)}"`);
    }
  }
  const { agent, model, roundIndex, timeKst } = input;
  assertCanonicalAgent(agent, 'input.agent');
  const agentLabel = ACP_AGENT_PRESENTATIONS[agent];
  let resolvedModel;
  if (model === undefined) {
    // Genuine model omission (the public `runtime-default` label) exists only
    // for claude runs: the supervisor normalizes an omitted codex config
    // model to its explicit default before reporting validation, so a codex
    // start message must name that effective model explicitly.
    if (agent !== 'claude') {
      fail('invalid_reporting_context', 'input.model is required for this agent and must name the run effective model');
    }
    resolvedModel = ACP_REPORT_RUNTIME_DEFAULT_MODEL_LABEL;
  } else if (!isValidModelString(model)) {
    fail('invalid_reporting_context', 'input.model must be omitted or a non-empty single-line model string');
  } else {
    if (agent !== 'claude' && model === ACP_REPORT_RUNTIME_DEFAULT_MODEL_LABEL) {
      fail('invalid_reporting_context', 'input.model must name the explicit effective model for this agent');
    }
    resolvedModel = model;
  }
  if (!Number.isInteger(roundIndex) || roundIndex < 1 || roundIndex > MAX_ROUND_INDEX) {
    fail('invalid_reporting_round_index', `roundIndex must be a positive integer of at most ${MAX_ROUND_INDEX}`);
  }
  const repository = validateRepository(input.repository);
  const branch = validateBranch(input.branch);
  if (typeof timeKst !== 'string' || !TIME_KST_RE.test(timeKst)) {
    fail('invalid_reporting_start_message', 'input.timeKst must be a 24-hour HH:MM time');
  }
  const scope = validateStartBulletInput(input.scope, 'input.scope');
  const externalAction = validateStartBulletInput(input.externalAction, 'input.externalAction');
  const title =
    roundIndex === 1
      ? `🚀 **ACP 작업 시작 · ${timeKst} KST**`
      : `🔁 **ACP 수정 라운드 ${roundIndex} 시작 · ${timeKst} KST**`;
  const startMessage = [
    title,
    '',
    `🤖 **ACP**: ${agentLabel} · \`${resolvedModel}\``,
    `📍 **작업**: \`${repository}\` · \`${branch}\``,
    '',
    '🎯 **범위**',
    `- ${scope}`,
    '',
    '🕒 **중간 보고**',
    '- ACP 실행 10분 이상일 때만 시작',
    '',
    '🔒 **외부 작업**',
    `- ${externalAction}`,
  ].join('\n');
  validateStartMessage(startMessage, {
    roundIndex,
    repository,
    branch,
    agentLabel,
    model: resolvedModel,
  });
  return startMessage;
}

function validateMiddleReport(report, expected) {
  if (report.length === 0) {
    fail('invalid_reporting_report', 'rendered report is empty');
  }
  if (report.length > MAX_DISCORD_MESSAGE_LENGTH) {
    fail('invalid_reporting_report', `rendered report exceeds ${MAX_DISCORD_MESSAGE_LENGTH} characters`);
  }
  const lines = report.split('\n');
  // 19 lines without the optional 이슈 section, 22 with it.
  if (lines.length !== 19 && lines.length !== 22) {
    fail('invalid_reporting_report', 'rendered report must match the 19-line template (22 with the optional 이슈 section)');
  }
  const titleRe = new RegExp(`^🔄 \\*\\*ACP 중간 보고 · ${HHMM} KST\\*\\*$`, 'u');
  if (!titleRe.test(lines[0])) {
    fail('invalid_reporting_report', 'report line 1 must be the exact 중간 보고 title with an HH:MM KST timestamp');
  }
  const expectLine = (index, want, label) => {
    if (lines[index] !== want) {
      fail('invalid_reporting_report', `report line ${index + 1} must be ${label}`);
    }
  };
  expectLine(1, '', 'blank');
  expectLine(2, `🤖 **ACP**: ${expected.agentLabel} · \`${expected.model}\``, 'the ACP identity line');
  expectLine(3, `📍 **작업**: \`${expected.repository}\` · \`${expected.branch}\``, 'the repository/branch line');
  const allowedRoundLines = Object.entries(ACP_REPORT_PHASES).map(
    ([phaseIndex, phaseName]) => `🔢 **라운드**: ${expected.roundIndex} · ${phaseIndex}/4 ${phaseName}`
  );
  if (!allowedRoundLines.includes(lines[4])) {
    fail('invalid_reporting_report', 'report line 5 must be the 라운드 line for this round with a valid <phaseIndex>/4 <phaseName> mapping');
  }
  const elapsedPrefix = '⏱️ **ACP 시간**: ';
  if (!lines[5].startsWith(elapsedPrefix) || !hasVisibleText(lines[5].slice(elapsedPrefix.length))) {
    fail('invalid_reporting_report', 'report line 6 must be a non-empty ACP 시간 line');
  }
  const executionStatePrefix = '🔁 **실행 상태**: ';
  if (!lines[6].startsWith(executionStatePrefix) || !hasVisibleText(lines[6].slice(executionStatePrefix.length))) {
    fail('invalid_reporting_report', 'report line 7 must be a non-empty 실행 상태 metadata line');
  }
  expectLine(7, '', 'blank');
  // Free-text slots to screen for forbidden operational content. Metadata
  // lines (identity, repository/branch, 라운드) are exact-matched against
  // validated values above and are deliberately not screened.
  const freeTextSlots = [
    [5, 'report ACP 시간 line'],
    [6, 'report 실행 상태 line'],
  ];
  for (let i = 0; i < ACP_REPORT_SECTION_HEADERS.length; i += 1) {
    const base = 8 + i * 3;
    expectLine(base, ACP_REPORT_SECTION_HEADERS[i], `the ${ACP_REPORT_SECTION_HEADERS[i]} section header`);
    if (!isBulletLine(lines[base + 1])) {
      fail('invalid_reporting_report', `report section ${ACP_REPORT_SECTION_HEADERS[i]} must contain exactly one non-empty bullet`);
    }
    freeTextSlots.push([base + 1, `report ${ACP_REPORT_SECTION_HEADERS[i]} bullet`]);
    if (i < ACP_REPORT_SECTION_HEADERS.length - 1) {
      expectLine(base + 2, '', 'blank');
    }
  }
  if (lines.length === 22) {
    expectLine(19, '', 'blank');
    expectLine(20, ACP_REPORT_ISSUE_HEADER, `the ${ACP_REPORT_ISSUE_HEADER} section header`);
    if (!isBulletLine(lines[21])) {
      fail('invalid_reporting_report', `report section ${ACP_REPORT_ISSUE_HEADER} must contain exactly one non-empty bullet`);
    }
    freeTextSlots.push([21, `report ${ACP_REPORT_ISSUE_HEADER} bullet`]);
  }
  for (const [index, label] of freeTextSlots) {
    assertNoForbiddenContent(lines[index], label);
  }
}

const REPORT_IDENTITY_INPUT_KEYS = Object.freeze([
  'agent', 'model', 'roundIndex', 'repository', 'branch', 'timeKst',
]);
// The intermediate time line is structured, never free text: 전체/현재 단계
// come from ACP elapsed bookkeeping, and 마지막 ACP 활동 is the activity age
// of the latest normalized ACP model/tool/status/activity event
// (`lastAcpActivityAt` at the transport boundary). Δ is independent of that
// age and belongs to the owner-confirmed reporting snapshot, never to the
// transport: `newResultDelta` counts material ACP results completed since the
// previous successfully delivered intermediate report, and the owner advances
// that semantic result cursor only after a verified delivery receipt. Raw
// tool completions (reads, edits, searches, command runs) are activity, never
// a material-result classifier. The legacy free-text `elapsed` key is
// deliberately absent here (still valid for the terminal 소요 line):
// pre-existing intermediate inputs carrying it fail as an unsupported key
// because the builder input shape is not a committed compatibility contract.
const INTERMEDIATE_REPORT_INPUT_KEYS = Object.freeze([
  ...REPORT_IDENTITY_INPUT_KEYS,
  'phaseIndex', 'totalMinutes', 'phaseMinutes', 'lastAcpActivityMinutesAgo',
  'newResultDelta', 'newResult', 'executionState', 'inProgress',
  'verification', 'next', 'issue',
]);
const TERMINAL_REPORT_INPUT_KEYS = Object.freeze([
  ...REPORT_IDENTITY_INPUT_KEYS,
  'elapsed', 'status', 'summary', 'verification', 'result', 'next',
  'externalAction',
]);
const MAX_REPORT_MINUTES = 99999;
export const MAX_REPORT_RESULT_DELTA = 9999;

function validateReportMinutes(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_REPORT_MINUTES) {
    fail('invalid_reporting_report', `${label} must be an integer minute count between 0 and ${MAX_REPORT_MINUTES}`);
  }
  return value;
}

function validateReportBuilderIdentity(input, allowedKeys, label) {
  if (!isPlainObject(input)) {
    fail('invalid_reporting_context', `${label} input must be a plain object`);
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) {
      fail('invalid_reporting_context', `${label} input contains unsupported key "${describeKey(key)}"`);
    }
  }
  const { agent, model, roundIndex, timeKst } = input;
  assertCanonicalAgent(agent, 'input.agent');
  let resolvedModel;
  if (model === undefined) {
    if (agent !== 'claude') {
      fail('invalid_reporting_context', 'input.model is required for this agent and must name the run effective model');
    }
    resolvedModel = ACP_REPORT_RUNTIME_DEFAULT_MODEL_LABEL;
  } else if (!isValidModelString(model)) {
    fail('invalid_reporting_context', 'input.model must be omitted or a non-empty single-line model string');
  } else {
    if (agent !== 'claude' && model === ACP_REPORT_RUNTIME_DEFAULT_MODEL_LABEL) {
      fail('invalid_reporting_context', 'input.model must name the explicit effective model for this agent');
    }
    resolvedModel = model;
  }
  if (!Number.isInteger(roundIndex) || roundIndex < 1 || roundIndex > MAX_ROUND_INDEX) {
    fail('invalid_reporting_round_index', `roundIndex must be a positive integer of at most ${MAX_ROUND_INDEX}`);
  }
  const repository = validateRepository(input.repository);
  const branch = validateBranch(input.branch);
  if (typeof timeKst !== 'string' || !TIME_KST_RE.test(timeKst)) {
    fail('invalid_reporting_report', 'input.timeKst must be a 24-hour HH:MM time');
  }
  return {
    agentLabel: ACP_AGENT_PRESENTATIONS[agent],
    model: resolvedModel,
    roundIndex,
    repository,
    branch,
    timeKst,
  };
}

function validateReportSlot(value, label) {
  if (
    typeof value !== 'string' ||
    !hasVisibleText(value) ||
    SINGLE_LINE_CONTROL_RE.test(value) ||
    value.includes('\n')
  ) {
    fail('invalid_reporting_report', `${label} must be visible single-line text`);
  }
  assertNoForbiddenContent(value, label);
  return value;
}

/**
 * Build and self-validate the canonical intermediate lifecycle report.
 *
 * The ⏱️ time line is derived from three independent structured minute
 * counts: 전체 (total ACP elapsed), 현재 단계 (current phase), and 마지막 ACP
 * 활동 (age of the latest normalized ACP model/tool/status/activity event —
 * the `lastAcpActivityAt` concept, deliberately not the ambiguous
 * `lastAcpStateChangeAt`). The 새 결과 bullet is derived from
 * `newResultDelta`, an owner-owned semantic count the transport cannot
 * infer: it counts material ACP results completed since the previous
 * successfully delivered intermediate report, and the owner advances its
 * result cursor only after a verified delivery receipt — a raw tool
 * completion never counts as a material result. `newResultDelta: 0` requires
 * `newResult` to be omitted and renders the canonical
 * `Δ0 · 새로 확인된 ACP 결과 없음` bullet, while a positive delta requires
 * the free-text result summary and renders `Δ<N> · <newResult>`. Activity
 * age and Δ are independent: `마지막 ACP 활동 0분 전` with `Δ0` is valid.
 */
export function buildAcpIntermediateReport(input) {
  const expected = validateReportBuilderIdentity(
    input,
    INTERMEDIATE_REPORT_INPUT_KEYS,
    'intermediate-report'
  );
  const phaseName = Number.isInteger(input.phaseIndex) &&
    Object.hasOwn(ACP_REPORT_PHASES, input.phaseIndex)
    ? ACP_REPORT_PHASES[input.phaseIndex]
    : undefined;
  if (phaseName === undefined) {
    fail('invalid_reporting_report', 'input.phaseIndex must be a canonical report phase');
  }
  const totalMinutes = validateReportMinutes(input.totalMinutes, 'input.totalMinutes');
  const phaseMinutes = validateReportMinutes(input.phaseMinutes, 'input.phaseMinutes');
  const activityAgeMinutes = validateReportMinutes(
    input.lastAcpActivityMinutesAgo,
    'input.lastAcpActivityMinutesAgo'
  );
  if (phaseMinutes > totalMinutes) {
    fail('invalid_reporting_report', 'input.phaseMinutes must not exceed input.totalMinutes');
  }
  if (activityAgeMinutes > totalMinutes) {
    fail('invalid_reporting_report', 'input.lastAcpActivityMinutesAgo must not exceed input.totalMinutes');
  }
  const delta = input.newResultDelta;
  if (!Number.isInteger(delta) || delta < 0 || delta > MAX_REPORT_RESULT_DELTA) {
    fail('invalid_reporting_report', `input.newResultDelta must be an integer between 0 and ${MAX_REPORT_RESULT_DELTA}`);
  }
  let newResultBullet;
  if (delta === 0) {
    if (input.newResult !== undefined) {
      fail('invalid_reporting_report', 'input.newResult must be omitted when input.newResultDelta is 0');
    }
    newResultBullet = `Δ0 · ${ACP_REPORT_NO_NEW_RESULT}`;
  } else {
    newResultBullet = `Δ${delta} · ${validateReportSlot(input.newResult, 'input.newResult')}`;
  }
  const lines = [
    `🔄 **ACP 중간 보고 · ${expected.timeKst} KST**`,
    '',
    `🤖 **ACP**: ${expected.agentLabel} · \`${expected.model}\``,
    `📍 **작업**: \`${expected.repository}\` · \`${expected.branch}\``,
    `🔢 **라운드**: ${expected.roundIndex} · ${input.phaseIndex}/4 ${phaseName}`,
    `⏱️ **ACP 시간**: 전체 ${totalMinutes}분 · 현재 단계 ${phaseMinutes}분 · 마지막 ACP 활동 ${activityAgeMinutes}분 전`,
    `🔁 **실행 상태**: ${validateReportSlot(input.executionState, 'input.executionState')}`,
    '',
    ACP_REPORT_SECTION_HEADERS[0],
    `- ${newResultBullet}`,
    '',
    ACP_REPORT_SECTION_HEADERS[1],
    `- ${validateReportSlot(input.inProgress, 'input.inProgress')}`,
    '',
    ACP_REPORT_SECTION_HEADERS[2],
    `- ${validateReportSlot(input.verification, 'input.verification')}`,
    '',
    ACP_REPORT_SECTION_HEADERS[3],
    `- ${validateReportSlot(input.next, 'input.next')}`,
  ];
  if (input.issue !== undefined) {
    lines.push('', ACP_REPORT_ISSUE_HEADER, `- ${validateReportSlot(input.issue, 'input.issue')}`);
  }
  const report = lines.join('\n');
  validateMiddleReport(report, expected);
  return report;
}

const TERMINAL_TITLES = Object.freeze({
  completed: '🏁 **ACP 완료 보고',
  cancelled: '⛔ **ACP 취소 보고',
  failed: '❌ **ACP 실패 보고',
});

const TERMINAL_OUTCOME_HEADERS = Object.freeze({
  completed: '✅ **ACP 완료**',
  cancelled: '⛔ **ACP 취소**',
  failed: '❌ **ACP 실패**',
});

function validateTerminalReport(report, expected) {
  if (report.length === 0 || report.length > MAX_DISCORD_MESSAGE_LENGTH || MULTILINE_CONTROL_RE.test(report)) {
    fail('invalid_reporting_report', 'terminal report must be bounded text without control characters');
  }
  const lines = report.split('\n');
  if (lines.length !== 20) {
    fail('invalid_reporting_report', 'terminal report must match the exact 20-line template');
  }
  const exact = [
    [0, `${TERMINAL_TITLES[expected.status]} · ${expected.timeKst} KST**`],
    [1, ''],
    [2, `🤖 **ACP**: ${expected.agentLabel} · \`${expected.model}\``],
    [3, `📍 **작업**: \`${expected.repository}\` · \`${expected.branch}\``],
    [4, `⏱️ **ACP 소요**: ${expected.elapsed} · 라운드 ${expected.roundIndex}`],
    [5, ''],
    [6, TERMINAL_OUTCOME_HEADERS[expected.status]],
    [8, ''],
    [9, '🧪 **ACP 자체 검증**'],
    [11, ''],
    [12, '📦 **결과**'],
    [14, ''],
    [15, '🔍 **다음**'],
    [17, ''],
    [18, '🔒 **외부 작업**'],
  ];
  for (const [index, value] of exact) {
    if (lines[index] !== value) {
      fail('invalid_reporting_report', `terminal report line ${index + 1} does not match the canonical template`);
    }
  }
  for (const index of [7, 10, 13, 16, 19]) {
    if (!isBulletLine(lines[index])) {
      fail('invalid_reporting_report', 'terminal report sections require exactly one visible bullet');
    }
    assertNoForbiddenContent(lines[index], 'terminal report bullet');
  }
}

/** Build and self-validate the canonical terminal lifecycle report. */
export function buildAcpTerminalReport(input) {
  const expected = validateReportBuilderIdentity(
    input,
    TERMINAL_REPORT_INPUT_KEYS,
    'terminal-report'
  );
  if (!ACP_TERMINAL_REPORT_STATUSES.includes(input.status)) {
    fail('invalid_reporting_report', 'input.status must be a canonical terminal status');
  }
  const terminal = {
    ...expected,
    status: input.status,
    elapsed: validateReportSlot(input.elapsed, 'input.elapsed'),
  };
  const report = [
    `${TERMINAL_TITLES[terminal.status]} · ${terminal.timeKst} KST**`,
    '',
    `🤖 **ACP**: ${terminal.agentLabel} · \`${terminal.model}\``,
    `📍 **작업**: \`${terminal.repository}\` · \`${terminal.branch}\``,
    `⏱️ **ACP 소요**: ${terminal.elapsed} · 라운드 ${terminal.roundIndex}`,
    '',
    TERMINAL_OUTCOME_HEADERS[terminal.status],
    `- ${validateReportSlot(input.summary, 'input.summary')}`,
    '',
    '🧪 **ACP 자체 검증**',
    `- ${validateReportSlot(input.verification, 'input.verification')}`,
    '',
    '📦 **결과**',
    `- ${validateReportSlot(input.result, 'input.result')}`,
    '',
    '🔍 **다음**',
    `- ${validateReportSlot(input.next, 'input.next')}`,
    '',
    '🔒 **외부 작업**',
    `- ${validateReportSlot(input.externalAction, 'input.externalAction')}`,
  ].join('\n');
  validateTerminalReport(report, terminal);
  return report;
}

function validateWatchdogMessage(message, expected) {
  if (typeof message !== 'string' || message.length === 0) {
    fail('invalid_reporting_watchdog_message', 'watchdog payload message must be a non-empty string');
  }
  if (message.length > MAX_PAYLOAD_MESSAGE_LENGTH) {
    fail('invalid_reporting_watchdog_message', `watchdog payload message exceeds ${MAX_PAYLOAD_MESSAGE_LENGTH} characters`);
  }
  if (MULTILINE_CONTROL_RE.test(message)) {
    fail('invalid_reporting_watchdog_message', 'watchdog payload message contains carriage returns or control characters');
  }
  if (message.includes('```')) {
    fail('invalid_reporting_watchdog_message', 'watchdog payload message must not contain Markdown fences');
  }
  if (countOccurrences(message, ACP_REPORT_BEGIN_DELIMITER) !== 1) {
    fail('invalid_reporting_watchdog_message', 'watchdog payload message must contain exactly one begin delimiter');
  }
  if (countOccurrences(message, ACP_REPORT_END_DELIMITER) !== 1) {
    fail('invalid_reporting_watchdog_message', 'watchdog payload message must contain exactly one end delimiter');
  }
  const prefix = `${ACP_REPORT_INSTRUCTION}\n\n${ACP_REPORT_BEGIN_DELIMITER}\n`;
  const suffix = `\n${ACP_REPORT_END_DELIMITER}`;
  if (!message.startsWith(prefix)) {
    fail('invalid_reporting_watchdog_message', 'watchdog payload message must start with the minimal instruction, a blank line, and the begin delimiter');
  }
  if (!message.endsWith(suffix)) {
    fail('invalid_reporting_watchdog_message', 'watchdog payload message must end with the end delimiter and no suffix');
  }
  const report = message.slice(prefix.length, message.length - suffix.length);
  // Forbidden-content screening happens inside validateMiddleReport, on the
  // report's free-text slots only: everything outside the report is the fixed
  // instruction/delimiter frame already exact-matched above.
  validateMiddleReport(report, expected);
}

// Validates the watchdog snapshot and returns the validated variable parts
// ({ id, timeoutSeconds, message }) as locals captured at validation time, so
// the caller normalizes exactly what was checked: a getter-backed property
// cannot return one value to the validator and another to the normalizer.
function validateWatchdog(watchdog, expected) {
  if (!isPlainObject(watchdog)) {
    fail('invalid_reporting_watchdog', 'watchdog must be a plain object');
  }
  assertExactKeys(
    watchdog,
    ['id', 'roundIndex', 'enabled', 'sessionTarget', 'schedule', 'delivery', 'deleteAfterRun', 'payload'],
    'invalid_reporting_watchdog',
    'watchdog'
  );
  const { id } = watchdog;
  if (!isReportPumpId(id)) {
    fail('invalid_reporting_watchdog', 'watchdog.id must be 1..200 characters with no whitespace or control characters');
  }
  if (watchdog.roundIndex !== expected.roundIndex) {
    fail('invalid_reporting_watchdog_round', 'watchdog.roundIndex must equal the reporting roundIndex');
  }
  if (watchdog.enabled !== false) {
    fail('invalid_reporting_watchdog', 'watchdog.enabled must be exactly false');
  }
  if (watchdog.sessionTarget !== 'isolated') {
    fail('invalid_reporting_watchdog', 'watchdog.sessionTarget must be exactly "isolated"');
  }
  if (watchdog.deleteAfterRun !== false) {
    fail('invalid_reporting_watchdog', 'watchdog.deleteAfterRun must be exactly false');
  }
  const { schedule } = watchdog;
  if (!isPlainObject(schedule)) {
    fail('invalid_reporting_watchdog_schedule', 'watchdog.schedule must be a plain object');
  }
  assertExactKeys(schedule, ['kind', 'everyMs'], 'invalid_reporting_watchdog_schedule', 'watchdog.schedule');
  if (schedule.kind !== 'every' || schedule.everyMs !== WATCHDOG_EVERY_MS) {
    fail('invalid_reporting_watchdog_schedule', `watchdog.schedule must be exactly { kind: "every", everyMs: ${WATCHDOG_EVERY_MS} }`);
  }
  const { delivery } = watchdog;
  if (!isPlainObject(delivery)) {
    fail('invalid_reporting_watchdog_delivery', 'watchdog.delivery must be a plain object');
  }
  assertExactKeys(delivery, ['mode', 'channel', 'to'], 'invalid_reporting_watchdog_delivery', 'watchdog.delivery');
  if (
    delivery.mode !== 'announce' ||
    delivery.channel !== 'discord' ||
    delivery.to !== `channel:${expected.controlConversationId}`
  ) {
    fail('invalid_reporting_watchdog_delivery', 'watchdog.delivery must announce on Discord to the control conversation channel');
  }
  const { payload } = watchdog;
  if (!isPlainObject(payload)) {
    fail('invalid_reporting_watchdog_payload', 'watchdog.payload must be a plain object');
  }
  assertExactKeys(payload, ['kind', 'toolsAllow', 'timeoutSeconds', 'message'], 'invalid_reporting_watchdog_payload', 'watchdog.payload');
  // Read each untrusted property exactly once into a local before checking it.
  const { kind, toolsAllow, timeoutSeconds, message } = payload;
  if (kind !== 'agentTurn') {
    fail('invalid_reporting_watchdog_payload', 'watchdog.payload.kind must be exactly "agentTurn"');
  }
  if (!Array.isArray(toolsAllow) || toolsAllow.length !== 0) {
    fail('invalid_reporting_watchdog_payload', 'watchdog.payload.toolsAllow must be present and exactly []');
  }
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > MAX_WATCHDOG_TIMEOUT_SECONDS
  ) {
    fail('invalid_reporting_watchdog_payload', `watchdog.payload.timeoutSeconds must be a positive integer of at most ${MAX_WATCHDOG_TIMEOUT_SECONDS}`);
  }
  validateWatchdogMessage(message, expected);
  return { id, timeoutSeconds, message };
}

// Validates the acp-reporting-v3 report-pump attestation and returns the
// validated variable part ({ id }) captured at validation time. The pump
// supersedes the v1/v2 disabled-snapshot watchdog: it is one ENABLED
// ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS polling automation bound to the round
// and control conversation, while the host transport keeps report eligibility
// on its own REPORT_CADENCE_MS (acp-host-transport.mjs).
// It attests only the non-secret structural identity of the deterministic
// script payload — never its token-substituted script or a static report. The
// public report content is machine-derived per claim from current normalized
// evidence at the host transport's closed claim-report action. The attested
// `id` is the exact scheduler job identity the pump must present to
// claim-report; the transport binds it at prepare time and rejects any other
// job.
function validateReportPump(reportPump, expected) {
  if (!isPlainObject(reportPump)) {
    fail('invalid_reporting_report_pump', 'reportPump must be a plain object');
  }
  assertExactKeys(
    reportPump,
    ['id', 'roundIndex', 'enabled', 'sessionTarget', 'schedule', 'payload', 'delivery', 'deleteAfterRun'],
    'invalid_reporting_report_pump',
    'reportPump'
  );
  const { id } = reportPump;
  if (!isReportPumpId(id)) {
    fail('invalid_reporting_report_pump', 'reportPump.id must be 1..200 characters with no whitespace or control characters');
  }
  if (reportPump.roundIndex !== expected.roundIndex) {
    fail('invalid_reporting_report_pump_round', 'reportPump.roundIndex must equal the reporting roundIndex');
  }
  if (reportPump.enabled !== true) {
    fail('invalid_reporting_report_pump', 'reportPump.enabled must be exactly true');
  }
  if (reportPump.sessionTarget !== 'isolated') {
    fail('invalid_reporting_report_pump', 'reportPump.sessionTarget must be exactly "isolated"');
  }
  if (reportPump.deleteAfterRun !== false) {
    fail('invalid_reporting_report_pump', 'reportPump.deleteAfterRun must be exactly false');
  }
  const { schedule } = reportPump;
  if (!isPlainObject(schedule)) {
    fail('invalid_reporting_report_pump_schedule', 'reportPump.schedule must be a plain object');
  }
  assertExactKeys(schedule, ['kind', 'everyMs'], 'invalid_reporting_report_pump_schedule', 'reportPump.schedule');
  if (schedule.kind !== 'every' || schedule.everyMs !== ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS) {
    fail('invalid_reporting_report_pump_schedule', `reportPump.schedule must be exactly { kind: "every", everyMs: ${ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS} }`);
  }
  const { delivery } = reportPump;
  if (!isPlainObject(delivery)) {
    fail('invalid_reporting_report_pump_delivery', 'reportPump.delivery must be a plain object');
  }
  assertExactKeys(delivery, ['mode'], 'invalid_reporting_report_pump_delivery', 'reportPump.delivery');
  if (delivery.mode !== 'none') {
    fail('invalid_reporting_report_pump_delivery', 'reportPump.delivery.mode must be exactly "none"');
  }
  const { payload } = reportPump;
  if (!isPlainObject(payload)) {
    fail('invalid_reporting_report_pump_payload', 'reportPump.payload must be a plain object');
  }
  assertExactKeys(
    payload,
    ['kind', 'scriptVersion', 'scriptSha256', 'timeoutSeconds', 'toolBudget', 'toolsAllow'],
    'invalid_reporting_report_pump_payload',
    'reportPump.payload'
  );
  const { kind, scriptVersion, scriptSha256, timeoutSeconds, toolBudget, toolsAllow } = payload;
  if (
    kind !== 'script' ||
    scriptVersion !== ACP_REPORT_CONTROLLER_SCRIPT_VERSION ||
    scriptSha256 !== ACP_REPORT_CONTROLLER_SCRIPT_SHA256 ||
    timeoutSeconds !== ACP_REPORT_CONTROLLER_TIMEOUT_SECONDS ||
    toolBudget !== ACP_REPORT_CONTROLLER_TOOL_BUDGET ||
    !Array.isArray(toolsAllow) ||
    toolsAllow.length !== ACP_REPORT_CONTROLLER_TOOLS_ALLOW.length ||
    toolsAllow.some((tool, index) => tool !== ACP_REPORT_CONTROLLER_TOOLS_ALLOW[index])
  ) {
    fail('invalid_reporting_report_pump_payload', 'reportPump.payload must match the deterministic controller script attestation');
  }
  return { id };
}

// Attestation redundancy in this schema is intentional, not derivable:
// startReceipt.{conversationId,messageId,deliveredAt} re-state the lifecycle
// receipt, startReceipt.message re-states startMessage, watchdog.roundIndex
// re-states roundIndex, and the three destinations re-state the control
// conversation. Each field attests an independently prepared artifact or
// route (the message actually delivered, the watchdog actually registered,
// the routes actually configured), and the validator's equality checks are
// the point: deriving these fields would turn "prove the artifacts agree"
// into "assume they agree". Keep them explicit.
const TOP_LEVEL_KEYS_V1 = Object.freeze([
  'schemaVersion',
  'roundIndex',
  'repository',
  'branch',
  'startMessage',
  'startDestination',
  'watchdogDestination',
  'terminalDestination',
  'startReceipt',
  'watchdog',
]);
// acp-reporting-v2 is the v1 shape plus a mandatory top-level `agent`
// attestation: the caller states which canonical agent presentation the
// templates were prepared for, and the validator proves it equals the
// canonical config agent bound through the context. A v1 bundle carrying
// `agent` is rejected as an unknown key, keeping v1 byte-compatible with
// the pre-migration Claude bundles.
const TOP_LEVEL_KEYS_V2 = Object.freeze(['agent', ...TOP_LEVEL_KEYS_V1]);
// acp-reporting-v3 supersedes the disabled-snapshot watchdog with the enabled
// report-pump attestation: `watchdog` and `watchdogDestination` are replaced
// by `reportPump` and `pumpDestination`. Everything else is the v2 shape,
// agent attestation included. v3 carries only a non-secret script-template
// attestation and no lease token, executable script, or static report.
const TOP_LEVEL_KEYS_V3 = Object.freeze([
  'agent',
  'schemaVersion',
  'roundIndex',
  'repository',
  'branch',
  'startMessage',
  'startDestination',
  'pumpDestination',
  'terminalDestination',
  'startReceipt',
  'reportPump',
]);

/**
 * Validate a reporting bundle against the ACP reporting contract.
 *
 * The current schema is acp-reporting-v3, whose enabled `reportPump`
 * attestation supersedes the v1/v2 disabled-snapshot `watchdog`: the pump
 * carries no static report payload or lease token, because report content is
 * machine-derived per claim at the host transport. acp-reporting-v2 remains accepted for
 * already-prepared configs, and the legacy acp-reporting-v1 shape is accepted
 * only when the bound canonical agent is `claude`, as a bounded migration
 * path; every v2/v3 bundle's top-level `agent` must equal the canonical
 * config agent.
 *
 * Every untrusted property is read exactly once into a local before it is
 * checked, and the normalized copy is built only from those validated locals
 * and from contract constants — never by re-reading the input. A hostile
 * getter therefore cannot pass validation with one value and place another in
 * the normalized output.
 *
 * @param {unknown} reporting — the untrusted reporting bundle
 * @param {{ agent: string, model?: string, controlConversationId: string,
 *           lifecycleStartReceipt: { conversationId: string, messageId: string, deliveredAt: string } }} context
 *   — `agent` must be a canonical key of ACP_AGENT_PRESENTATIONS; `model` may
 *   be omitted; the templates must then use the literal `runtime-default`
 *   label on the ACP identity lines
 * @returns {object} a deep-frozen normalized copy of the validated bundle
 * @throws {AcpReportingContractError} with a stable `invalid_reporting_*` code
 */
export function validateAcpReportingContract(reporting, context) {
  const ctx = validateContext(context);
  // The public harness label is derived only from the closed mapping and the
  // canonical context agent — never from any value inside the bundle.
  const agentLabel = ACP_AGENT_PRESENTATIONS[ctx.agent];
  if (!isPlainObject(reporting)) {
    fail('invalid_reporting_root', 'reporting must be a plain object');
  }
  const { schemaVersion } = reporting;
  if (!ACP_REPORTING_SCHEMA_VERSIONS.includes(schemaVersion)) {
    fail('invalid_reporting_schema_version', `schemaVersion must be "${ACP_REPORTING_SCHEMA_VERSION_V3}" (or "${ACP_REPORTING_SCHEMA_VERSION_V2}", or "${ACP_REPORTING_SCHEMA_VERSION_V1}" during the bounded Claude migration)`);
  }
  if (
    schemaVersion === ACP_REPORTING_SCHEMA_VERSION_V1 &&
    ctx.agent !== ACP_REPORTING_V1_COMPAT_AGENT
  ) {
    fail('invalid_reporting_schema_version', `schemaVersion "${ACP_REPORTING_SCHEMA_VERSION_V1}" is only accepted for the canonical "${ACP_REPORTING_V1_COMPAT_AGENT}" agent during migration`);
  }
  const topLevelKeys = schemaVersion === ACP_REPORTING_SCHEMA_VERSION_V3
    ? TOP_LEVEL_KEYS_V3
    : schemaVersion === ACP_REPORTING_SCHEMA_VERSION_V2
      ? TOP_LEVEL_KEYS_V2
      : TOP_LEVEL_KEYS_V1;
  for (const key of Object.keys(reporting)) {
    if (!topLevelKeys.includes(key)) {
      fail('invalid_reporting_unknown_key', `reporting contains unsupported key "${describeKey(key)}"`);
    }
  }
  if (
    schemaVersion !== ACP_REPORTING_SCHEMA_VERSION_V1 &&
    reporting.agent !== ctx.agent
  ) {
    fail('invalid_reporting_agent', 'reporting.agent must equal the canonical config agent');
  }
  const { roundIndex, startMessage } = reporting;
  if (!Number.isInteger(roundIndex) || roundIndex < 1 || roundIndex > MAX_ROUND_INDEX) {
    fail('invalid_reporting_round_index', `roundIndex must be a positive integer of at most ${MAX_ROUND_INDEX}`);
  }
  const repository = validateRepository(reporting.repository);
  const branch = validateBranch(reporting.branch);
  const expected = {
    roundIndex,
    repository,
    branch,
    agentLabel,
    model: ctx.model,
    controlConversationId: ctx.controlConversationId,
  };
  validateStartMessage(startMessage, expected);
  const destinationKeys = schemaVersion === ACP_REPORTING_SCHEMA_VERSION_V3
    ? ['startDestination', 'pumpDestination', 'terminalDestination']
    : ['startDestination', 'watchdogDestination', 'terminalDestination'];
  for (const key of destinationKeys) {
    if (reporting[key] !== ctx.controlConversationId) {
      fail('invalid_reporting_destination', `${key} must be exactly the control conversation id`);
    }
  }
  const receipt = reporting.startReceipt;
  if (!isPlainObject(receipt)) {
    fail('invalid_reporting_start_receipt', 'startReceipt must be a plain object');
  }
  assertExactKeys(receipt, ['conversationId', 'messageId', 'deliveredAt', 'message'], 'invalid_reporting_start_receipt', 'startReceipt');
  const lifecycle = ctx.lifecycleStartReceipt;
  if (receipt.conversationId !== lifecycle.conversationId) {
    fail('invalid_reporting_start_receipt', 'startReceipt.conversationId does not match the lifecycle receipt');
  }
  if (receipt.messageId !== lifecycle.messageId) {
    fail('invalid_reporting_start_receipt', 'startReceipt.messageId does not match the lifecycle receipt');
  }
  if (receipt.deliveredAt !== lifecycle.deliveredAt) {
    fail('invalid_reporting_start_receipt', 'startReceipt.deliveredAt does not match the lifecycle receipt');
  }
  if (receipt.message !== startMessage) {
    fail('invalid_reporting_start_receipt', 'startReceipt.message does not match startMessage');
  }
  if (schemaVersion === ACP_REPORTING_SCHEMA_VERSION_V3) {
    const reportPump = validateReportPump(reporting.reportPump, expected);
    return deepFreeze({
      schemaVersion,
      agent: ctx.agent,
      roundIndex,
      repository,
      branch,
      startMessage,
      startDestination: ctx.controlConversationId,
      pumpDestination: ctx.controlConversationId,
      terminalDestination: ctx.controlConversationId,
      startReceipt: {
        conversationId: lifecycle.conversationId,
        messageId: lifecycle.messageId,
        deliveredAt: lifecycle.deliveredAt,
        message: startMessage,
      },
      reportPump: {
        id: reportPump.id,
        roundIndex,
        enabled: true,
        sessionTarget: 'isolated',
        schedule: { kind: 'every', everyMs: ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS },
        payload: {
          kind: 'script',
          scriptVersion: ACP_REPORT_CONTROLLER_SCRIPT_VERSION,
          scriptSha256: ACP_REPORT_CONTROLLER_SCRIPT_SHA256,
          timeoutSeconds: ACP_REPORT_CONTROLLER_TIMEOUT_SECONDS,
          toolBudget: ACP_REPORT_CONTROLLER_TOOL_BUDGET,
          toolsAllow: [...ACP_REPORT_CONTROLLER_TOOLS_ALLOW],
        },
        delivery: { mode: 'none' },
        deleteAfterRun: false,
      },
    });
  }
  const watchdog = validateWatchdog(reporting.watchdog, expected);
  return deepFreeze({
    schemaVersion,
    ...(schemaVersion === ACP_REPORTING_SCHEMA_VERSION_V2 ? { agent: ctx.agent } : {}),
    roundIndex,
    repository,
    branch,
    startMessage,
    startDestination: ctx.controlConversationId,
    watchdogDestination: ctx.controlConversationId,
    terminalDestination: ctx.controlConversationId,
    startReceipt: {
      conversationId: lifecycle.conversationId,
      messageId: lifecycle.messageId,
      deliveredAt: lifecycle.deliveredAt,
      message: startMessage,
    },
    watchdog: {
      id: watchdog.id,
      roundIndex,
      enabled: false,
      sessionTarget: 'isolated',
      schedule: { kind: 'every', everyMs: WATCHDOG_EVERY_MS },
      delivery: { mode: 'announce', channel: 'discord', to: `channel:${ctx.controlConversationId}` },
      deleteAfterRun: false,
      payload: {
        kind: 'agentTurn',
        toolsAllow: [],
        timeoutSeconds: watchdog.timeoutSeconds,
        message: watchdog.message,
      },
    },
  });
}
