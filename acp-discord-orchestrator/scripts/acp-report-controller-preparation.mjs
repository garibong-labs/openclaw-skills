// Private preparation helpers for one durable ACP report-controller lease.
//
// The public template contains literal LEASE_TOKEN and JOB_ID placeholders.
// The model-callable `automations` boundary routes `action:"add"` to the public
// Gateway `cron.add`, whose closed parameter schema has no `id` field, so a
// caller cannot reserve a scheduler id. Preparation therefore runs a two-stage
// sequence: `buildReportControllerPlaceholderAddCall` creates exactly one
// DISABLED inert automation carrying a unique `declarationKey` and no private
// data, and `buildReportControllerArmUpdateCall` then substitutes the private
// lease token plus the scheduler-returned exact job id and enables the job in
// one `action:"update"` call. There is never an enabled placeholder or
// enabled wrong-script window. That update answers with the complete persisted
// job, and preparation attests the whole final controller contract off it before
// anything is bound, started, prepared, registered, or activated. Neither the
// token nor the substituted script is returned by runReportControllerPreparation
// or placed in the public supervisor reporting bundle.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACP_REPORT_CONTROLLER_SCRIPT_SHA256,
  ACP_REPORT_CONTROLLER_SCRIPT_VERSION,
  ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS,
  ACP_REPORT_CONTROLLER_TIMEOUT_SECONDS,
  ACP_REPORT_CONTROLLER_TOOL_BUDGET,
  ACP_REPORT_CONTROLLER_TOOLS_ALLOW,
} from "./acp-reporting-contract.mjs";
import { abortHostTransportPreactivation } from "./acp-host-transport.mjs";
import { hasExactKeys, isPlainObject } from "./acp-private-json-input.mjs";

export const REPORT_CONTROLLER_AUTOMATION_TEMPLATE = fileURLToPath(
  new URL("../templates/report-controller-automation.json", import.meta.url),
);

// Inert body of the disabled placeholder job. It carries no lease token, no job
// identity, and no tool call, so a placeholder that is never armed — or one left
// behind by a permanently unresolved create — can only ever be a disabled no-op.
export const REPORT_CONTROLLER_PLACEHOLDER_SCRIPT =
  "// ACP report controller placeholder: created disabled and not yet armed.\nreturn;";

// One replay of the identical declarationKey add converges on the exact job the
// first attempt may have created; a second unresolved response fails closed.
const MAX_CREATE_ATTEMPTS = 2;
// Registration has the same lost-response ambiguity as creation, but the
// merged controller plugin makes only an exact replay idempotent. The first
// unresolved answer therefore gets one identical replay; no third attempt is
// made inside one preparation run.
const MAX_REGISTRATION_ATTEMPTS = 2;

// The exact final controller contract. Every one of these is proven against the
// persisted job the scheduler returns; none is inferred from the request.
const CONTROLLER_JOB_NAME = "ACP report controller";
const CONTROLLER_SESSION_TARGET = "isolated";
const CONTROLLER_SCHEDULE_KIND = "every";
const CONTROLLER_DELIVERY_MODE = "none";
const CONTROLLER_PAYLOAD_KIND = "script";
const CONTROLLER_PAYLOAD_KEYS = ["kind", "script", "timeoutSeconds", "toolBudget", "toolsAllow"];
// `anchorMs` is the scheduler-owned phase anchor stamped onto every `every`
// schedule at create time. It shifts only when the fixed 60000-ms period starts,
// never what the job runs, which tools it may call, or where output is routed, so
// it is the one dynamic key accepted inside the attested schedule.
const CONTROLLER_SCHEDULE_DYNAMIC_KEYS = ["anchorMs"];
// Fields the intended controller job never carries and that would change what
// runs (`trigger` script), when it runs (`pacing`), or where output goes
// (`sessionKey`, `failureAlert`). Present in any form, the arm is unproven.
const FORBIDDEN_ARMED_JOB_KEYS = ["trigger", "pacing", "sessionKey", "failureAlert"];

const LEASE_TOKEN_PLACEHOLDER = "LEASE_TOKEN";
const JOB_ID_PLACEHOLDER = "JOB_ID";
const SAFE_LEASE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/u;
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_DECLARATION_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{15,199}$/u;
const SAFE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u;
const DECIMAL_ID = /^[0-9]{1,30}$/u;
// The model-callable add boundary forwards the whole job object to the closed
// `cron.add` schema, which rejects any unknown key. A reserved identity is not
// reachable there, so neither spelling may ever reappear on an add job.
const FORBIDDEN_ADD_JOB_KEYS = ["id", "jobId"];

export class AcpReportControllerPreparationError extends Error {
  constructor(code) {
    super(code);
    this.name = "AcpReportControllerPreparationError";
    this.code = code;
  }
}

function fail(code) {
  throw new AcpReportControllerPreparationError(code);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function generateReportControllerLeaseToken(randomBytes = crypto.randomBytes) {
  const token = `acplease${randomBytes(32).toString("base64url")}`;
  if (!SAFE_LEASE_TOKEN.test(token)) fail("report_controller_lease_token_invalid");
  return token;
}

// The declaration key is the only caller-chosen identity on the add boundary.
// It is unique per preparation, carries no private data, and makes one exact
// replay of the same add converge on the same job instead of creating a second.
export function generateReportControllerDeclarationKey(randomUUID = crypto.randomUUID) {
  const declarationKey = `acp-report-controller-${randomUUID()}`;
  if (!SAFE_DECLARATION_KEY.test(declarationKey)) fail("report_controller_declaration_key_invalid");
  return declarationKey;
}

export function loadReportControllerAutomationTemplate(fileSystem = fs) {
  let template;
  try {
    template = JSON.parse(fileSystem.readFileSync(REPORT_CONTROLLER_AUTOMATION_TEMPLATE, "utf8"));
  } catch {
    fail("report_controller_automation_template_invalid");
  }
  if (!hasExactKeys(template, ["name", "sessionTarget", "schedule", "payload", "delivery", "enabled", "deleteAfterRun"]) ||
      template.name !== CONTROLLER_JOB_NAME || template.sessionTarget !== CONTROLLER_SESSION_TARGET ||
      template.enabled !== true || template.deleteAfterRun !== false ||
      !hasExactKeys(template.schedule, ["kind", "everyMs"]) ||
      template.schedule.kind !== CONTROLLER_SCHEDULE_KIND ||
      template.schedule.everyMs !== ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS ||
      !hasExactKeys(template.delivery, ["mode"]) || template.delivery.mode !== CONTROLLER_DELIVERY_MODE ||
      !hasExactKeys(template.payload, CONTROLLER_PAYLOAD_KEYS) ||
      template.payload.kind !== CONTROLLER_PAYLOAD_KIND ||
      template.payload.timeoutSeconds !== ACP_REPORT_CONTROLLER_TIMEOUT_SECONDS ||
      template.payload.toolBudget !== ACP_REPORT_CONTROLLER_TOOL_BUDGET ||
      !Array.isArray(template.payload.toolsAllow) ||
      template.payload.toolsAllow.length !== ACP_REPORT_CONTROLLER_TOOLS_ALLOW.length ||
      template.payload.toolsAllow.some((tool, index) => tool !== ACP_REPORT_CONTROLLER_TOOLS_ALLOW[index]) ||
      typeof template.payload.script !== "string" ||
      template.payload.script.split(LEASE_TOKEN_PLACEHOLDER).length !== 2 ||
      template.payload.script.split(JOB_ID_PLACEHOLDER).length !== 2 ||
      crypto.createHash("sha256").update(template.payload.script, "utf8").digest("hex") !==
        ACP_REPORT_CONTROLLER_SCRIPT_SHA256) {
    fail("report_controller_automation_template_invalid");
  }
  return clone(template);
}

// Stage one: one DISABLED inert job. No lease token, no job identity, and — as
// the closed `cron.add` schema requires — no reserved `id`/`jobId` key.
export function buildReportControllerPlaceholderAddCall(declarationKey, options = {}) {
  if (!SAFE_DECLARATION_KEY.test(declarationKey)) fail("report_controller_declaration_key_invalid");
  const template = loadReportControllerAutomationTemplate(options.fileSystem);
  const job = {
    name: template.name,
    declarationKey,
    sessionTarget: template.sessionTarget,
    schedule: template.schedule,
    payload: { ...template.payload, script: REPORT_CONTROLLER_PLACEHOLDER_SCRIPT },
    delivery: template.delivery,
    enabled: false,
    deleteAfterRun: template.deleteAfterRun,
  };
  if (FORBIDDEN_ADD_JOB_KEYS.some((key) => Object.hasOwn(job, key)) ||
      job.payload.script.includes(LEASE_TOKEN_PLACEHOLDER) ||
      job.payload.script.includes(JOB_ID_PLACEHOLDER)) {
    fail("report_controller_job_create_invalid");
  }
  return { action: "add", job };
}

// Stage two: substitute the private token and the scheduler-returned exact job
// id into the pinned public script and enable the job in the same single call.
export function buildReportControllerArmUpdateCall(jobId, leaseToken, options = {}) {
  if (!SAFE_JOB_ID.test(jobId)) fail("report_controller_job_id_invalid");
  if (!SAFE_LEASE_TOKEN.test(leaseToken)) fail("report_controller_lease_token_invalid");
  const template = loadReportControllerAutomationTemplate(options.fileSystem);
  const script = template.payload.script
    .replace(`"${JOB_ID_PLACEHOLDER}"`, JSON.stringify(jobId))
    .replace(`"${LEASE_TOKEN_PLACEHOLDER}"`, JSON.stringify(leaseToken));
  if (script.includes(LEASE_TOKEN_PLACEHOLDER) || script.includes(JOB_ID_PLACEHOLDER) ||
      !script.includes(JSON.stringify(jobId)) || !script.includes(JSON.stringify(leaseToken))) {
    fail("report_controller_automation_template_invalid");
  }
  return {
    action: "update",
    id: jobId,
    job: {
      payload: {
        kind: template.payload.kind,
        script,
        timeoutSeconds: template.payload.timeoutSeconds,
        toolBudget: template.payload.toolBudget,
        toolsAllow: [...template.payload.toolsAllow],
      },
      enabled: true,
    },
  };
}

export function buildReportPumpStructuralAttestation(jobId, roundIndex) {
  if (!SAFE_JOB_ID.test(jobId)) fail("report_controller_job_id_invalid");
  if (!Number.isInteger(roundIndex) || roundIndex < 1 || roundIndex > 1000) {
    fail("report_controller_round_invalid");
  }
  return {
    id: jobId,
    roundIndex,
    enabled: true,
    sessionTarget: "isolated",
    schedule: { kind: "every", everyMs: ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS },
    payload: {
      kind: "script",
      scriptVersion: ACP_REPORT_CONTROLLER_SCRIPT_VERSION,
      scriptSha256: ACP_REPORT_CONTROLLER_SCRIPT_SHA256,
      timeoutSeconds: ACP_REPORT_CONTROLLER_TIMEOUT_SECONDS,
      toolBudget: ACP_REPORT_CONTROLLER_TOOL_BUDGET,
      toolsAllow: [...ACP_REPORT_CONTROLLER_TOOLS_ALLOW],
    },
    delivery: { mode: "none" },
    deleteAfterRun: false,
  };
}

// The scheduler answers `add` with either the canonical job or the
// declaration-key convergence envelope `{ created, updated?, job }`; the tool
// layer may wrap either in `details`. Only a job whose declarationKey is
// exactly ours proves which scheduler job this preparation owns.
function readAutomationJob(result) {
  const outer = isPlainObject(result?.details) ? result.details : result;
  if (!isPlainObject(outer)) return undefined;
  const job = isPlainObject(outer.job) ? outer.job : outer;
  return isPlainObject(job) ? job : undefined;
}

function readCreatedControllerJob(result, declarationKey) {
  const job = readAutomationJob(result);
  if (job === undefined || typeof job.id !== "string" || !SAFE_JOB_ID.test(job.id) ||
      job.declarationKey !== declarationKey) {
    return undefined;
  }
  return { id: job.id, enabled: job.enabled };
}

async function createControllerPlaceholderJob(addCall, declarationKey, dependencies) {
  for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt += 1) {
    let created;
    try {
      created = await dependencies.createAutomation(clone(addCall));
    } catch {
      continue;
    }
    const job = readCreatedControllerJob(created, declarationKey);
    if (job !== undefined) return job;
  }
  // The add may or may not have created a disabled inert job, and no exact id
  // was ever proven. Never invent one, never enable anything, fail closed.
  fail("report_controller_job_create_unresolved");
}

// The stored allowlist is attested as an exact finite SET, not as an ordered
// list. Installed OpenClaw 2026.8.1 does not persist the requested order:
// `capCronJobToolsAllow` rewrites a finite requested allowlist as
// `creatorToolsAllow.filter(matches).map((tool) => tool.name)`, so the stored
// array comes back in the creator's final executable tool-surface order — core
// `automations` is built before core `message`, and plugin tools are appended
// after both — no matter what order the arm request asked for. Position carries
// no authority there; the authority a stored allowlist grants is exactly which
// tool names it contains. So every permutation of the three intended names is
// the same safe authority and is accepted, while a missing, extra, duplicated,
// non-string, wildcard, or `group:`-prefixed entry is a different authority and
// still fails closed. This set is unrelated to the public template and the
// public structural attestation, which both stay in their pinned order.
const CONTROLLER_TOOLS_ALLOW_SET = new Set(ACP_REPORT_CONTROLLER_TOOLS_ALLOW);

function isExactControllerToolsAllow(toolsAllow) {
  if (!Array.isArray(toolsAllow) || toolsAllow.length !== CONTROLLER_TOOLS_ALLOW_SET.size) return false;
  const seen = new Set();
  for (const tool of toolsAllow) {
    if (typeof tool !== "string" || !CONTROLLER_TOOLS_ALLOW_SET.has(tool) || seen.has(tool)) return false;
    seen.add(tool);
  }
  return true;
}

// Installed OpenClaw 2026.8.1 answers the model-callable `automations`
// `action:"update"` with the complete persisted job read view (the Gateway
// `cron.update` handler responds with `cronJobReadView(job)`), so the update
// result itself proves the stored final job and no extra read-back call is
// needed or made. Nothing here is inferred from the request or from
// "unchanged" fields: the whole script-only controller contract — identity,
// declaration key, name, session target, schedule, delivery, one-shot flag, and
// the exact substituted script payload with its timeout, tool budget, and
// exact allowlist set — is re-read off the returned job. Anything missing,
// altered, reshaped toward model/agentTurn/static-report execution, or carrying
// a run/routing-altering field fails closed before reporting is ever bound.
function assertArmedControllerJob(result, jobId, declarationKey, expectedScript) {
  const job = readAutomationJob(result);
  if (job === undefined ||
      job.id !== jobId || job.declarationKey !== declarationKey ||
      job.enabled !== true || job.name !== CONTROLLER_JOB_NAME ||
      job.sessionTarget !== CONTROLLER_SESSION_TARGET || job.deleteAfterRun !== false ||
      FORBIDDEN_ARMED_JOB_KEYS.some((key) => job[key] !== undefined) ||
      !hasExactKeys(job.schedule, ["kind", "everyMs"], CONTROLLER_SCHEDULE_DYNAMIC_KEYS) ||
      job.schedule.kind !== CONTROLLER_SCHEDULE_KIND ||
      job.schedule.everyMs !== ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS ||
      !hasExactKeys(job.delivery, ["mode"]) || job.delivery.mode !== CONTROLLER_DELIVERY_MODE ||
      !hasExactKeys(job.payload, CONTROLLER_PAYLOAD_KEYS) ||
      job.payload.kind !== CONTROLLER_PAYLOAD_KIND ||
      job.payload.script !== expectedScript ||
      job.payload.timeoutSeconds !== ACP_REPORT_CONTROLLER_TIMEOUT_SECONDS ||
      job.payload.toolBudget !== ACP_REPORT_CONTROLLER_TOOL_BUDGET ||
      !isExactControllerToolsAllow(job.payload.toolsAllow)) {
    fail("report_controller_job_arm_invalid");
  }
}

function assertPrepared(prepared) {
  if (!isPlainObject(prepared) || typeof prepared.transportFile !== "string" ||
      prepared.transportFile.length === 0 || typeof prepared.processHandle !== "string" ||
      prepared.processHandle.length === 0) {
    fail("report_controller_transport_prepare_invalid");
  }
}

function resultStatus(result) {
  return isPlainObject(result?.details) ? result.details.status : result?.status;
}

const REMOVED_STATUS = "removed";

// Read the removal signal carried by one envelope level. `undefined` means that
// level says nothing about removal; `false` means it actively denies it and can
// never be overridden by the other level.
function readRemovalSignal(level) {
  const signals = [];
  if (Object.hasOwn(level, "removed")) signals.push(level.removed === true);
  if (Object.hasOwn(level, "status")) signals.push(level.status === REMOVED_STATUS);
  // Error/failure evidence cannot coexist with successful removal. A success
  // field is only a consistency attestation: true is neutral and any other
  // value denies proof; it cannot prove removal without removed/status.
  if (Object.hasOwn(level, "error")) signals.push(false);
  if (Object.hasOwn(level, "failure")) signals.push(false);
  if (Object.hasOwn(level, "success") && level.success !== true) signals.push(false);
  if (signals.length === 0) return undefined;
  return signals.every((signal) => signal === true);
}

// One strict bounded parser for every removal answer this boundary really
// returns. Installed OpenClaw 2026.8.1 routes the model-callable `automations`
// `action:"remove"` to Gateway `cron.remove`, which responds with the cron
// store's own `{ removed: true }` result and whose tool layer then wraps that
// payload with `jsonResult(...)` — so the model-visible envelope is
// `{ content: [...], details: { removed: true } }` and carries no top-level
// `removed` at all. A direct host capability may instead hand back the
// unwrapped `{ removed: true }` or the `status:"removed"` form. Removal is
// proven only by a strict boolean `true` or the exact string "removed", at the
// top level or inside a plain-object `details`. A truthy string, an absent or
// non-boolean `removed`, an unrelated status, a non-object `details`, an empty
// envelope, or two levels that contradict each other all read as unproven, and
// the caller then fails closed without aborting or releasing anything.
function isProvenRemoval(result) {
  if (!isPlainObject(result)) return false;
  if (Object.hasOwn(result, "details") && !isPlainObject(result.details)) return false;
  const signals = [readRemovalSignal(result)];
  if (isPlainObject(result.details)) signals.push(readRemovalSignal(result.details));
  const stated = signals.filter((signal) => signal !== undefined);
  return stated.length > 0 && stated.every((signal) => signal === true);
}

export function buildReportControllerRegistration(input, leaseToken, jobId, prepared) {
  const registration = {
    action: "register",
    leaseToken,
    transportFile: prepared.transportFile,
    processHandle: prepared.processHandle,
    jobId,
    destination: clone(input.destination),
    reportPumpEntry: input.reportPumpEntry,
    hostTransportEntry: input.hostTransportEntry,
    ...(input.snapshotFile === undefined ? {} : { snapshotFile: input.snapshotFile }),
  };
  const paths = [registration.transportFile, registration.reportPumpEntry,
    registration.hostTransportEntry,
    ...(registration.snapshotFile === undefined ? [] : [registration.snapshotFile])];
  if (!SAFE_LEASE_TOKEN.test(leaseToken) || !SAFE_JOB_ID.test(jobId) ||
      !SAFE_HANDLE.test(registration.processHandle) ||
      paths.some((candidate) => typeof candidate !== "string" || !path.isAbsolute(candidate)) ||
      !isPlainObject(registration.destination) || registration.destination.channel !== "discord" ||
      !SAFE_ACCOUNT.test(registration.destination.accountId) ||
      !DECIMAL_ID.test(registration.destination.conversationId)) {
    fail("report_controller_registration_invalid");
  }
  return registration;
}

// These are the merged plugin's bounded registration failures that occur
// before a new lease can be durably persisted. Only an exact structured error
// carrying one of these codes proves non-persistence and permits the existing
// remove-before-abort rollback. A throw, missing/malformed response, generic
// `controller.failed`, or any unknown code is uncertain.
const PROVEN_REGISTRATION_REJECTION_CODES = new Set([
  "acp_lifecycle_guard.controller.caller_invalid",
  "acp_lifecycle_guard.controller.input_invalid",
  "acp_lifecycle_guard.controller.token_invalid",
  "acp_lifecycle_guard.controller.identity_invalid",
  "acp_lifecycle_guard.controller.posix_required",
  "acp_lifecycle_guard.controller.path_invalid",
  "acp_lifecycle_guard.controller.path_unavailable",
  "acp_lifecycle_guard.controller.path_unsafe",
  "acp_lifecycle_guard.controller.permissions_invalid",
  "acp_lifecycle_guard.controller.trust_entry_invalid",
  "acp_lifecycle_guard.controller.file_too_large",
  "acp_lifecycle_guard.controller.trust_scope_mismatch",
  "acp_lifecycle_guard.controller.destination_invalid",
  "acp_lifecycle_guard.controller.duplicate",
  "acp_lifecycle_guard.controller.prepared_recovery_required",
  "acp_lifecycle_guard.controller.registry_full",
]);

function exactControllerResult(result) {
  if (!isPlainObject(result)) return undefined;
  if (Object.hasOwn(result, "details")) {
    if (!hasExactKeys(result, ["details"], ["content"]) || !isPlainObject(result.details)) {
      return undefined;
    }
    return result.details;
  }
  return result;
}

function isExactPreparedRegistration(result) {
  const structured = exactControllerResult(result);
  return isPlainObject(structured) && hasExactKeys(structured, ["status"]) &&
    structured.status === "prepared";
}

function isProvenRegistrationRejection(result) {
  const structured = exactControllerResult(result);
  return isPlainObject(structured) && hasExactKeys(structured, ["status", "code"]) &&
    structured.status === "error" &&
    PROVEN_REGISTRATION_REJECTION_CODES.has(structured.code);
}

async function registerControllerWithReplay(registration, dependencies) {
  for (let attempt = 1; attempt <= MAX_REGISTRATION_ATTEMPTS; attempt += 1) {
    let result;
    try {
      // Clone from the one immutable logical input on every attempt. A tool
      // implementation cannot mutate the object used by the bounded replay.
      result = await dependencies.registerController(clone(registration));
    } catch {
      continue;
    }
    if (isExactPreparedRegistration(result)) return "prepared";
    if (attempt === 1 && isProvenRegistrationRejection(result)) return "rejected";
  }
  return "unresolved";
}

async function rollbackBeforeActivation(jobId, leaseToken, prepared, registrationConfirmed, dependencies) {
  if (jobId !== undefined) {
    try {
      if (!isProvenRemoval(await dependencies.removeAutomation({ action: "remove", jobId }))) {
        fail("report_controller_pre_activation_cleanup_failed");
      }
    } catch {
      fail("report_controller_pre_activation_cleanup_failed");
    }
  }
  if (prepared !== undefined) {
    try {
      const aborted = registrationConfirmed
        ? await dependencies.abortController({ action: "abort_preactivation", leaseToken })
        : await (dependencies.abortTransport ?? abortHostTransportPreactivation)({
            transportFile: prepared.transportFile,
            processHandle: prepared.processHandle,
          });
      const abortedStatus = registrationConfirmed ? resultStatus(aborted) :
        aborted?.type === "host_transport_preactivation_aborted" ? "aborted" : undefined;
      if (abortedStatus !== "aborted") {
        fail("report_controller_pre_activation_cleanup_failed");
      }
    } catch {
      fail("report_controller_pre_activation_cleanup_failed");
    }
  }
}

function commitRecoveryState(leaseToken, jobId, prepared) {
  return {
    schemaVersion: "acp-report-controller-recovery.v1",
    type: "commit_activation_pending",
    leaseToken,
    jobId,
    transportFile: prepared.transportFile,
    processHandle: prepared.processHandle,
  };
}

function registrationRecoveryState(registration) {
  return {
    schemaVersion: "acp-report-controller-recovery.v1",
    type: "registration_pending",
    registration: clone(registration),
  };
}

async function retainCommitRecovery(dependencies, recovery) {
  const retained = await dependencies.retainRecovery(recovery);
  if (retained?.retained !== true && resultStatus(retained) !== "retained") {
    fail("report_controller_commit_recovery_failed");
  }
}

export async function retryReportControllerActivationCommit(recovery, dependencies) {
  if (!hasExactKeys(recovery, ["schemaVersion", "type", "leaseToken", "jobId", "transportFile", "processHandle"]) ||
      recovery.schemaVersion !== "acp-report-controller-recovery.v1" ||
      recovery.type !== "commit_activation_pending" ||
      !SAFE_LEASE_TOKEN.test(recovery.leaseToken) || !SAFE_JOB_ID.test(recovery.jobId) ||
      !path.isAbsolute(recovery.transportFile) || !SAFE_HANDLE.test(recovery.processHandle) ||
      !isPlainObject(dependencies) || typeof dependencies.commitController !== "function") {
    fail("report_controller_commit_recovery_invalid");
  }
  let committed;
  try {
    committed = await dependencies.commitController({
      action: "commit_activation",
      leaseToken: recovery.leaseToken,
    });
  } catch {
    fail("report_controller_activation_commit_pending");
  }
  if (resultStatus(committed) !== "active") {
    fail("report_controller_activation_commit_pending");
  }
  return { status: "active", jobId: recovery.jobId };
}

// Resume only the uncertain registration boundary from a fresh authenticated
// `main` run in the same canonical owner session. The retained registration is
// submitted byte-for-byte logically unchanged; only an exact `prepared`
// response permits activation. An unresolved or negative retry leaves every
// artifact intact for operator recovery and never activates or cleans up.
export async function retryReportControllerRegistration(recovery, dependencies) {
  if (!hasExactKeys(recovery, ["schemaVersion", "type", "registration"]) ||
      recovery.schemaVersion !== "acp-report-controller-recovery.v1" ||
      recovery.type !== "registration_pending" ||
      !isPlainObject(dependencies) || typeof dependencies.registerController !== "function" ||
      typeof dependencies.activate !== "function" ||
      typeof dependencies.commitController !== "function" ||
      typeof dependencies.removeAutomation !== "function" ||
      typeof dependencies.abortController !== "function" ||
      typeof dependencies.retainRecovery !== "function") {
    fail("report_controller_registration_recovery_invalid");
  }
  const registration = recovery.registration;
  if (!isPlainObject(registration) ||
      !hasExactKeys(registration, ["action", "leaseToken", "transportFile", "processHandle", "jobId",
        "destination", "reportPumpEntry", "hostTransportEntry"], ["snapshotFile"]) ||
      registration.action !== "register") {
    fail("report_controller_registration_recovery_invalid");
  }
  // Reuse the production registration validator without changing any retained
  // value. This also rejects an altered recovery record before a tool call.
  const validated = buildReportControllerRegistration({
    destination: registration.destination,
    reportPumpEntry: registration.reportPumpEntry,
    hostTransportEntry: registration.hostTransportEntry,
    ...(registration.snapshotFile === undefined ? {} : { snapshotFile: registration.snapshotFile }),
  }, registration.leaseToken, registration.jobId, {
    transportFile: registration.transportFile,
    processHandle: registration.processHandle,
  });
  if (JSON.stringify(validated) !== JSON.stringify(registration)) {
    fail("report_controller_registration_recovery_invalid");
  }
  let result;
  try {
    result = await dependencies.registerController(clone(registration));
  } catch {
    fail("report_controller_registration_recovery_pending");
  }
  if (!isExactPreparedRegistration(result)) {
    fail("report_controller_registration_recovery_pending");
  }
  const prepared = {
    transportFile: registration.transportFile,
    processHandle: registration.processHandle,
  };
  let activation;
  try {
    activation = await dependencies.activate(prepared);
    if (activation?.type !== "host_transport_activated") {
      fail("report_controller_activation_failed");
    }
  } catch (error) {
    await rollbackBeforeActivation(registration.jobId, registration.leaseToken,
      prepared, true, dependencies);
    if (error instanceof AcpReportControllerPreparationError) throw error;
    fail("report_controller_preparation_failed");
  }
  let committed;
  try {
    committed = await dependencies.commitController({
      action: "commit_activation",
      leaseToken: registration.leaseToken,
    });
  } catch {
    await retainCommitRecovery(dependencies,
      commitRecoveryState(registration.leaseToken, registration.jobId, prepared));
    fail("report_controller_activation_commit_pending");
  }
  if (resultStatus(committed) !== "active") {
    await retainCommitRecovery(dependencies,
      commitRecoveryState(registration.leaseToken, registration.jobId, prepared));
    fail("report_controller_activation_commit_pending");
  }
  return { status: "active", jobId: registration.jobId, prepared, activation };
}

// Execute the capability-by-use sequence. Dependencies are the authenticated
// host capabilities owned by the direct main-owner run. This helper never
// shells out, polls, launches a background task, or returns the lease token.
export async function runReportControllerPreparation(input, dependencies) {
  const required = [
    "createAutomation", "armAutomation", "bindReporting", "sendStartReceipt", "assemble",
    "prepare", "registerController", "activate", "removeAutomation",
    "commitController", "abortController", "retainRecovery",
  ];
  if (!isPlainObject(input) || !isPlainObject(dependencies) ||
      required.some((name) => typeof dependencies[name] !== "function")) {
    fail("report_controller_preparation_input_invalid");
  }
  const leaseToken = generateReportControllerLeaseToken(dependencies.randomBytes);
  const declarationKey = generateReportControllerDeclarationKey(dependencies.randomUUID);
  let jobId;
  let prepared;
  let registrationConfirmed = false;
  let registrationRecoveryPending = false;
  let activationConfirmed = false;
  try {
    const created = await createControllerPlaceholderJob(
      buildReportControllerPlaceholderAddCall(declarationKey),
      declarationKey,
      dependencies,
    );
    jobId = created.id;
    if (created.enabled !== false) fail("report_controller_job_create_invalid");
    const armCall = buildReportControllerArmUpdateCall(jobId, leaseToken);
    // Nothing below this line runs until the scheduler has proven it stored the
    // exact intended final controller job.
    assertArmedControllerJob(
      await dependencies.armAutomation(armCall),
      jobId,
      declarationKey,
      armCall.job.payload.script,
    );
    const reportPump = buildReportPumpStructuralAttestation(jobId, input.roundIndex);
    const bound = await dependencies.bindReporting({ jobId, reportPump });
    const startReceipt = await dependencies.sendStartReceipt({ jobId, reportPump, bound });
    const assembled = await dependencies.assemble({ jobId, reportPump, bound, startReceipt });
    prepared = await dependencies.prepare({ jobId, reportPump, assembled });
    assertPrepared(prepared);
    const registration = buildReportControllerRegistration(input, leaseToken, jobId, prepared);
    const registrationStatus = await registerControllerWithReplay(registration, dependencies);
    if (registrationStatus === "rejected") {
      fail("report_controller_registration_failed");
    }
    if (registrationStatus !== "prepared") {
      registrationRecoveryPending = true;
      try {
        await retainCommitRecovery(dependencies, registrationRecoveryState(registration));
      } catch {
        fail("report_controller_registration_recovery_failed");
      }
      fail("report_controller_registration_recovery_pending");
    }
    registrationConfirmed = true;
    const activation = await dependencies.activate({
      transportFile: prepared.transportFile,
      processHandle: prepared.processHandle,
    });
    if (activation?.type !== "host_transport_activated") {
      fail("report_controller_activation_failed");
    }
    activationConfirmed = true;
    let committed;
    try {
      committed = await dependencies.commitController({ action: "commit_activation", leaseToken });
    } catch {
      try {
        await retainCommitRecovery(dependencies, commitRecoveryState(leaseToken, jobId, prepared));
      } catch {
        fail("report_controller_commit_recovery_failed");
      }
      fail("report_controller_activation_commit_pending");
    }
    if (resultStatus(committed) !== "active") {
      try {
        await retainCommitRecovery(dependencies, commitRecoveryState(leaseToken, jobId, prepared));
      } catch {
        fail("report_controller_commit_recovery_failed");
      }
      fail("report_controller_activation_commit_pending");
    }
    return { jobId, reportPump, startReceipt, prepared, activation, controllerStatus: "active" };
  } catch (error) {
    if (!activationConfirmed && !registrationRecoveryPending) {
      await rollbackBeforeActivation(
        jobId,
        leaseToken,
        prepared,
        registrationConfirmed,
        dependencies,
      );
    }
    if (error instanceof AcpReportControllerPreparationError) throw error;
    fail("report_controller_preparation_failed");
  }
}
