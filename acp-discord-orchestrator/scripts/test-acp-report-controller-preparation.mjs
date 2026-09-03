import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import {
  AcpReportControllerPreparationError,
  REPORT_CONTROLLER_AUTOMATION_TEMPLATE,
  REPORT_CONTROLLER_PLACEHOLDER_SCRIPT,
  buildReportControllerArmUpdateCall,
  buildReportControllerPlaceholderAddCall,
  buildReportControllerRegistration,
  buildReportPumpStructuralAttestation,
  generateReportControllerDeclarationKey,
  generateReportControllerLeaseToken,
  loadReportControllerAutomationTemplate,
  retryReportControllerActivationCommit,
  runReportControllerPreparation,
} from "./acp-report-controller-preparation.mjs";
import { validateAcpReportingContract } from "./acp-reporting-contract.mjs";
import { buildValidReporting } from "./acp-reporting-test-fixture.mjs";

const PINNED_PLUGIN_COMMIT = "0acb0dc271212afebbd68dee03b2ef3389058af1";
const PINNED_SCRIPT = `const leaseToken = "LEASE_TOKEN";
const jobId = "JOB_ID";
const cleanup = async (result) => {
  if (result.status !== "terminal_acked" && result.status !== "tracking_lost") return;
  await automations({ action: "remove", jobId });
  await acp_report_controller({ action: "release", leaseToken });
};
const first = await acp_report_controller({ action: "tick", leaseToken });
if (first.status === "delivery_pending") {
  await message({ action: "send", message: first.publicationToken, final: false });
  const afterSend = await acp_report_controller({ action: "tick", leaseToken });
  await cleanup(afterSend);
  return;
}
if (first.status === "error" && first.code === "acp_lifecycle_guard.controller.lease_prepared") {
  await automations({ action: "remove", jobId });
  await acp_report_controller({ action: "abort_preactivation", leaseToken });
  return;
}
await cleanup(first);`;
const SCRIPT_SHA256 = "dad87e9f3b11f74d7a541c3b0c5ac0cdaca2ffd4fd49161ec2b4b333c4b6c65c";
// The scheduler owns job identity: the returned id is deliberately unrelated to
// the caller-chosen declaration key so every binding must use the returned one.
const UUID = "11111111-2222-3333-4444-555555555555";
const DECLARATION_KEY = `acp-report-controller-${UUID}`;
const JOB_ID = "9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";
const TOKEN = `acplease${Buffer.alloc(32, 0xab).toString("base64url")}`;
const ARMED_SCRIPT = PINNED_SCRIPT
  .replace('"JOB_ID"', JSON.stringify(JOB_ID))
  .replace('"LEASE_TOKEN"', JSON.stringify(TOKEN));

test(`automation template is byte-for-byte script-compatible with plugin ${PINNED_PLUGIN_COMMIT}`, () => {
  const template = loadReportControllerAutomationTemplate();
  assert.equal(template.payload.script, PINNED_SCRIPT);
  assert.equal(crypto.createHash("sha256").update(PINNED_SCRIPT, "utf8").digest("hex"), SCRIPT_SHA256);
  assert.deepEqual(template, JSON.parse(fs.readFileSync(REPORT_CONTROLLER_AUTOMATION_TEMPLATE, "utf8")));
  assert.equal(template.payload.kind, "script");
  assert.equal(template.payload.timeoutSeconds, 60);
  assert.equal(template.payload.toolBudget, 5);
  assert.deepEqual(template.payload.toolsAllow, ["acp_report_controller", "message", "automations"]);
  assert.deepEqual(template.delivery, { mode: "none" });
});

test("the model-callable add creates exactly one disabled inert job with no private data", () => {
  assert.equal(generateReportControllerLeaseToken(() => Buffer.alloc(32, 0xab)), TOKEN);
  assert.equal(generateReportControllerLeaseToken(() => Buffer.from([0xf8, ...Buffer.alloc(31)]))
    .startsWith("acplease-"), true);
  assert.equal(generateReportControllerDeclarationKey(() => UUID), DECLARATION_KEY);
  const call = buildReportControllerPlaceholderAddCall(DECLARATION_KEY);
  assert.deepEqual(Object.keys(call), ["action", "job"]);
  assert.equal(call.action, "add");
  assert.deepEqual(Object.keys(call.job), [
    "name", "declarationKey", "sessionTarget", "schedule", "payload", "delivery",
    "enabled", "deleteAfterRun",
  ]);
  assert.equal(call.job.declarationKey, DECLARATION_KEY);
  assert.equal(call.job.enabled, false);
  assert.equal(call.job.payload.script, REPORT_CONTROLLER_PLACEHOLDER_SCRIPT);
  const serialized = JSON.stringify(call);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes("LEASE_TOKEN"), false);
  assert.equal(serialized.includes("JOB_ID"), false);
  assert.equal(serialized.includes(JOB_ID), false);
});

// Installed OpenClaw 2026.8.1 routes the model-facing automations add action to
// the public Gateway cron.add, whose closed parameter schema has no id field;
// any reserved identity on the add job is rejected at that real boundary.
test("no reserved id can reappear anywhere on the model-callable add shape", () => {
  const call = buildReportControllerPlaceholderAddCall(DECLARATION_KEY);
  const seen = [];
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      seen.push(key);
      walk(nested);
    }
  };
  walk(call.job);
  assert.equal(seen.includes("id"), false);
  assert.equal(seen.includes("jobId"), false);
  assert.equal(Object.hasOwn(call, "id"), false);
  assert.equal(Object.hasOwn(call, "jobId"), false);
  assert.throws(() => buildReportControllerPlaceholderAddCall("short"),
    (error) => error.code === "report_controller_declaration_key_invalid");
});

test("the arm update targets the exact returned id and substitutes both private placeholders", () => {
  const call = buildReportControllerArmUpdateCall(JOB_ID, TOKEN);
  assert.deepEqual(Object.keys(call), ["action", "id", "job"]);
  assert.equal(call.action, "update");
  assert.equal(call.id, JOB_ID);
  assert.deepEqual(Object.keys(call.job), ["payload", "enabled"]);
  assert.equal(call.job.enabled, true);
  assert.deepEqual(call.job.payload, {
    kind: "script",
    script: ARMED_SCRIPT,
    timeoutSeconds: 60,
    toolBudget: 5,
    toolsAllow: ["acp_report_controller", "message", "automations"],
  });
  assert.equal(call.job.payload.script.includes("LEASE_TOKEN"), false);
  assert.equal(call.job.payload.script.includes("JOB_ID"), false);
  assert.equal(call.job.payload.script.includes(TOKEN), true);
  assert.equal(call.job.payload.script.includes(JOB_ID), true);
  assert.equal(JSON.stringify(buildReportPumpStructuralAttestation(JOB_ID, 2)).includes(TOKEN), false);
  assert.throws(() => buildReportControllerArmUpdateCall("bad id", TOKEN),
    (error) => error.code === "report_controller_job_id_invalid");
  assert.throws(() => buildReportControllerArmUpdateCall(JOB_ID, "short"),
    (error) => error.code === "report_controller_lease_token_invalid");
});

test("registration helper builds the exact private controller schema", () => {
  assert.deepEqual(buildReportControllerRegistration(
    makeInput(), TOKEN, JOB_ID,
    { transportFile: "/private/transport.json", processHandle: "handle-1" },
  ), {
    action: "register",
    leaseToken: TOKEN,
    transportFile: "/private/transport.json",
    processHandle: "handle-1",
    jobId: JOB_ID,
    destination: { channel: "discord", accountId: "account-example", conversationId: "123456789012345678" },
    reportPumpEntry: "/trusted/acp-report-pump.mjs",
    hostTransportEntry: "/trusted/acp-host-transport.mjs",
    snapshotFile: "/private/report-pump-snapshot.json",
  });
});

test("v3 structural attestation validates without disclosing token, executable script, or static report", () => {
  const reporting = buildValidReporting({
    roundIndex: 2,
    schemaVersion: "acp-reporting-v3",
    controlConversationId: "123456789012345678",
    messageId: "222333444555666777",
    deliveredAt: "2026-09-03T03:00:00.000Z",
  });
  reporting.reportPump = buildReportPumpStructuralAttestation(JOB_ID, 2);
  const context = {
    agent: reporting.agent,
    model: "test-model",
    controlConversationId: reporting.startDestination,
    lifecycleStartReceipt: {
      conversationId: reporting.startReceipt.conversationId,
      messageId: reporting.startReceipt.messageId,
      deliveredAt: reporting.startReceipt.deliveredAt,
    },
  };
  const normalized = validateAcpReportingContract(reporting, context);
  const serialized = JSON.stringify(normalized);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(PINNED_SCRIPT), false);
  assert.equal(serialized.includes("leaseToken"), false);
  assert.equal(normalized.reportPump.id, JOB_ID);
  assert.equal(normalized.reportPump.payload.scriptSha256, SCRIPT_SHA256);
});

function makeInput() {
  return {
    roundIndex: 2,
    destination: { channel: "discord", accountId: "account-example", conversationId: "123456789012345678" },
    reportPumpEntry: "/trusted/acp-report-pump.mjs",
    hostTransportEntry: "/trusted/acp-host-transport.mjs",
    snapshotFile: "/private/report-pump-snapshot.json",
  };
}

function createdJob(overrides = {}) {
  return {
    details: {
      created: true,
      job: { id: JOB_ID, declarationKey: DECLARATION_KEY, enabled: false, ...overrides },
    },
  };
}

function armedJob(overrides = {}) {
  return {
    details: {
      id: JOB_ID,
      declarationKey: DECLARATION_KEY,
      enabled: true,
      payload: {
        kind: "script",
        script: ARMED_SCRIPT,
        timeoutSeconds: 60,
        toolBudget: 5,
        toolsAllow: ["acp_report_controller", "message", "automations"],
      },
      ...overrides,
    },
  };
}

function makeDependencies(events, overrides = {}) {
  return {
    randomBytes: () => Buffer.alloc(32, 0xab),
    randomUUID: () => UUID,
    async createAutomation(call) { events.push(["create", call]); return createdJob(); },
    async armAutomation(call) { events.push(["arm", call]); return armedJob(); },
    async bindReporting(value) { events.push(["bind", value]); return { config: "bound" }; },
    async sendStartReceipt(value) { events.push(["start", value]); return { messageId: "receipt" }; },
    async assemble(value) { events.push(["assemble", value]); return { configFile: "/private/assembled.json" }; },
    async prepare(value) { events.push(["prepare", value]); return { transportFile: "/private/transport.json", processHandle: "handle-1" }; },
    async registerController(value) { events.push(["register", value]); return { details: { status: "prepared" } }; },
    async activate(value) { events.push(["activate", value]); return { type: "host_transport_activated" }; },
    async commitController(value) { events.push(["commit", value]); return { details: { status: "active" } }; },
    async removeAutomation(value) { events.push(["remove", value]); return { removed: true }; },
    async abortController(value) { events.push(["abort", value]); return { details: { status: "aborted" } }; },
    async abortTransport(value) { events.push(["abort-transport", value]); return { type: "host_transport_preactivation_aborted" }; },
    async retainRecovery(value) { events.push(["retain", value]); return { status: "retained" }; },
    ...overrides,
  };
}

test("preparation creates disabled, arms the exact returned id, then binds, registers, and commits", async () => {
  const events = [];
  const result = await runReportControllerPreparation(makeInput(), makeDependencies(events));
  assert.deepEqual(events.map(([name]) => name), [
    "create", "arm", "bind", "start", "assemble", "prepare", "register", "activate", "commit",
  ]);
  // Nothing private, and nothing enabled, exists before the exact id is known.
  assert.equal(events[0][1].job.enabled, false);
  assert.equal(events[0][1].job.declarationKey, DECLARATION_KEY);
  assert.equal(JSON.stringify(events[0][1]).includes(TOKEN), false);
  assert.equal(JSON.stringify(events[0][1]).includes(JOB_ID), false);
  // The single arm call carries the token, the exact scheduler id, and enabled.
  assert.equal(events[1][1].id, JOB_ID);
  assert.equal(events[1][1].job.enabled, true);
  assert.equal(events[1][1].job.payload.script, ARMED_SCRIPT);
  // Every later binding uses the scheduler-returned id, not the declaration key.
  assert.equal(events[2][1].jobId, JOB_ID);
  assert.equal(events[2][1].reportPump.id, JOB_ID);
  assert.equal(events[6][1].leaseToken, TOKEN);
  assert.equal(events[6][1].jobId, JOB_ID);
  assert.equal(events[6][1].transportFile, "/private/transport.json");
  assert.deepEqual(events[7][1], { transportFile: "/private/transport.json", processHandle: "handle-1" });
  assert.deepEqual(events[8][1], { action: "commit_activation", leaseToken: TOKEN });
  assert.equal(result.jobId, JOB_ID);
  assert.equal(result.reportPump.id, JOB_ID);
  assert.equal(result.controllerStatus, "active");
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes(ARMED_SCRIPT), false);
});

test("a lost add response replays the same declaration key and converges on one job", async () => {
  const events = [];
  let attempts = 0;
  const result = await runReportControllerPreparation(makeInput(), makeDependencies(events, {
    async createAutomation(call) {
      events.push(["create", call]);
      attempts += 1;
      if (attempts === 1) throw new Error("synthetic lost add response");
      // Declaration-key convergence returns the exact already-created job.
      return { details: { created: false, updated: false, job: { id: JOB_ID, declarationKey: DECLARATION_KEY, enabled: false } } };
    },
  }));
  assert.equal(attempts, 2);
  assert.deepEqual(events.map(([name]) => name), [
    "create", "create", "arm", "bind", "start", "assemble", "prepare", "register", "activate", "commit",
  ]);
  assert.deepEqual(events[0][1], events[1][1]);
  assert.equal(events[2][1].id, JOB_ID);
  assert.equal(result.jobId, JOB_ID);
});

test("a permanently unresolved create never invents an id, arms, removes, or aborts", async () => {
  for (const response of [
    undefined,
    { details: { created: true, job: { declarationKey: DECLARATION_KEY, enabled: false } } },
    { details: { created: true, job: { id: "not a job id", declarationKey: DECLARATION_KEY, enabled: false } } },
    { details: { created: true, job: { id: JOB_ID, declarationKey: "acp-report-controller-somebody-else-0000", enabled: false } } },
  ]) {
    const events = [];
    await assert.rejects(
      runReportControllerPreparation(makeInput(), makeDependencies(events, {
        async createAutomation(call) { events.push(["create", call]); return response; },
      })),
      (error) => error instanceof AcpReportControllerPreparationError &&
        error.code === "report_controller_job_create_unresolved",
    );
    assert.deepEqual(events.map(([name]) => name), ["create", "create"]);
  }
});

test("a returned job that is not disabled is removed instead of armed", async () => {
  const events = [];
  await assert.rejects(
    runReportControllerPreparation(makeInput(), makeDependencies(events, {
      async createAutomation(call) { events.push(["create", call]); return createdJob({ enabled: true }); },
    })),
    (error) => error instanceof AcpReportControllerPreparationError &&
      error.code === "report_controller_job_create_invalid",
  );
  assert.deepEqual(events.map(([name]) => name), ["create", "remove"]);
  assert.deepEqual(events.at(-1)[1], { action: "remove", jobId: JOB_ID });
});

test("an unproven arm removes the exact created job and never binds or starts", async () => {
  const cases = [
    ["throws", "report_controller_preparation_failed", () => { throw new Error("secret arm detail"); }],
    ["still disabled", "report_controller_job_arm_invalid", () => armedJob({ enabled: false })],
    ["wrong id", "report_controller_job_arm_invalid", () => armedJob({ id: "other-job-id" })],
    ["wrong script", "report_controller_job_arm_invalid",
      () => armedJob({ payload: { kind: "script", script: PINNED_SCRIPT } })],
    ["unreadable", "report_controller_job_arm_invalid", () => ({ details: { status: "error" } })],
  ];
  for (const [label, expected, respond] of cases) {
    const events = [];
    await assert.rejects(
      runReportControllerPreparation(makeInput(), makeDependencies(events, {
        async armAutomation(call) { events.push(["arm", call]); return respond(); },
      })),
      (error) => error instanceof AcpReportControllerPreparationError && error.code === expected &&
        !error.message.includes("secret"),
      label,
    );
    assert.deepEqual(events.map(([name]) => name), ["create", "arm", "remove"], label);
    assert.deepEqual(events.at(-1)[1], { action: "remove", jobId: JOB_ID });
  }
});

test("failure before registration removes only the newly created job and never activates or releases", async () => {
  const events = [];
  await assert.rejects(
    runReportControllerPreparation(makeInput(), makeDependencies(events, {
      async prepare(value) { events.push(["prepare", value]); throw new Error("synthetic private failure"); },
    })),
    (error) => error instanceof AcpReportControllerPreparationError && error.code === "report_controller_preparation_failed",
  );
  assert.deepEqual(events.map(([name]) => name), ["create", "arm", "bind", "start", "assemble", "prepare", "remove"]);
});

test("malformed registration after transport preparation removes the job then aborts the exact transport", async () => {
  const events = [];
  const input = makeInput();
  input.destination = { channel: "discord", accountId: "account-example", conversationId: {} };
  await assert.rejects(
    runReportControllerPreparation(input, makeDependencies(events)),
    (error) => error instanceof AcpReportControllerPreparationError &&
      error.code === "report_controller_registration_invalid",
  );
  assert.deepEqual(events.map(([name]) => name), [
    "create", "arm", "bind", "start", "assemble", "prepare", "remove", "abort-transport",
  ]);
  assert.deepEqual(events.at(-1)[1], {
    transportFile: "/private/transport.json",
    processHandle: "handle-1",
  });
});

test("non-prepared registration removes the job before controller-proven abort", async () => {
  const events = [];
  await assert.rejects(
    runReportControllerPreparation(makeInput(), makeDependencies(events, {
      async registerController(value) { events.push(["register", value]); return { status: "rejected" }; },
    })),
    (error) => error instanceof AcpReportControllerPreparationError &&
      error.code === "report_controller_registration_failed",
  );
  assert.deepEqual(events.map(([name]) => name), [
    "create", "arm", "bind", "start", "assemble", "prepare", "register", "remove", "abort",
  ]);
});

test("failure before activation confirmation removes the current job before aborting preactivation", async () => {
  const events = [];
  await assert.rejects(
    runReportControllerPreparation(makeInput(), makeDependencies(events, {
      async activate(value) { events.push(["activate", value]); throw new Error("synthetic activation failure"); },
    })),
    (error) => error instanceof AcpReportControllerPreparationError && error.code === "report_controller_preparation_failed",
  );
  assert.deepEqual(events.map(([name]) => name), [
    "create", "arm", "bind", "start", "assemble", "prepare", "register", "activate", "remove", "abort",
  ]);
  assert.deepEqual(events.at(-2)[1], { action: "remove", jobId: JOB_ID });
  assert.deepEqual(events.at(-1)[1], { action: "abort_preactivation", leaseToken: TOKEN });
});

test("automation removal failure never aborts the prepared lease", async () => {
  const events = [];
  await assert.rejects(
    runReportControllerPreparation(makeInput(), makeDependencies(events, {
      async activate(value) { events.push(["activate", value]); throw new Error("secret activation detail"); },
      async removeAutomation(value) { events.push(["remove", value]); return { status: "error" }; },
    })),
    (error) => error instanceof AcpReportControllerPreparationError &&
      error.code === "report_controller_pre_activation_cleanup_failed" &&
      !error.message.includes("secret"),
  );
  assert.equal(events.some(([name]) => name === "abort"), false);
});

test("missing arm capability fails closed before any scheduler call", async () => {
  const events = [];
  const dependencies = makeDependencies(events);
  delete dependencies.armAutomation;
  await assert.rejects(
    runReportControllerPreparation(makeInput(), dependencies),
    (error) => error instanceof AcpReportControllerPreparationError &&
      error.code === "report_controller_preparation_input_invalid",
  );
  assert.deepEqual(events, []);
});

test("commit failure retains exact recovery and never removes, aborts, or relaunches", async () => {
  const events = [];
  await assert.rejects(
    runReportControllerPreparation(makeInput(), makeDependencies(events, {
      async commitController(value) { events.push(["commit", value]); throw new Error("lost response"); },
    })),
    (error) => error instanceof AcpReportControllerPreparationError &&
      error.code === "report_controller_activation_commit_pending",
  );
  assert.deepEqual(events.map(([name]) => name), [
    "create", "arm", "bind", "start", "assemble", "prepare", "register", "activate", "commit", "retain",
  ]);
  const recovery = events.at(-1)[1];
  assert.equal(recovery.leaseToken, TOKEN);
  assert.equal(recovery.jobId, JOB_ID);
  assert.equal(recovery.type, "commit_activation_pending");
  assert.equal(events.some(([name]) => ["remove", "abort"].includes(name)), false);
});

test("fresh same-session recovery retries only commit_activation", async () => {
  const calls = [];
  const result = await retryReportControllerActivationCommit({
    schemaVersion: "acp-report-controller-recovery.v1",
    type: "commit_activation_pending",
    leaseToken: TOKEN,
    jobId: JOB_ID,
    transportFile: "/private/transport.json",
    processHandle: "handle-1",
  }, {
    async commitController(value) { calls.push(value); return { status: "active" }; },
  });
  assert.deepEqual(calls, [{ action: "commit_activation", leaseToken: TOKEN }]);
  assert.deepEqual(result, { status: "active", jobId: JOB_ID });
});
