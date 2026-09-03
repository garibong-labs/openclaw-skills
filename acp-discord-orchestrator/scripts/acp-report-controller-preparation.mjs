// Private preparation helpers for one durable ACP report-controller lease.
//
// The public template contains a literal LEASE_TOKEN placeholder. Only
// buildReportControllerAutomationAddCall substitutes a generated private token,
// and the resulting job object must go directly to the authenticated
// `automations` add call. Neither the token nor the substituted script is
// returned by runControllerPreparation or placed in the public supervisor
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

export const REPORT_CONTROLLER_AUTOMATION_TEMPLATE = fileURLToPath(
  new URL("../templates/report-controller-automation.json", import.meta.url),
);

const LEASE_TOKEN_PLACEHOLDER = "LEASE_TOKEN";
const SAFE_LEASE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/u;
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u;
const DECIMAL_ID = /^[0-9]{1,30}$/u;

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

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function generateReportControllerLeaseToken(randomBytes = crypto.randomBytes) {
  const token = randomBytes(32).toString("base64url");
  if (!SAFE_LEASE_TOKEN.test(token)) fail("report_controller_lease_token_invalid");
  return token;
}

export function loadReportControllerAutomationTemplate(fileSystem = fs) {
  let template;
  try {
    template = JSON.parse(fileSystem.readFileSync(REPORT_CONTROLLER_AUTOMATION_TEMPLATE, "utf8"));
  } catch {
    fail("report_controller_automation_template_invalid");
  }
  if (!exactKeys(template, ["name", "sessionTarget", "schedule", "payload", "delivery", "enabled", "deleteAfterRun"]) ||
      template.name !== "ACP report controller" || template.sessionTarget !== "isolated" ||
      template.enabled !== true || template.deleteAfterRun !== false ||
      !exactKeys(template.schedule, ["kind", "everyMs"]) ||
      template.schedule.kind !== "every" || template.schedule.everyMs !== 600000 ||
      !exactKeys(template.delivery, ["mode"]) || template.delivery.mode !== "none" ||
      !exactKeys(template.payload, ["kind", "script", "timeoutSeconds", "toolBudget", "toolsAllow"]) ||
      template.payload.kind !== "script" ||
      template.payload.timeoutSeconds !== ACP_REPORT_CONTROLLER_TIMEOUT_SECONDS ||
      template.payload.toolBudget !== ACP_REPORT_CONTROLLER_TOOL_BUDGET ||
      !Array.isArray(template.payload.toolsAllow) ||
      template.payload.toolsAllow.length !== ACP_REPORT_CONTROLLER_TOOLS_ALLOW.length ||
      template.payload.toolsAllow.some((tool, index) => tool !== ACP_REPORT_CONTROLLER_TOOLS_ALLOW[index]) ||
      typeof template.payload.script !== "string" ||
      template.payload.script.split(LEASE_TOKEN_PLACEHOLDER).length !== 2 ||
      crypto.createHash("sha256").update(template.payload.script, "utf8").digest("hex") !==
        ACP_REPORT_CONTROLLER_SCRIPT_SHA256) {
    fail("report_controller_automation_template_invalid");
  }
  return clone(template);
}

export function buildReportControllerAutomationAddCall(leaseToken, options = {}) {
  if (!SAFE_LEASE_TOKEN.test(leaseToken)) fail("report_controller_lease_token_invalid");
  const template = loadReportControllerAutomationTemplate(options.fileSystem);
  template.payload.script = template.payload.script.replace(
    `"${LEASE_TOKEN_PLACEHOLDER}"`,
    JSON.stringify(leaseToken),
  );
  if (template.payload.script.includes(LEASE_TOKEN_PLACEHOLDER)) {
    fail("report_controller_automation_template_invalid");
  }
  return { action: "add", job: template };
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

function extractJobId(result) {
  const candidate = plainObject(result?.details) ? result.details.id : result?.id;
  if (!SAFE_JOB_ID.test(candidate)) fail("report_controller_job_create_invalid");
  return candidate;
}

function assertPrepared(prepared) {
  if (!plainObject(prepared) || typeof prepared.transportFile !== "string" ||
      prepared.transportFile.length === 0 || typeof prepared.processHandle !== "string" ||
      prepared.processHandle.length === 0) {
    fail("report_controller_transport_prepare_invalid");
  }
}

function resultStatus(result) {
  return plainObject(result?.details) ? result.details.status : result?.status;
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
      !plainObject(registration.destination) || registration.destination.channel !== "discord" ||
      !SAFE_ACCOUNT.test(registration.destination.accountId) ||
      !DECIMAL_ID.test(registration.destination.conversationId)) {
    fail("report_controller_registration_invalid");
  }
  return registration;
}

async function rollbackBeforeActivation(jobId, leaseToken, registered, dependencies) {
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
  if (registered) {
    try {
      const aborted = await dependencies.abortController({ action: "abort_preactivation", leaseToken });
      if (resultStatus(aborted) !== "aborted") {
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
  if (!exactKeys(recovery, ["schemaVersion", "type", "leaseToken", "jobId", "transportFile", "processHandle"]) ||
      recovery.schemaVersion !== "acp-report-controller-recovery.v1" ||
      recovery.type !== "commit_activation_pending" ||
      !SAFE_LEASE_TOKEN.test(recovery.leaseToken) || !SAFE_JOB_ID.test(recovery.jobId) ||
      !path.isAbsolute(recovery.transportFile) || !SAFE_HANDLE.test(recovery.processHandle) ||
      !plainObject(dependencies) || typeof dependencies.commitController !== "function") {
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
    "createAutomation", "bindReporting", "sendStartReceipt", "assemble",
    "prepare", "registerController", "activate", "removeAutomation",
    "commitController", "abortController", "retainRecovery",
  ];
  if (!plainObject(input) || !plainObject(dependencies) ||
      required.some((name) => typeof dependencies[name] !== "function")) {
    fail("report_controller_preparation_input_invalid");
  }
  const leaseToken = generateReportControllerLeaseToken(dependencies.randomBytes);
  let jobId;
  let registered = false;
  let activationConfirmed = false;
  try {
    const created = await dependencies.createAutomation(
      buildReportControllerAutomationAddCall(leaseToken),
    );
    jobId = extractJobId(created);
    const reportPump = buildReportPumpStructuralAttestation(jobId, input.roundIndex);
    const bound = await dependencies.bindReporting({ jobId, reportPump });
    const startReceipt = await dependencies.sendStartReceipt({ jobId, reportPump, bound });
    const assembled = await dependencies.assemble({ jobId, reportPump, bound, startReceipt });
    const prepared = await dependencies.prepare({ jobId, reportPump, assembled });
    assertPrepared(prepared);
    const registration = buildReportControllerRegistration(input, leaseToken, jobId, prepared);
    const registrationResult = await dependencies.registerController(registration);
    if (resultStatus(registrationResult) !== "prepared") {
      fail("report_controller_registration_failed");
    }
    registered = true;
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
    if (!activationConfirmed) await rollbackBeforeActivation(jobId, leaseToken, registered, dependencies);
    if (error instanceof AcpReportControllerPreparationError) throw error;
    fail("report_controller_preparation_failed");
  }
}
