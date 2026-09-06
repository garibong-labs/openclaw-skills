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
  retryReportControllerRegistration,
  runReportControllerPreparation,
} from "./acp-report-controller-preparation.mjs";
import {
  ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS,
  validateAcpReportingContract,
} from "./acp-reporting-contract.mjs";
import { buildValidReporting } from "./acp-reporting-test-fixture.mjs";

const PINNED_PLUGIN_COMMIT = "0fd07ca001d9258db1d8dcb594daf04762f11cfe";
const TEMPLATE_SHA256 = "5a75b6eea2b4b190ea42eaab22d7c99252a5aeb1431c99052e7881c7b63581b3";
const PINNED_SCRIPT = `const leaseToken = "LEASE_TOKEN";
const jobId = "JOB_ID";
const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const removalProven = (response) => {
  if (!isPlainObject(response)) return false;
  if (Object.hasOwn(response, "details") && !isPlainObject(response.details)) return false;
  const evidence = Object.hasOwn(response, "details") ? [response, response.details] : [response];
  let positive = false;
  for (const value of evidence) {
    if (Object.hasOwn(value, "removed")) {
      if (value.removed !== true) return false;
      positive = true;
    }
    if (Object.hasOwn(value, "status")) {
      if (value.status !== "removed") return false;
      positive = true;
    }
    if (Object.hasOwn(value, "error") || Object.hasOwn(value, "failure")) return false;
    if (Object.hasOwn(value, "success") && value.success !== true) return false;
  }
  return positive;
};
const removeCurrentJob = async () => removalProven(
  await automations({ action: "remove", jobId }),
);
const cleanup = async (result) => {
  if (result.status !== "terminal_acked" && result.status !== "tracking_lost") return;
  if (!await removeCurrentJob()) return;
  await acp_report_controller({ action: "release", leaseToken });
};
const first = await acp_report_controller({ action: "tick", leaseToken });
if (first.status === "delivery_pending") {
  await message({ action: "send", message: first.publicationToken, final: false });
  const afterSend = await acp_report_controller({ action: "tick", leaseToken });
  await cleanup(afterSend);
  return {};
}
await cleanup(first);
return {};`;
const SCRIPT_SHA256 = "1dd0ccd2d2bd25ef25c002672a2b6ac4ccf7721b2b9e6304bdf4ddd8ce8ca6f2";
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
  const rawTemplate = fs.readFileSync(REPORT_CONTROLLER_AUTOMATION_TEMPLATE);
  const template = loadReportControllerAutomationTemplate();
  assert.equal(template.payload.script, PINNED_SCRIPT);
  assert.equal(crypto.createHash("sha256").update(PINNED_SCRIPT, "utf8").digest("hex"), SCRIPT_SHA256);
  assert.equal(crypto.createHash("sha256").update(rawTemplate).digest("hex"), TEMPLATE_SHA256);
  assert.deepEqual(template, JSON.parse(rawTemplate.toString("utf8")));
  assert.equal(template.payload.kind, "script");
  assert.equal(template.payload.timeoutSeconds, 60);
  assert.equal(template.payload.toolBudget, 5);
  assert.deepEqual(template.payload.toolsAllow, ["acp_report_controller", "message", "automations"]);
  assert.deepEqual(template.delivery, { mode: "none" });
});

test("template loader rejects the former 600000-ms schedule through the injected file system", () => {
  const stale = JSON.parse(fs.readFileSync(REPORT_CONTROLLER_AUTOMATION_TEMPLATE, "utf8"));
  stale.schedule = { kind: "every", everyMs: 600000 };
  assert.throws(
    () => loadReportControllerAutomationTemplate({ readFileSync: () => JSON.stringify(stale) }),
    new AcpReportControllerPreparationError("report_controller_automation_template_invalid"),
  );
});

async function executePinnedController(results, removalResult = { removed: true }) {
  const calls = [];
  const controller = async (params) => {
    calls.push(["controller", structuredClone(params)]);
    if (params.action === "release") return { status: "released" };
    if (params.action === "abort_preactivation") return { status: "aborted" };
    return results.shift() ?? { status: "none_due" };
  };
  const message = async (params) => {
    calls.push(["message", structuredClone(params)]);
    return { ok: true };
  };
  const automations = async (params) => {
    calls.push(["automations", structuredClone(params)]);
    return removalResult;
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("acp_report_controller", "message", "automations", PINNED_SCRIPT);
  const result = await run(controller, message, automations);
  assert.deepEqual(result, {});
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  return calls;
}

test("every non-throwing controller-script path returns the scheduler-safe plain object", async () => {
  const cases = [
    [[{ status: "none_due" }], { removed: true }],
    [[{ status: "delivery_pending", publicationToken: "opaque-publication-token" },
      { status: "none_due" }], { removed: true }],
    [[{ status: "terminal_acked" }], { details: { removed: true } }],
    [[{ status: "terminal_acked" }], { removed: false }],
    [[{ status: "error", code: "acp_lifecycle_guard.controller.lease_prepared" }],
      { status: "removed" }],
  ];
  for (const [results, removal] of cases) {
    await executePinnedController(structuredClone(results), structuredClone(removal));
  }
});

test("controller-script cleanup accepts only consistent top-level/details removal proof", async () => {
  const accepted = [
    { removed: true },
    { status: "removed" },
    { details: { removed: true } },
    { removed: true, success: true, details: { status: "removed", success: true } },
  ];
  for (const evidence of accepted) {
    const calls = await executePinnedController([{ status: "terminal_acked" }], evidence);
    assert.equal(calls.some(([tool, params]) => tool === "controller" && params.action === "release"), true);
  }
  const rejected = [
    {},
    { success: true },
    { removed: "true" },
    { removed: true, failure: true },
    { removed: true, success: false },
    { details: { status: "removed", error: true } },
    { removed: true, details: { removed: false } },
  ];
  for (const evidence of rejected) {
    const calls = await executePinnedController([{ status: "terminal_acked" }], evidence);
    assert.equal(calls.some(([tool, params]) => tool === "controller" && params.action === "release"), false);
  }
});

test("the model-callable add creates exactly one disabled inert job with no private data", () => {
  assert.equal(generateReportControllerLeaseToken(() => Buffer.alloc(32, 0xab)), TOKEN);
  for (const [firstByte, encodedPrefix] of [[0xf8, "-"], [0xfc, "_"]]) {
    const encoded = Buffer.from([firstByte, ...Buffer.alloc(31)]).toString("base64url");
    assert.equal(encoded.startsWith(encodedPrefix), true);
    assert.match(generateReportControllerLeaseToken(
      () => Buffer.from([firstByte, ...Buffer.alloc(31)])), /^acplease[A-Za-z0-9_-]{43}$/u);
  }
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

// The order installed OpenClaw 2026.8.1 actually persists. `capCronJobToolsAllow`
// rewrites the finite requested allowlist as
// `creatorToolsAllow.filter(matches).map((tool) => tool.name)`, and the creator
// tool surface builds core `automations` before core `message` and appends
// plugin tools last — so the arm request's canonical order never survives, and
// the stored job comes back permuted. Fixtures model that real answer.
const PERSISTED_TOOLS_ALLOW = ["automations", "message", "acp_report_controller"];

// The exact persisted job installed OpenClaw 2026.8.1 returns from the
// model-callable automations update (Gateway cron.update -> cronJobReadView),
// including the scheduler-owned `anchorMs` phase anchor and inert bookkeeping.
function armedJob(overrides = {}) {
  return {
    details: {
      id: JOB_ID,
      declarationKey: DECLARATION_KEY,
      name: "ACP report controller",
      enabled: true,
      sessionTarget: "isolated",
      deleteAfterRun: false,
      schedule: { kind: "every", everyMs: ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS, anchorMs: 1756890000000 },
      payload: {
        kind: "script",
        script: ARMED_SCRIPT,
        timeoutSeconds: 60,
        toolBudget: 5,
        toolsAllow: [...PERSISTED_TOOLS_ALLOW],
      },
      delivery: { mode: "none" },
      createdAtMs: 1756890000000,
      updatedAtMs: 1756900000000,
      configRevision: "rev-1",
      nextRunAtMs: 1756900020000,
      state: {},
      ...overrides,
    },
  };
}

// Same persisted job with the script payload altered, or with named job/payload
// keys dropped entirely, to model a partial or drifted scheduler answer.
function armedJobVariant({ job = {}, payload = {}, dropJobKeys = [], dropPayloadKeys = [] } = {}) {
  const response = armedJob(job);
  const armed = response.details;
  if (!dropJobKeys.includes("payload")) {
    armed.payload = { ...armed.payload, ...payload };
    for (const key of dropPayloadKeys) delete armed.payload[key];
  }
  for (const key of dropJobKeys) delete armed[key];
  return response;
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
  let armAnswer;
  const result = await runReportControllerPreparation(makeInput(), makeDependencies(events, {
    async armAutomation(call) {
      events.push(["arm", call]);
      armAnswer = armedJob();
      return armAnswer;
    },
  }));
  assert.deepEqual(events.map(([name]) => name), [
    "create", "arm", "bind", "start", "assemble", "prepare", "register", "activate", "commit",
  ]);
  // Binding and the public start receipt only run once the scheduler has proven
  // the whole persisted final controller contract, dynamic metadata and all.
  assert.deepEqual(armAnswer.details, {
    id: JOB_ID,
    declarationKey: DECLARATION_KEY,
    name: "ACP report controller",
    enabled: true,
    sessionTarget: "isolated",
    deleteAfterRun: false,
    schedule: { kind: "every", everyMs: ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS, anchorMs: 1756890000000 },
    payload: {
      kind: "script",
      script: ARMED_SCRIPT,
      timeoutSeconds: 60,
      toolBudget: 5,
      // Proven accepted in the order the scheduler really stores, not the order
      // the arm request asked for.
      toolsAllow: ["automations", "message", "acp_report_controller"],
    },
    delivery: { mode: "none" },
    createdAtMs: 1756890000000,
    updatedAtMs: 1756900000000,
    configRevision: "rev-1",
    nextRunAtMs: 1756900020000,
    state: {},
  });
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

function permute(values) {
  if (values.length === 0) return [[]];
  return values.flatMap((entry, index) => permute(
    [...values.slice(0, index), ...values.slice(index + 1)],
  ).map((rest) => [entry, ...rest]));
}

// Installed OpenClaw 2026.8.1 normalizes the requested allowlist order away, so
// the stored array's order is a projection of the creator tool surface and
// carries no authority. Authority is the SET of names, and every ordering of
// exactly the intended set is the same safe authority. Three distinct names
// have exactly six orderings, so iterating them is exhaustive over order.
test("every persisted ordering of the exact allowlist set arms and reaches bind and start", async () => {
  const canonical = ["acp_report_controller", "message", "automations"];
  const orderings = permute(canonical);
  assert.equal(orderings.length, 6);
  // The order the scheduler really stores is one of them, and is deliberately
  // not the order the arm request asks for.
  assert.equal(orderings.some((order) => order.join() === PERSISTED_TOOLS_ALLOW.join()), true);
  assert.notDeepEqual(PERSISTED_TOOLS_ALLOW, canonical);
  for (const toolsAllow of orderings) {
    const events = [];
    const result = await runReportControllerPreparation(makeInput(), makeDependencies(events, {
      async armAutomation(call) {
        events.push(["arm", call]);
        // Whatever the scheduler stores, the outgoing request is unchanged.
        assert.deepEqual(call.job.payload.toolsAllow, canonical, toolsAllow.join());
        return armedJobVariant({ payload: { toolsAllow } });
      },
    }));
    assert.deepEqual(events.map(([name]) => name), [
      "create", "arm", "bind", "start", "assemble", "prepare", "register", "activate", "commit",
    ], toolsAllow.join());
    assert.equal(result.controllerStatus, "active", toolsAllow.join());
    assert.equal(events.some(([name]) => name === "remove"), false, toolsAllow.join());
  }
});

test("an unproven arm removes the exact created job and never binds or starts", async () => {
  const cases = [
    ["throws", "report_controller_preparation_failed", () => { throw new Error("secret arm detail"); }],
    ["unreadable", "report_controller_job_arm_invalid", () => ({ details: { status: "error" } })],
    // A response weak enough to prove nothing about the stored job.
    ["only id and enabled", "report_controller_job_arm_invalid",
      () => ({ details: { id: JOB_ID, enabled: true } })],
    ["still disabled", "report_controller_job_arm_invalid", () => armedJob({ enabled: false })],
    ["wrong id", "report_controller_job_arm_invalid", () => armedJob({ id: "other-job-id" })],
    ["missing id", "report_controller_job_arm_invalid",
      () => armedJobVariant({ dropJobKeys: ["id"] })],
    ["wrong declaration key", "report_controller_job_arm_invalid",
      () => armedJob({ declarationKey: "acp-report-controller-somebody-else-0000" })],
    ["missing declaration key", "report_controller_job_arm_invalid",
      () => armedJobVariant({ dropJobKeys: ["declarationKey"] })],
    ["wrong name", "report_controller_job_arm_invalid", () => armedJob({ name: "Something else" })],
    ["missing name", "report_controller_job_arm_invalid",
      () => armedJobVariant({ dropJobKeys: ["name"] })],
    ["wrong session target", "report_controller_job_arm_invalid",
      () => armedJob({ sessionTarget: "main" })],
    ["missing session target", "report_controller_job_arm_invalid",
      () => armedJobVariant({ dropJobKeys: ["sessionTarget"] })],
    ["wrong schedule kind", "report_controller_job_arm_invalid",
      () => armedJob({ schedule: { kind: "cron", expr: "*/10 * * * *" } })],
    ["wrong schedule interval", "report_controller_job_arm_invalid",
      () => armedJob({ schedule: { kind: "every", everyMs: 1000 } })],
    ["stale pre-upgrade schedule interval", "report_controller_job_arm_invalid",
      () => armedJob({ schedule: { kind: "every", everyMs: 600000, anchorMs: 1756900000000 } })],
    ["extra schedule field", "report_controller_job_arm_invalid",
      () => armedJob({ schedule: { kind: "every", everyMs: ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS, staggerMs: 5000 } })],
    ["missing schedule", "report_controller_job_arm_invalid",
      () => armedJobVariant({ dropJobKeys: ["schedule"] })],
    ["wrong delivery mode", "report_controller_job_arm_invalid",
      () => armedJob({ delivery: { mode: "announce" } })],
    ["extra delivery field", "report_controller_job_arm_invalid",
      () => armedJob({ delivery: { mode: "none", to: "https://example.invalid/hook" } })],
    ["missing delivery", "report_controller_job_arm_invalid",
      () => armedJobVariant({ dropJobKeys: ["delivery"] })],
    ["deleteAfterRun drift", "report_controller_job_arm_invalid",
      () => armedJob({ deleteAfterRun: true })],
    ["missing deleteAfterRun", "report_controller_job_arm_invalid",
      () => armedJobVariant({ dropJobKeys: ["deleteAfterRun"] })],
    // Run/routing-altering fields the intended job never carries.
    ["condition trigger drift", "report_controller_job_arm_invalid",
      () => armedJob({ trigger: { script: "return json({ fire: true });" } })],
    ["pacing drift", "report_controller_job_arm_invalid",
      () => armedJob({ pacing: { maxPerHour: 1 } })],
    ["session key drift", "report_controller_job_arm_invalid",
      () => armedJob({ sessionKey: "agent:main" })],
    ["failure alert drift", "report_controller_job_arm_invalid",
      () => armedJob({ failureAlert: { mode: "announce" } })],
    // Payload: presence, shape, and every executable field.
    ["missing payload", "report_controller_job_arm_invalid",
      () => armedJobVariant({ dropJobKeys: ["payload"] })],
    ["non-object payload", "report_controller_job_arm_invalid",
      () => armedJob({ payload: "script" })],
    ["missing script", "report_controller_job_arm_invalid",
      () => armedJobVariant({ dropPayloadKeys: ["script"] })],
    ["wrong script", "report_controller_job_arm_invalid",
      () => armedJobVariant({ payload: { script: PINNED_SCRIPT } })],
    ["wrong payload kind", "report_controller_job_arm_invalid",
      () => armedJobVariant({ payload: { kind: "command" } })],
    ["agentTurn payload drift", "report_controller_job_arm_invalid",
      () => armedJob({ payload: { kind: "agentTurn", message: "post the report", toolsAllow: ["message"] } })],
    ["model payload drift", "report_controller_job_arm_invalid",
      () => armedJobVariant({ payload: { model: "some-model" } })],
    ["static report payload drift", "report_controller_job_arm_invalid",
      () => armedJob({ payload: { kind: "systemEvent", text: "round 2 complete" } })],
    ["wrong timeout", "report_controller_job_arm_invalid",
      () => armedJobVariant({ payload: { timeoutSeconds: 300 } })],
    ["missing timeout", "report_controller_job_arm_invalid",
      () => armedJobVariant({ dropPayloadKeys: ["timeoutSeconds"] })],
    ["wrong tool budget", "report_controller_job_arm_invalid",
      () => armedJobVariant({ payload: { toolBudget: 50 } })],
    ["missing tool budget", "report_controller_job_arm_invalid",
      () => armedJobVariant({ dropPayloadKeys: ["toolBudget"] })],
    ["wrong tool allowlist", "report_controller_job_arm_invalid",
      () => armedJobVariant({ payload: { toolsAllow: ["acp_report_controller", "message", "exec"] } })],
    ["duplicated tool allowlist entry", "report_controller_job_arm_invalid",
      () => armedJobVariant({ payload: { toolsAllow: ["message", "message", "automations"] } })],
    ["non-string tool allowlist entry", "report_controller_job_arm_invalid",
      () => armedJobVariant({ payload: { toolsAllow: ["automations", "message", { name: "acp_report_controller" }] } })],
    ["plugin group tool allowlist entry", "report_controller_job_arm_invalid",
      () => armedJobVariant({ payload: { toolsAllow: ["automations", "message", "group:acp"] } })],
    ["extra tool allowlist entry", "report_controller_job_arm_invalid",
      () => armedJobVariant({
        payload: { toolsAllow: ["acp_report_controller", "message", "automations", "exec"] },
      })],
    ["short tool allowlist", "report_controller_job_arm_invalid",
      () => armedJobVariant({ payload: { toolsAllow: ["acp_report_controller", "message"] } })],
    ["unrestricted tool allowlist", "report_controller_job_arm_invalid",
      () => armedJobVariant({ payload: { toolsAllow: ["*"] } })],
    ["missing tool allowlist", "report_controller_job_arm_invalid",
      () => armedJobVariant({ dropPayloadKeys: ["toolsAllow"] })],
    ["extra payload field", "report_controller_job_arm_invalid",
      () => armedJobVariant({ payload: { allowUnsafeExternalContent: true } })],
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

test("proven first-call pre-persistence rejection removes the exact job then directly aborts transport", async () => {
  const events = [];
  await assert.rejects(
    runReportControllerPreparation(makeInput(), makeDependencies(events, {
      async registerController(value) {
        events.push(["register", value]);
        return { details: { status: "error", code: "acp_lifecycle_guard.controller.destination_invalid" } };
      },
    })),
    (error) => error instanceof AcpReportControllerPreparationError &&
      error.code === "report_controller_registration_failed",
  );
  assert.deepEqual(events.map(([name]) => name), [
    "create", "arm", "bind", "start", "assemble", "prepare", "register", "remove", "abort-transport",
  ]);
  assert.deepEqual(events.at(-2)[1], { action: "remove", jobId: JOB_ID });
  assert.deepEqual(events.at(-1)[1], {
    transportFile: "/private/transport.json",
    processHandle: "handle-1",
  });
  assert.equal(events.some(([name]) => ["abort", "release", "activate", "commit"].includes(name)), false);
});

test("lost persisted registration response replays the byte-identical input and reaches activation commit", async () => {
  const events = [];
  let registrations = 0;
  const result = await runReportControllerPreparation(makeInput(), makeDependencies(events, {
      async registerController(value) {
        events.push(["register", value]);
        registrations += 1;
        if (registrations === 1) throw new Error("synthetic lost persisted response");
        return { details: { status: "prepared" } };
      },
    }));
  assert.deepEqual(events.map(([name]) => name), [
    "create", "arm", "bind", "start", "assemble", "prepare", "register", "register", "activate", "commit",
  ]);
  assert.equal(registrations, 2, "the replay recovers one persisted lease without a third capacity use");
  assert.deepEqual(events[6][1], events[7][1]);
  assert.equal(JSON.stringify(events[6][1]), JSON.stringify(events[7][1]));
  assert.equal(events[6][1].leaseToken, TOKEN);
  assert.equal(result.controllerStatus, "active");
});

test("an unresolved registration replay retains exact recovery and performs no cleanup or activation", async () => {
  const cases = [
    ["throws twice", () => { throw new Error("synthetic lost response"); }],
    ["missing twice", () => undefined],
    ["negative replay", (() => {
      let attempt = 0;
      return () => (++attempt === 1 ? undefined :
        { details: { status: "error", code: "acp_lifecycle_guard.controller.duplicate" } });
    })()],
    ["mismatched prepared envelope", () => ({ status: "prepared", details: { status: "prepared" } })],
  ];
  for (const [label, respond] of cases) {
    const events = [];
    await assert.rejects(
      runReportControllerPreparation(makeInput(), makeDependencies(events, {
        async registerController(value) { events.push(["register", value]); return respond(); },
      })),
      (error) => error instanceof AcpReportControllerPreparationError &&
        error.code === "report_controller_registration_recovery_pending",
      label,
    );
    assert.deepEqual(events.map(([name]) => name), [
      "create", "arm", "bind", "start", "assemble", "prepare", "register", "register", "retain",
    ], label);
    assert.deepEqual(events[6][1], events[7][1], label);
    assert.equal(events.some(([name]) => ["remove", "abort", "abort-transport", "activate", "commit"]
      .includes(name)), false, label);
    assert.deepEqual(events.at(-1)[1], {
      schemaVersion: "acp-report-controller-recovery.v1",
      type: "registration_pending",
      registration: events[6][1],
    }, label);
  }
});

test("unresolved production preparation survives one and repeated shipped-template ticks, then recovers", async () => {
  const events = [];
  let leaseCapacity = 0;
  let persistedLease;
  let retainedRecovery;
  let jobPresent = true;
  const transport = {
    transportFile: "/private/transport.json",
    processHandle: "handle-1",
    phase: "prepared",
  };
  const dependencies = makeDependencies(events, {
    async registerController(value) {
      events.push(["register", structuredClone(value)]);
      if (persistedLease === undefined) {
        persistedLease = structuredClone(value);
        leaseCapacity += 1;
      } else {
        assert.deepEqual(value, persistedLease);
      }
      throw new Error("synthetic lost prepared response");
    },
    async retainRecovery(value) {
      events.push(["retain", structuredClone(value)]);
      retainedRecovery = structuredClone(value);
      return { status: "retained" };
    },
  });
  await assert.rejects(
    runReportControllerPreparation(makeInput(), dependencies),
    (error) => error instanceof AcpReportControllerPreparationError &&
      error.code === "report_controller_registration_recovery_pending",
  );

  const registrationCalls = events.filter(([name]) => name === "register");
  assert.equal(registrationCalls.length, 2);
  assert.deepEqual(registrationCalls[0][1], registrationCalls[1][1]);
  assert.equal(JSON.stringify(registrationCalls[0][1]), JSON.stringify(registrationCalls[1][1]));
  assert.equal(leaseCapacity, 1);
  assert.deepEqual(retainedRecovery, {
    schemaVersion: "acp-report-controller-recovery.v1",
    type: "registration_pending",
    registration: persistedLease,
  });
  assert.equal(jobPresent, true);
  assert.equal(transport.phase, "prepared");
  assert.equal(events.some(([name]) => ["remove", "abort", "abort-transport", "activate", "commit"]
    .includes(name)), false);

  const schedulerCalls = [];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runShippedController = new AsyncFunction(
    "acp_report_controller", "message", "automations", ARMED_SCRIPT,
  );
  const scheduledExecution = async () => {
    const result = await runShippedController(
      async (params) => {
        schedulerCalls.push(["controller", structuredClone(params)]);
        assert.deepEqual(params, { action: "tick", leaseToken: TOKEN });
        return { status: "error", code: "acp_lifecycle_guard.controller.lease_prepared" };
      },
      async (params) => { schedulerCalls.push(["message", structuredClone(params)]); },
      async (params) => {
        schedulerCalls.push(["automations", structuredClone(params)]);
        jobPresent = false;
        return { removed: true };
      },
    );
    assert.deepEqual(result, {});
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
  };

  await scheduledExecution();
  assert.deepEqual(schedulerCalls.map(([tool]) => tool), ["controller"]);
  for (let execution = 0; execution < 3; execution += 1) await scheduledExecution();
  assert.deepEqual(schedulerCalls.map(([tool]) => tool), [
    "controller", "controller", "controller", "controller",
  ]);
  assert.equal(jobPresent, true);
  assert.equal(transport.phase, "prepared");
  assert.deepEqual(retainedRecovery.registration, persistedLease);
  assert.equal(leaseCapacity, 1);

  const recoveryCalls = [];
  const recovered = await retryReportControllerRegistration(retainedRecovery, {
    async registerController(value) {
      recoveryCalls.push(["register", structuredClone(value)]);
      assert.deepEqual(value, persistedLease);
      return { details: { status: "prepared" } };
    },
    async activate(value) {
      recoveryCalls.push(["activate", structuredClone(value)]);
      assert.deepEqual(value, {
        transportFile: transport.transportFile,
        processHandle: transport.processHandle,
      });
      transport.phase = "active";
      return { type: "host_transport_activated" };
    },
    async commitController(value) {
      recoveryCalls.push(["commit", structuredClone(value)]);
      return { details: { status: "active" } };
    },
    async removeAutomation(value) { recoveryCalls.push(["remove", value]); return { removed: true }; },
    async abortController(value) { recoveryCalls.push(["abort", value]); return { status: "aborted" }; },
    async retainRecovery(value) { recoveryCalls.push(["retain", value]); return { status: "retained" }; },
  });
  assert.deepEqual(recoveryCalls.map(([name]) => name), ["register", "activate", "commit"]);
  assert.equal(leaseCapacity, 1);
  assert.equal(jobPresent, true);
  assert.equal(transport.phase, "active");
  assert.equal(recovered.status, "active");
  assert.equal(recovered.jobId, JOB_ID);
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

// The model-callable automations remove wraps the Gateway cron.remove payload
// with jsonResult(...), so a real successful removal arrives as
// `{ content, details: { removed: true } }` with no top-level `removed`.
// Reading only the top level would misread that success as a failure and skip
// the transport/controller abort, orphaning a prepared lease.
const PROVEN_REMOVALS = [
  ["model-tool jsonResult envelope",
    { content: [{ type: "text", text: '{\n  "removed": true\n}' }], details: { removed: true } }],
  ["nested details.removed", { details: { removed: true } }],
  ["unwrapped top-level removed", { removed: true }],
  ["top-level removed status", { status: "removed" }],
  ["nested details status", { details: { status: "removed" } }],
  ["coexisting top-level positives", { removed: true, status: "removed" }],
  ["coexisting cross-level positives",
    { removed: true, details: { removed: true, status: "removed" } }],
  ["coexisting success attestations",
    { removed: true, success: true, details: { status: "removed", success: true } }],
];

const CONTRADICTORY_REMOVALS = [
  ["same-level top-level contradiction", { removed: true, status: "error" }],
  ["same-level nested contradiction", { details: { removed: true, status: "error" } }],
  ["cross-level removed contradiction", { removed: true, details: { removed: false } }],
  ["cross-level status contradiction", { status: "removed", details: { status: "error" } }],
  ["explicit top-level error", { removed: true, error: "bounded-private-error" }],
  ["explicit nested error", { details: { status: "removed", error: true } }],
  ["explicit top-level failure", { removed: true, failure: true }],
  ["explicit nested failure", { details: { status: "removed", failure: true } }],
  ["false top-level success", { removed: true, success: false }],
  ["non-boolean nested success", { details: { status: "removed", success: "true" } }],
];

test("a proven removal in any real envelope aborts the exact unregistered prepared transport", async () => {
  for (const [label, removal] of PROVEN_REMOVALS) {
    const events = [];
    const input = makeInput();
    // Registration construction fails after prepare, so the transport exists
    // but was never registered and must be aborted directly.
    input.destination = { channel: "discord", accountId: "account-example", conversationId: {} };
    await assert.rejects(
      runReportControllerPreparation(input, makeDependencies(events, {
        async removeAutomation(value) { events.push(["remove", value]); return removal; },
      })),
      (error) => error instanceof AcpReportControllerPreparationError &&
        error.code === "report_controller_registration_invalid",
      label,
    );
    assert.deepEqual(events.map(([name]) => name), [
      "create", "arm", "bind", "start", "assemble", "prepare", "remove", "abort-transport",
    ], label);
    assert.deepEqual(events.at(-2)[1], { action: "remove", jobId: JOB_ID }, label);
    assert.deepEqual(events.at(-1)[1], {
      transportFile: "/private/transport.json",
      processHandle: "handle-1",
    }, label);
  }
});

test("a proven removal in any real envelope aborts the exact registered controller lease", async () => {
  for (const [label, removal] of PROVEN_REMOVALS) {
    const events = [];
    await assert.rejects(
      runReportControllerPreparation(makeInput(), makeDependencies(events, {
        async activate(value) { events.push(["activate", value]); throw new Error("synthetic activation failure"); },
        async removeAutomation(value) { events.push(["remove", value]); return removal; },
      })),
      (error) => error instanceof AcpReportControllerPreparationError &&
        error.code === "report_controller_preparation_failed",
      label,
    );
    assert.deepEqual(events.map(([name]) => name), [
      "create", "arm", "bind", "start", "assemble", "prepare", "register", "activate", "remove", "abort",
    ], label);
    // Removal is always proven before the lease is released, never after.
    assert.deepEqual(events.at(-2)[1], { action: "remove", jobId: JOB_ID }, label);
    assert.deepEqual(events.at(-1)[1], { action: "abort_preactivation", leaseToken: TOKEN }, label);
  }
});

test("an unproven removal envelope never aborts or releases anything", async () => {
  const cases = [
    ["explicit nested denial", () => ({ details: { removed: false } })],
    ["explicit top-level denial", () => ({ removed: false })],
    ["truthy string instead of boolean", () => ({ removed: "true" })],
    ["nested truthy string", () => ({ details: { removed: "true" } })],
    ["truthy number instead of boolean", () => ({ details: { removed: 1 } })],
    ["success without removal proof", () => ({ success: true })],
    ["unrelated top-level status", () => ({ status: "error" })],
    ["unrelated nested status", () => ({ details: { status: "not_found" } })],
    ["removed-looking status value", () => ({ details: { status: "Removed" } })],
    ["non-object details", () => ({ details: "removed" })],
    ["array details", () => ({ details: [{ removed: true }] })],
    ["null details", () => ({ details: null })],
    ["empty envelope", () => ({})],
    ["no envelope at all", () => undefined],
    ["non-object envelope", () => "removed"],
    ["boolean envelope", () => true],
    // A wrapped envelope whose two levels disagree proves nothing either way.
    ...CONTRADICTORY_REMOVALS.map(([label, envelope]) => [label, () => envelope]),
    ["throws", () => { throw new Error("secret removal detail"); }],
  ];
  for (const [label, respond] of cases) {
    const events = [];
    await assert.rejects(
      runReportControllerPreparation(makeInput(), makeDependencies(events, {
        async activate(value) { events.push(["activate", value]); throw new Error("synthetic activation failure"); },
        async removeAutomation(value) { events.push(["remove", value]); return respond(); },
      })),
      (error) => error instanceof AcpReportControllerPreparationError &&
        error.code === "report_controller_pre_activation_cleanup_failed" &&
        !error.message.includes("secret"),
      label,
    );
    assert.deepEqual(events.map(([name]) => name), [
      "create", "arm", "bind", "start", "assemble", "prepare", "register", "activate", "remove",
    ], label);
    assert.equal(events.some(([name]) => name.startsWith("abort")), false, label);
  }
});

test("contradictory removal envelopes never abort an unregistered prepared transport", async () => {
  for (const [label, removal] of CONTRADICTORY_REMOVALS) {
    const events = [];
    const input = makeInput();
    input.destination = { channel: "discord", accountId: "account-example", conversationId: {} };
    await assert.rejects(
      runReportControllerPreparation(input, makeDependencies(events, {
        async removeAutomation(value) { events.push(["remove", value]); return removal; },
      })),
      (error) => error instanceof AcpReportControllerPreparationError &&
        error.code === "report_controller_pre_activation_cleanup_failed",
      label,
    );
    assert.deepEqual(events.map(([name]) => name), [
      "create", "arm", "bind", "start", "assemble", "prepare", "remove",
    ], label);
    assert.equal(events.some(([name]) => name.startsWith("abort")), false, label);
  }
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

test("fresh same-session registration recovery replays only the retained input before activate and commit", async () => {
  const registration = buildReportControllerRegistration(makeInput(), TOKEN, JOB_ID, {
    transportFile: "/private/transport.json",
    processHandle: "handle-1",
  });
  const calls = [];
  const result = await retryReportControllerRegistration({
    schemaVersion: "acp-report-controller-recovery.v1",
    type: "registration_pending",
    registration,
  }, {
    async registerController(value) { calls.push(["register", value]); return { details: { status: "prepared" } }; },
    async activate(value) { calls.push(["activate", value]); return { type: "host_transport_activated" }; },
    async commitController(value) { calls.push(["commit", value]); return { details: { status: "active" } }; },
    async removeAutomation(value) { calls.push(["remove", value]); return { removed: true }; },
    async abortController(value) { calls.push(["abort", value]); return { status: "aborted" }; },
    async retainRecovery(value) { calls.push(["retain", value]); return { status: "retained" }; },
  });
  assert.deepEqual(calls, [
    ["register", registration],
    ["activate", { transportFile: "/private/transport.json", processHandle: "handle-1" }],
    ["commit", { action: "commit_activation", leaseToken: TOKEN }],
  ]);
  assert.equal(result.status, "active");
  assert.equal(result.jobId, JOB_ID);
});

test("fresh registration recovery never activates on a negative or mismatched replay", async () => {
  const registration = buildReportControllerRegistration(makeInput(), TOKEN, JOB_ID, {
    transportFile: "/private/transport.json",
    processHandle: "handle-1",
  });
  for (const answer of [
    { details: { status: "error", code: "acp_lifecycle_guard.controller.duplicate" } },
    { status: "prepared", details: { status: "prepared" } },
  ]) {
    const calls = [];
    await assert.rejects(retryReportControllerRegistration({
      schemaVersion: "acp-report-controller-recovery.v1",
      type: "registration_pending",
      registration,
    }, {
      async registerController(value) { calls.push(["register", value]); return answer; },
      async activate(value) { calls.push(["activate", value]); return { type: "host_transport_activated" }; },
      async commitController(value) { calls.push(["commit", value]); return { status: "active" }; },
      async removeAutomation(value) { calls.push(["remove", value]); return { removed: true }; },
      async abortController(value) { calls.push(["abort", value]); return { status: "aborted" }; },
      async retainRecovery(value) { calls.push(["retain", value]); return { status: "retained" }; },
    }), (error) => error instanceof AcpReportControllerPreparationError &&
      error.code === "report_controller_registration_recovery_pending");
    assert.deepEqual(calls, [["register", registration]]);
  }
});
