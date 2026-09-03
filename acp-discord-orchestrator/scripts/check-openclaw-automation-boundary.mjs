#!/usr/bin/env node
// Installed-boundary evidence probe for the ACP report controller.
//
// The checked-in node:test suites run anywhere and therefore mock the
// model-callable `automations` boundary. Two real behaviours of installed
// OpenClaw are invisible to those mocks unless something reads the real thing:
//
//   1. `capCronJobToolsAllow` does not persist the requested allowlist order.
//      It rewrites a finite requested allowlist as
//      `creatorToolsAllow.filter(matches).map((tool) => tool.name)`, so the
//      stored array comes back in the creator's final executable tool-surface
//      order, where core `automations` precedes core `message` and plugin tools
//      are appended last.
//   2. `cron.remove` answers with the cron store's own `{ removed: true }`
//      result, and the cron tool wraps it with `jsonResult(...)`. The
//      model-visible envelope is therefore `{ content, details: { removed } }`
//      and carries no top-level `removed` at all.
//
// This probe executes both against the installed bundles — not against a
// transcription of them — and then drives the shipped preparation helper with
// exactly what they produce. It is deliberately not a node:test file: it needs
// a local OpenClaw install, so it is run and reported separately from the
// portable suites. With no usable install it reports SKIP and exits 0 rather
// than failing a machine that simply has nothing to probe.
//
// Bundles are located by content signature, never by their hashed filenames and
// never by hashing a whole bundle, so an unrelated OpenClaw rebuild does not
// break the probe while a change to the pinned behaviour still does.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ACP_REPORT_CONTROLLER_TOOLS_ALLOW } from "./acp-reporting-contract.mjs";
import {
  buildReportControllerArmUpdateCall,
  buildReportControllerPlaceholderAddCall,
  runReportControllerPreparation,
} from "./acp-report-controller-preparation.mjs";

const EXPECTED_VERSION = "2026.8.1";
const DIST_CANDIDATES = [
  "/opt/homebrew/lib/node_modules/openclaw",
  "/usr/local/lib/node_modules/openclaw",
  "/usr/lib/node_modules/openclaw",
];

const checks = [];
function check(label, run) {
  checks.push([label, run]);
}

function skip(reason) {
  process.stdout.write(`SKIP installed-boundary probe: ${reason}\n`);
  process.exit(0);
}

function resolveInstall() {
  for (const root of DIST_CANDIDATES) {
    if (fs.existsSync(path.join(root, "dist"))) return root;
  }
  return undefined;
}

const root = resolveInstall();
if (root === undefined) skip("no installed OpenClaw found");
const dist = path.join(root, "dist");

let version;
try {
  version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
} catch {
  skip("installed OpenClaw package.json is unreadable");
}
if (version !== EXPECTED_VERSION) {
  skip(`installed OpenClaw is ${version}, not the pinned ${EXPECTED_VERSION}`);
}

// Find the one bundle whose source contains a signature, so hashed rebuild
// filenames never matter.
function findBundle(signature) {
  const matches = fs.readdirSync(dist)
    .filter((entry) => entry.endsWith(".js"))
    .map((entry) => path.join(dist, entry))
    .filter((file) => fs.readFileSync(file, "utf8").includes(signature));
  return matches.length === 1 ? matches[0] : undefined;
}

const cronToolBundle = findBundle("function capCronJobToolsAllow(");
const toolResultsBundle = findBundle("function jsonResult(");
const toolsBundle = findBundle("openclaw-tools:core-tool-list");
const cronGatewayBundle = findBundle('"cron.remove": async (');
const cronParamsBundle = findBundle("const CronAddParamsSchema = closedObject({");
const pacingBundle = findBundle("function normalizeCronJobInput(");
const readViewBundle = findBundle("function cronJobReadView(");
if (cronToolBundle === undefined || toolResultsBundle === undefined ||
    toolsBundle === undefined || cronGatewayBundle === undefined ||
    cronParamsBundle === undefined || pacingBundle === undefined ||
    readViewBundle === undefined) {
  skip("installed bundle layout no longer matches the probed signatures");
}

const cronToolSource = fs.readFileSync(cronToolBundle, "utf8");
const toolsSource = fs.readFileSync(toolsBundle, "utf8");
const cronGatewaySource = fs.readFileSync(cronGatewayBundle, "utf8");
const cronParamsSource = fs.readFileSync(cronParamsBundle, "utf8");
const readViewSource = fs.readFileSync(readViewBundle, "utf8");

// Lift the real allowlist-capping functions out of the installed bundle and run
// them against the installed policy helpers. Nothing here is a transcription:
// the executed bytes are the installed ones.
function loadInstalledToolsAllowCap() {
  const lift = (name) => {
    const start = cronToolSource.indexOf(`function ${name}(`);
    if (start < 0) return undefined;
    const end = cronToolSource.indexOf("\n}\n", start);
    return end < 0 ? undefined : cronToolSource.slice(start, end + 3);
  };
  const lifted = [
    "normalizeCronToolsAllow",
    "normalizeCronCreatorToolsAllow",
    "hasCronTriggerScript",
    "capCronJobToolsAllow",
  ].map(lift);
  if (lifted.some((body) => body === undefined)) return undefined;
  // Reuse the cron-tool bundle's own import statements rather than guessing
  // which sibling bundle provides each helper: that binds the lifted code to
  // exactly the modules the installed bundle itself resolves.
  const needed = new Set([
    "isRecord", "expandToolGroups", "normalizeToolPolicyName",
    "createToolPolicyMatcher", "expandPolicyWithPluginGroups", "buildPluginToolGroups",
  ]);
  const imports = [];
  const found = new Set();
  for (const line of cronToolSource.split("\n")) {
    if (!line.startsWith("import ")) {
      if (line.startsWith("function ")) break;
      continue;
    }
    const match = /^import (\{[^}]*\}) from "(\.\/[^"]+)";$/u.exec(line);
    if (match === null) continue;
    const bound = [...match[1].matchAll(/as (\w+)/gu)].map((entry) => entry[1]);
    const wanted = bound.filter((name) => needed.has(name));
    if (wanted.length === 0) continue;
    const target = path.join(dist, match[2].slice(2));
    if (!fs.existsSync(target)) return undefined;
    wanted.forEach((name) => found.add(name));
    imports.push(`import ${match[1]} from ${JSON.stringify(pathToFileURL(target).href)};`);
  }
  if (found.size !== needed.size) return undefined;
  return `${imports.join("\n")}\n${lifted.join("\n")}\nexport { capCronJobToolsAllow };\n`;
}

const liftedSource = loadInstalledToolsAllowCap();
if (liftedSource === undefined) {
  skip("installed allowlist-capping helpers no longer match the probed signatures");
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "acp-boundary-probe-"));
const liftedFile = path.join(scratch, "installed-tools-allow-cap.mjs");
fs.writeFileSync(liftedFile, liftedSource);
let capCronJobToolsAllow;
try {
  ({ capCronJobToolsAllow } = await import(pathToFileURL(liftedFile).href));
} catch {
  fs.rmSync(scratch, { recursive: true, force: true });
  skip("installed allowlist-capping helpers could not be executed in isolation");
}

const { t: jsonResult } = await import(pathToFileURL(toolResultsBundle).href);

// The creator tool surface the armed controller run really has: the two core
// tools in the order installed OpenClaw builds them, then the appended plugin
// tool. Derived rather than assumed — the ordering claim is asserted below.
const CREATOR_TOOL_SURFACE = [
  { name: "automations" },
  { name: "message" },
  { name: "acp_report_controller", pluginId: "acp-discord-orchestrator" },
];

// The exact order the installed boundary stores, computed by the installed code.
function storedToolsAllowFor(requested) {
  const payload = { kind: "script", script: "return;", toolsAllow: [...requested] };
  capCronJobToolsAllow({ payload, creatorToolAllowlist: CREATOR_TOOL_SURFACE });
  return payload.toolsAllow;
}

check("installed cap rewrites the canonical request into creator-surface order", () => {
  const requested = [...ACP_REPORT_CONTROLLER_TOOLS_ALLOW];
  const stored = storedToolsAllowFor(requested);
  // Same authority, different order: this is precisely what an order-sensitive
  // attestation would have rejected, making a production arm impossible.
  assert.deepEqual([...stored].sort(), [...requested].sort());
  assert.notDeepEqual(stored, requested);
  assert.deepEqual(stored, ["automations", "message", "acp_report_controller"]);
  return `requested ${requested.join(",")} -> stored ${stored.join(",")}`;
});

check("installed cap normalizes every request order to the same stored order", () => {
  const permutations = permute([...ACP_REPORT_CONTROLLER_TOOLS_ALLOW]);
  assert.equal(permutations.length, 6);
  for (const requested of permutations) {
    assert.deepEqual(storedToolsAllowFor(requested), ["automations", "message", "acp_report_controller"],
      requested.join(","));
  }
  // Order genuinely carries no authority at this boundary: it is a pure
  // function of the creator surface, so attesting it as a set loses nothing.
  return "all 6 request orders collapse to one stored order";
});

check("installed cap still refuses to widen authority beyond the request", () => {
  const stored = storedToolsAllowFor(["message"]);
  assert.deepEqual(stored, ["message"]);
  // A wildcard request is the one shape that escalates to the whole surface,
  // which is exactly why the shipped attestation rejects `*` outright.
  const widened = { kind: "script", script: "return;", toolsAllow: ["*"] };
  capCronJobToolsAllow({ payload: widened, creatorToolAllowlist: CREATOR_TOOL_SURFACE });
  assert.deepEqual(widened.toolsAllow, ["automations", "message", "acp_report_controller"]);
  assert.equal(widened.toolsAllowIsDefault, true);
  return "finite requests stay capped; only `*` escalates";
});

check("installed cap derives stored order from the creator surface, not the request", () => {
  // The single line that makes stored order a projection of the creator surface.
  assert.equal(cronToolSource.includes(
    "params.payload.toolsAllow = creatorToolsAllow.filter((tool) => matches(tool.name) || tool.aliasName !== void 0 && matches(tool.aliasName)).map((tool) => tool.name);",
  ), true);
  return "creator-surface projection line present";
});

check("installed core tool surface builds automations before message, plugins last", () => {
  const cronAt = toolsSource.indexOf("createCronTool({");
  const messageAt = toolsSource.indexOf("...messageTool && includeMessageTool ? [messageTool] : [],");
  const coreListAt = toolsSource.indexOf('recordToolPrepStage?.("openclaw-tools:core-tool-list")');
  const pluginAt = toolsSource.indexOf("allTools = [...tools, ...resolveOpenClawPluginToolsForOptions({");
  for (const [label, index] of [["cron", cronAt], ["message", messageAt],
    ["core list", coreListAt], ["plugin append", pluginAt]]) {
    assert.notEqual(index, -1, label);
  }
  assert.equal(cronAt < messageAt, true, "automations must precede message");
  assert.equal(messageAt < coreListAt, true, "message must be inside the core list");
  assert.equal(coreListAt < pluginAt, true, "plugin tools must be appended after core");
  return "automations < message < core-list < plugin append";
});

check("the shipped arm request still carries the canonical pinned order", () => {
  const call = buildReportControllerArmUpdateCall(JOB_ID, TOKEN);
  assert.deepEqual(call.job.payload.toolsAllow, [...ACP_REPORT_CONTROLLER_TOOLS_ALLOW]);
  return `request order ${call.job.payload.toolsAllow.join(",")}`;
});

check("the real stored read view arms and reaches bind and start", async () => {
  const stored = storedToolsAllowFor([...ACP_REPORT_CONTROLLER_TOOLS_ALLOW]);
  const events = [];
  const result = await runReportControllerPreparation(makeInput(), makeDependencies(events, {
    async armAutomation(call) {
      events.push(["arm", call]);
      // The update read view installed OpenClaw really answers with, carrying
      // the allowlist exactly as the installed cap stored it.
      return armedReadView(call.job.payload.script, stored);
    },
  }));
  assert.deepEqual(events.map(([name]) => name), [
    "create", "arm", "bind", "start", "assemble", "prepare", "register", "activate", "commit",
  ]);
  assert.equal(result.controllerStatus, "active");
  return `armed on stored order ${stored.join(",")}`;
});

check("installed cron.add schema is closed and reserves no caller id", () => {
  // The reason preparation must create a placeholder and then arm it: there is
  // no `id`/`jobId` on the add schema, so identity cannot be reserved.
  const start = cronParamsSource.indexOf("const CronAddParamsSchema = closedObject({");
  assert.notEqual(start, -1);
  const block = cronParamsSource.slice(start, cronParamsSource.indexOf("\n});", start));
  for (const key of ["id:", "jobId:"]) assert.equal(block.includes(key), false, key);
  assert.equal(block.includes("declarationKey: Type.Optional("), true);
  return "no reservable identity on cron.add";
});

check("installed create normalization keeps the placeholder disabled and inert", async () => {
  const { r: normalizeCronJobCreate } = await import(pathToFileURL(pacingBundle).href);
  const add = buildReportControllerPlaceholderAddCall(DECLARATION_KEY);
  const normalized = normalizeCronJobCreate(add.job, { sessionContext: { sessionKey: "agent:main" } });
  // An explicit `enabled: false` survives create normalization, so the
  // placeholder can never be silently enabled before it is armed.
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.sessionTarget, "isolated");
  assert.equal(Object.hasOwn(normalized, "id"), false);
  assert.equal(Object.hasOwn(normalized, "jobId"), false);
  // `sessionKey` is injected only for non-isolated targets, which is why the
  // armed attestation can treat any `sessionKey` as routing drift.
  assert.equal(Object.hasOwn(normalized, "sessionKey"), false);
  // `wakeMode` is defaulted by the tool layer, so omitting it is safe; it is
  // inert bookkeeping that changes no run, tool, or route.
  assert.equal(normalized.wakeMode, "now");
  assert.deepEqual(Object.keys(normalized.payload).sort(),
    ["kind", "script", "timeoutSeconds", "toolBudget", "toolsAllow"].sort());
  return "disabled, isolated, identity-free, payload exact";
});

check("installed patch normalization preserves the exact armed payload", async () => {
  const { a: normalizeCronJobPatch } = await import(pathToFileURL(pacingBundle).href);
  const arm = buildReportControllerArmUpdateCall(JOB_ID, TOKEN);
  const normalized = normalizeCronJobPatch(arm.job);
  assert.equal(normalized.enabled, true);
  // The script-kind normalizer only deletes foreign payload keys and trims the
  // script; the pinned script is trim-stable, so the stored script is exactly
  // the substituted one the arm attestation compares against.
  assert.equal(normalized.payload.script, arm.job.payload.script);
  assert.deepEqual(Object.keys(normalized.payload).sort(),
    ["kind", "script", "timeoutSeconds", "toolBudget", "toolsAllow"].sort());
  return "armed payload survives normalization byte-for-byte";
});

check("installed cron.update answers with the complete persisted read view", () => {
  // Why no separate read-back call is needed or made.
  assert.equal(cronGatewaySource.includes('context.logGateway.info("cron: job updated", { jobId });'), true);
  assert.equal(cronGatewaySource.includes("respond(true, cronJobReadView(job), void 0);"), true);
  const start = readViewSource.indexOf("function cronJobReadView(");
  assert.notEqual(start, -1);
  const block = readViewSource.slice(start, readViewSource.indexOf("\n}\n", start));
  // The read view is the public job plus inert bookkeeping only, which is why
  // the attestation pins the contract fields and tolerates the rest.
  assert.equal(block.includes("...toPublicCronJob(job)"), true);
  assert.equal(block.includes("nextRunAtMs: job.state.nextRunAtMs"), true);
  return "update result is the persisted job plus inert bookkeeping";
});

check("installed remove envelope carries removed only under details", () => {
  // The gateway responds with the cron store's own result object...
  assert.equal(cronGatewaySource.includes("if (!result.removed) {"), true);
  assert.equal(cronGatewaySource.includes('context.logGateway.info("cron: job removed", { jobId });'), true);
  assert.equal(cronGatewaySource.includes("respond(true, result, void 0);"), true);
  // ...and the cron tool wraps that payload with jsonResult before the model
  // ever sees it, which is where the top-level `removed` disappears.
  assert.equal(cronToolSource.includes('return jsonResult(await callGateway("cron.remove", gatewayOpts, { id }));'), true);
  const envelope = jsonResult({ removed: true });
  assert.deepEqual(Object.keys(envelope).sort(), ["content", "details"]);
  assert.equal(Object.hasOwn(envelope, "removed"), false);
  assert.equal(envelope.removed, undefined);
  assert.deepEqual(envelope.details, { removed: true });
  return "model sees { content, details: { removed: true } }";
});

check("the real remove envelope proves removal and reaches the transport abort", async () => {
  const envelope = jsonResult({ removed: true });
  const events = [];
  const input = makeInput();
  // Fail registration construction so rollback runs with prepared transport
  // that was never registered.
  input.destination = { channel: "discord", accountId: "account-example", conversationId: {} };
  await assert.rejects(
    runReportControllerPreparation(input, makeDependencies(events, {
      async removeAutomation(value) { events.push(["remove", value]); return envelope; },
    })),
    (error) => error.code === "report_controller_registration_invalid",
  );
  assert.deepEqual(events.map(([name]) => name), [
    "create", "arm", "bind", "start", "assemble", "prepare", "remove", "abort-transport",
  ]);
  assert.deepEqual(events.at(-1)[1], {
    transportFile: "/private/transport.json",
    processHandle: "handle-1",
  });
  return "remove -> abort ordering holds on the real envelope";
});

check("a real not-found remove envelope never aborts the prepared transport", async () => {
  // cron.remove answers a missing job through the error path, so a `removed`
  // that is present and false is the store saying it removed nothing.
  const envelope = jsonResult({ removed: false });
  const events = [];
  await assert.rejects(
    runReportControllerPreparation(makeInput(), makeDependencies(events, {
      async prepare(value) { events.push(["prepare", value]); throw new Error("synthetic private failure"); },
      async removeAutomation(value) { events.push(["remove", value]); return envelope; },
    })),
    (error) => error.code === "report_controller_pre_activation_cleanup_failed",
  );
  assert.equal(events.some(([name]) => name.startsWith("abort")), false);
  return "unproven removal fails closed without aborting";
});

// ---------------------------------------------------------------------------

const UUID = "11111111-2222-3333-4444-555555555555";
const DECLARATION_KEY = `acp-report-controller-${UUID}`;
const JOB_ID = "9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f";
const TOKEN = `acplease${Buffer.alloc(32, 0xab).toString("base64url")}`;

function permute(values) {
  if (values.length === 0) return [[]];
  return values.flatMap((entry, index) => permute(
    [...values.slice(0, index), ...values.slice(index + 1)],
  ).map((rest) => [entry, ...rest]));
}

function makeInput() {
  return {
    roundIndex: 2,
    destination: { channel: "discord", accountId: "account-example", conversationId: "123456789012345678" },
    reportPumpEntry: "/trusted/acp-report-pump.mjs",
    hostTransportEntry: "/trusted/acp-host-transport.mjs",
    snapshotFile: "/private/report-pump-snapshot.json",
  };
}

function armedReadView(script, toolsAllow) {
  return {
    details: {
      id: JOB_ID,
      declarationKey: DECLARATION_KEY,
      name: "ACP report controller",
      enabled: true,
      sessionTarget: "isolated",
      deleteAfterRun: false,
      schedule: { kind: "every", everyMs: 600000, anchorMs: 1756900000000 },
      payload: { kind: "script", script, timeoutSeconds: 60, toolBudget: 5, toolsAllow: [...toolsAllow] },
      delivery: { mode: "none" },
      createdAtMs: 1756890000000,
      updatedAtMs: 1756900000000,
      configRevision: "rev-1",
      nextRunAtMs: 1756900600000,
      state: {},
    },
  };
}

function makeDependencies(events, overrides = {}) {
  return {
    randomBytes: () => Buffer.alloc(32, 0xab),
    randomUUID: () => UUID,
    async createAutomation(call) {
      events.push(["create", call]);
      return { details: { created: true, job: { id: JOB_ID, declarationKey: DECLARATION_KEY, enabled: false } } };
    },
    async armAutomation(call) {
      events.push(["arm", call]);
      return armedReadView(call.job.payload.script, storedToolsAllowFor([...ACP_REPORT_CONTROLLER_TOOLS_ALLOW]));
    },
    async bindReporting(value) { events.push(["bind", value]); return { config: "bound" }; },
    async sendStartReceipt(value) { events.push(["start", value]); return { messageId: "receipt" }; },
    async assemble(value) { events.push(["assemble", value]); return { configFile: "/private/assembled.json" }; },
    async prepare(value) { events.push(["prepare", value]); return { transportFile: "/private/transport.json", processHandle: "handle-1" }; },
    async registerController(value) { events.push(["register", value]); return { details: { status: "prepared" } }; },
    async activate(value) { events.push(["activate", value]); return { type: "host_transport_activated" }; },
    async commitController(value) { events.push(["commit", value]); return { details: { status: "active" } }; },
    async removeAutomation(value) { events.push(["remove", value]); return jsonResult({ removed: true }); },
    async abortController(value) { events.push(["abort", value]); return { details: { status: "aborted" } }; },
    async abortTransport(value) { events.push(["abort-transport", value]); return { type: "host_transport_preactivation_aborted" }; },
    async retainRecovery(value) { events.push(["retain", value]); return { status: "retained" }; },
    ...overrides,
  };
}

let failed = 0;
process.stdout.write(`installed-boundary probe: OpenClaw ${version} at ${root}\n`);
for (const [label, run] of checks) {
  try {
    const note = await run();
    process.stdout.write(`  ok   ${label}${note ? ` — ${note}` : ""}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL ${label}: ${error.message}\n`);
  }
}
fs.rmSync(scratch, { recursive: true, force: true });
process.stdout.write(`installed-boundary probe: ${checks.length - failed}/${checks.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
