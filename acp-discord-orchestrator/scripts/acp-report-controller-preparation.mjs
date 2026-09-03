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
// enabled wrong-script window. Neither the token nor the substituted script is
// returned by runReportControllerPreparation or placed in the public supervisor
// reporting bundle.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACP_REPORT_CONTROLLER_SCRIPT_SHA256,
  ACP_REPORT_CONTROLLER_SCRIPT_VERSION,
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
      template.name !== "ACP report controller" || template.sessionTarget !== "isolated" ||
      template.enabled !== true || template.deleteAfterRun !== false ||
      !hasExactKeys(template.schedule, ["kind", "everyMs"]) ||
      template.schedule.kind !== "every" || template.schedule.everyMs !== 600000 ||
      !hasExactKeys(template.delivery, ["mode"]) || template.delivery.mode !== "none" ||
      !hasExactKeys(template.payload, ["kind", "script", "timeoutSeconds", "toolBudget", "toolsAllow"]) ||
      template.payload.kind !== "script" ||
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
    schedule: { kind: "every", everyMs: 600000 },
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

function assertArmedControllerJob(result, jobId, expectedScript) {
  const job = readAutomationJob(result);
  if (job === undefined || job.id !== jobId || job.enabled !== true) {
    fail("report_controller_job_arm_invalid");
  }
  if (job.payload !== undefined &&
      (!isPlainObject(job.payload) || job.payload.kind !== "script" ||
        (job.payload.script !== undefined && job.payload.script !== expectedScript))) {
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

async function rollbackBeforeActivation(jobId, leaseToken, prepared, registrationSubmitted, dependencies) {
  if (jobId !== undefined) {
    try {
      const removed = await dependencies.removeAutomation({ action: "remove", jobId });
      if (removed?.removed !== true && resultStatus(removed) !== "removed") {
        fail("report_controller_pre_activation_cleanup_failed");
      }
    } catch {
      fail("report_controller_pre_activation_cleanup_failed");
    }
  }
  if (prepared !== undefined) {
    try {
      const aborted = registrationSubmitted
        ? await dependencies.abortController({ action: "abort_preactivation", leaseToken })
        : await (dependencies.abortTransport ?? abortHostTransportPreactivation)({
            transportFile: prepared.transportFile,
            processHandle: prepared.processHandle,
          });
      const abortedStatus = registrationSubmitted ? resultStatus(aborted) :
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
  let registrationSubmitted = false;
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
    assertArmedControllerJob(
      await dependencies.armAutomation(armCall),
      jobId,
      armCall.job.payload.script,
    );
    const reportPump = buildReportPumpStructuralAttestation(jobId, input.roundIndex);
    const bound = await dependencies.bindReporting({ jobId, reportPump });
    const startReceipt = await dependencies.sendStartReceipt({ jobId, reportPump, bound });
    const assembled = await dependencies.assemble({ jobId, reportPump, bound, startReceipt });
    prepared = await dependencies.prepare({ jobId, reportPump, assembled });
    assertPrepared(prepared);
    const registration = buildReportControllerRegistration(input, leaseToken, jobId, prepared);
    registrationSubmitted = true;
    const registrationResult = await dependencies.registerController(registration);
    if (resultStatus(registrationResult) !== "prepared") {
      fail("report_controller_registration_failed");
    }
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
    if (!activationConfirmed) {
      await rollbackBeforeActivation(
        jobId,
        leaseToken,
        prepared,
        registrationSubmitted,
        dependencies,
      );
    }
    if (error instanceof AcpReportControllerPreparationError) throw error;
    fail("report_controller_preparation_failed");
  }
}
