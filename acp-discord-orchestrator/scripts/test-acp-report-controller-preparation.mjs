import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import {
  AcpReportControllerPreparationError,
  REPORT_CONTROLLER_AUTOMATION_TEMPLATE,
  buildReportControllerAutomationAddCall,
  buildReportControllerRegistration,
  buildReportPumpStructuralAttestation,
  generateReportControllerLeaseToken,
  loadReportControllerAutomationTemplate,
  retryReportControllerActivationCommit,
  runReportControllerPreparation,
} from "./acp-report-controller-preparation.mjs";
import { validateAcpReportingContract } from "./acp-reporting-contract.mjs";
import { buildValidReporting } from "./acp-reporting-test-fixture.mjs";

const PINNED_PLUGIN_COMMIT = "7cdaf6463aac5c34868162f89476295a2a2f90ca";
const PINNED_SCRIPT = `const leaseToken = "LEASE_TOKEN";
const cleanup = async (result) => {
  if (result.status !== "terminal_acked" && result.status !== "tracking_lost") return;
  await automations({ action: "remove", jobId: result.jobId });
  await acp_report_controller({ action: "release", leaseToken });
};
const first = await acp_report_controller({ action: "tick", leaseToken });
if (first.status === "delivery_pending") {
  await message({ action: "send", channel: first.destination.channel, target: first.destination.conversationId, accountId: first.destination.accountId, message: first.message, final: false });
  const afterSend = await acp_report_controller({ action: "tick", leaseToken });
  await cleanup(afterSend);
  return;
}
await cleanup(first);`;
const SCRIPT_SHA256 = "8e48a6cbe8bdb1e6142331257a5763edfc41687e9081745aea074a27146187e7";
const JOB_ID = "acp-report-controller-round-2";
const TOKEN = Buffer.alloc(32, 0xab).toString("base64url");

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

test("private job construction substitutes only the lease token and leaves no public placeholder", () => {
  assert.equal(generateReportControllerLeaseToken(() => Buffer.alloc(32, 0xab)), TOKEN);
  const call = buildReportControllerAutomationAddCall(TOKEN);
  assert.deepEqual(Object.keys(call), ["action", "job"]);
  assert.equal(call.action, "add");
  assert.equal(call.job.payload.script, PINNED_SCRIPT.replace('"LEASE_TOKEN"', JSON.stringify(TOKEN)));
  assert.equal(call.job.payload.script.includes("LEASE_TOKEN"), false);
  assert.equal(JSON.stringify(buildReportPumpStructuralAttestation(JOB_ID, 2)).includes(TOKEN), false);
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

function makeDependencies(events, overrides = {}) {
  return {
    randomBytes: () => Buffer.alloc(32, 0xab),
    async createAutomation(call) { events.push(["create", call]); return { details: { id: JOB_ID } }; },
    async bindReporting(value) { events.push(["bind", value]); return { config: "bound" }; },
    async sendStartReceipt(value) { events.push(["start", value]); return { messageId: "receipt" }; },
    async assemble(value) { events.push(["assemble", value]); return { configFile: "/private/assembled.json" }; },
    async prepare(value) { events.push(["prepare", value]); return { transportFile: "/private/transport.json", processHandle: "handle-1" }; },
    async registerController(value) { events.push(["register", value]); return { details: { status: "prepared" } }; },
    async activate(value) { events.push(["activate", value]); return { type: "host_transport_activated" }; },
    async commitController(value) { events.push(["commit", value]); return { details: { status: "active" } }; },
    async removeAutomation(value) { events.push(["remove", value]); return { removed: true }; },
    async abortController(value) { events.push(["abort", value]); return { details: { status: "aborted" } }; },
    async retainRecovery(value) { events.push(["retain", value]); return { status: "retained" }; },
    ...overrides,
  };
}

test("preparation registers prepared, activates, then commits active", async () => {
  const events = [];
  const result = await runReportControllerPreparation(makeInput(), makeDependencies(events));
  assert.deepEqual(events.map(([name]) => name), [
    "create", "bind", "start", "assemble", "prepare", "register", "activate", "commit",
  ]);
  assert.equal(events[0][1].job.payload.script.includes(TOKEN), true);
  assert.equal(events[1][1].jobId, JOB_ID);
  assert.equal(events[5][1].leaseToken, TOKEN);
  assert.equal(events[5][1].jobId, JOB_ID);
  assert.equal(events[5][1].transportFile, "/private/transport.json");
  assert.deepEqual(events[6][1], { transportFile: "/private/transport.json", processHandle: "handle-1" });
  assert.deepEqual(events[7][1], { action: "commit_activation", leaseToken: TOKEN });
  assert.equal(result.controllerStatus, "active");
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("failure before registration removes only the newly created job and never activates or releases", async () => {
  const events = [];
  await assert.rejects(
    runReportControllerPreparation(makeInput(), makeDependencies(events, {
      async prepare(value) { events.push(["prepare", value]); throw new Error("synthetic private failure"); },
    })),
    (error) => error instanceof AcpReportControllerPreparationError && error.code === "report_controller_preparation_failed",
  );
  assert.deepEqual(events.map(([name]) => name), ["create", "bind", "start", "assemble", "prepare", "remove"]);
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
    "create", "bind", "start", "assemble", "prepare", "register", "activate", "remove", "abort",
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
    "create", "bind", "start", "assemble", "prepare", "register", "activate", "commit", "retain",
  ]);
  const recovery = events.at(-1)[1];
  assert.equal(recovery.leaseToken, TOKEN);
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
