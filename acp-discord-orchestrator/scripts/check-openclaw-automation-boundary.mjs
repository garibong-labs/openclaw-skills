#!/usr/bin/env node
// Installed-boundary evidence probe for the ACP report controller.
//
// The checked-in node:test suites run anywhere and therefore mock the
// model-callable `automations` boundary. Three real behaviours of installed
// OpenClaw are invisible to those mocks unless something reads the real thing:
//
//   1. `capCronJobToolsAllow` does not persist the requested allowlist order.
//      It rewrites a finite requested allowlist as
//      `creatorToolsAllow.filter(matches).map((tool) => tool.name)`, so the
//      stored array comes back in the creator's final executable tool-surface
//      order, where core `automations` precedes core `message` and plugin tools
//      are appended last.
//   2. Headless script jobs run as `agent:main:cron:<jobId>:trigger`, not the
//      agent-turn `cron:<jobId>[:run:<runId>]` shape.
//   3. `cron.remove` answers with the cron store's own `{ removed: true }`
//      result, and the cron tool wraps it with `jsonResult(...)`. The
//      model-visible envelope is therefore `{ content, details: { removed } }`
//      and carries no top-level `removed` at all.
//
// This probe executes all three against the installed bundles — not against a
// transcription of them — and then drives the shipped preparation helper with
// exactly what they produce. It is deliberately not a node:test file: it needs
// a local OpenClaw install, so it is run and reported separately from the
// portable suites. SKIP is reserved for the absence of an exact supported
// installation. Once that package is found, discovery, lifting, import,
// closed-schema, and behavioural drift are failures, never skips.
//
// Bundles are located by content signature, never by their hashed filenames and
// never by hashing a whole bundle, so an unrelated OpenClaw rebuild does not
// break the probe while a change to the pinned behaviour still does.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS,
  ACP_REPORT_CONTROLLER_TOOLS_ALLOW,
} from "./acp-reporting-contract.mjs";
import {
  buildReportControllerArmUpdateCall,
  buildReportControllerPlaceholderAddCall,
  runReportControllerPreparation,
} from "./acp-report-controller-preparation.mjs";

const EXPECTED_VERSION = "2026.8.1";
const DEFAULT_DIST_CANDIDATES = [
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

function failProbe(code) {
  process.stdout.write(`FAIL installed-boundary probe: ${code}\n`);
  process.exit(1);
}

const requestedRoot = process.argv.length === 3 ? path.resolve(process.argv[2]) : undefined;
if (process.argv.length > 3) failProbe("invalid_arguments");
const DIST_CANDIDATES = requestedRoot === undefined ? DEFAULT_DIST_CANDIDATES : [requestedRoot];

function resolveInstall() {
  for (const root of DIST_CANDIDATES) {
    if (!fs.existsSync(root)) continue;
    let candidateVersion;
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      if (metadata.name !== "openclaw") continue;
      candidateVersion = metadata.version;
    } catch {
      failProbe("package_metadata_unreadable");
    }
    if (candidateVersion !== EXPECTED_VERSION) continue;
    if (!fs.existsSync(path.join(root, "dist"))) failProbe("supported_dist_missing");
    return root;
  }
  return undefined;
}

const root = resolveInstall();
if (root === undefined) skip("no supported OpenClaw installation found");
const dist = path.join(root, "dist");

const version = EXPECTED_VERSION;

// Find the one bundle whose source contains a signature, so hashed rebuild
// filenames never matter.
function findBundle(signature) {
  let entries;
  try {
    entries = fs.readdirSync(dist);
  } catch {
    failProbe("supported_dist_unreadable");
  }
  const matches = entries.filter((entry) => entry.endsWith(".js"))
    .map((entry) => path.join(dist, entry))
    .filter((file) => {
      try {
        return fs.readFileSync(file, "utf8").includes(signature);
      } catch {
        failProbe("bundle_unreadable");
      }
    });
  if (matches.length === 0) failProbe("bundle_signature_missing");
  if (matches.length !== 1) failProbe("bundle_signature_ambiguous");
  return matches[0];
}

const cronToolBundle = findBundle("function capCronJobToolsAllow(");
const toolResultsBundle = findBundle("function jsonResult(");
const toolsBundle = findBundle("openclaw-tools:core-tool-list");
const cronGatewayBundle = findBundle('"cron.remove": async (');
const cronParamsBundle = findBundle("const CronAddParamsSchema = closedObject({");
const pacingBundle = findBundle("function normalizeCronJobInput(");
const readViewBundle = findBundle("function cronJobReadView(");
const serverCronBundle = findBundle("async function prepareTriggerRuntime(");

function readBundle(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    failProbe("bundle_unreadable");
  }
}

const cronToolSource = readBundle(cronToolBundle);
const toolsSource = readBundle(toolsBundle);
const cronGatewaySource = readBundle(cronGatewayBundle);
const cronParamsSource = readBundle(cronParamsBundle);
const readViewSource = readBundle(readViewBundle);
const serverCronSource = readBundle(serverCronBundle);

const cronSessionKeyImport = /import \{ ([A-Za-z_$][\w$]*) as resolveCronAgentSessionKey \} from "(\.\/[^"]+)";/u
  .exec(serverCronSource);
if (cronSessionKeyImport === null) failProbe("cron_session_key_import_missing");
const cronSessionKeyModule = path.join(dist, cronSessionKeyImport[2].slice(2));
if (!fs.existsSync(cronSessionKeyModule)) failProbe("cron_session_key_module_missing");
let resolveCronAgentSessionKey;
try {
  const imported = await import(pathToFileURL(cronSessionKeyModule).href);
  resolveCronAgentSessionKey = imported[cronSessionKeyImport[1]];
  if (typeof resolveCronAgentSessionKey !== "function") failProbe("cron_session_key_export_invalid");
} catch {
  failProbe("cron_session_key_import_failed");
}

function liftUniqueFunction(source, name) {
  const marker = `function ${name}(`;
  const first = source.indexOf(marker);
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) return undefined;
  const end = source.indexOf("\n}\n", first);
  return end < 0 ? undefined : source.slice(first, end + 3);
}

// Lift the real allowlist-capping functions out of the installed bundle and run
// them against the installed policy helpers. Nothing here is a transcription:
// the executed bytes are the installed ones.
function loadInstalledToolsAllowCap() {
  const lifted = [
    "normalizeCronToolsAllow",
    "normalizeCronCreatorToolsAllow",
    "hasCronTriggerScript",
    "capCronJobToolsAllow",
  ].map((name) => liftUniqueFunction(cronToolSource, name));
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
  failProbe("allowlist_helper_lift_failed");
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "acp-boundary-probe-"));
const liftedFile = path.join(scratch, "installed-tools-allow-cap.mjs");
fs.writeFileSync(liftedFile, liftedSource);
let capCronJobToolsAllow;
try {
  ({ capCronJobToolsAllow } = await import(pathToFileURL(liftedFile).href));
} catch {
  fs.rmSync(scratch, { recursive: true, force: true });
  failProbe("allowlist_helper_import_failed");
}

let jsonResult;
try {
  ({ t: jsonResult } = await import(pathToFileURL(toolResultsBundle).href));
  if (typeof jsonResult !== "function") failProbe("json_result_export_invalid");
} catch {
  fs.rmSync(scratch, { recursive: true, force: true });
  failProbe("json_result_import_failed");
}

function loadInstalledReadView() {
  const body = liftUniqueFunction(readViewSource, "cronJobReadView");
  if (body === undefined) return undefined;
  const aliases = ["toPublicCronJob", "resolveCronJobConfigRevision"];
  const imports = [];
  for (const alias of aliases) {
    const matching = readViewSource.split("\n").filter((line) =>
      line.startsWith("import ") && new RegExp(`(?:\\bas ${alias}\\b|\\b${alias}\\b)`, "u").test(line));
    if (matching.length !== 1) return undefined;
    const match = /^import (.+) from "(\.\/[^"]+)";$/u.exec(matching[0]);
    if (match === null) return undefined;
    const target = path.join(dist, match[2].slice(2));
    if (!fs.existsSync(target)) return undefined;
    imports.push(`import ${match[1]} from ${JSON.stringify(pathToFileURL(target).href)};`);
  }
  return `${imports.join("\n")}\n${body}\nexport { cronJobReadView };\n`;
}

const readViewLiftedSource = loadInstalledReadView();
if (readViewLiftedSource === undefined) failProbe("read_view_helper_lift_failed");
const readViewLiftedFile = path.join(scratch, "installed-cron-read-view.mjs");
fs.writeFileSync(readViewLiftedFile, readViewLiftedSource);
let cronJobReadView;
try {
  ({ cronJobReadView } = await import(pathToFileURL(readViewLiftedFile).href));
  if (typeof cronJobReadView !== "function") failProbe("read_view_export_invalid");
} catch {
  fs.rmSync(scratch, { recursive: true, force: true });
  failProbe("read_view_helper_import_failed");
}

let validateCronAddParams;
try {
  ({ st: validateCronAddParams } = await import(pathToFileURL(cronParamsBundle).href));
  if (typeof validateCronAddParams !== "function") failProbe("cron_add_schema_export_invalid");
} catch {
  fs.rmSync(scratch, { recursive: true, force: true });
  failProbe("cron_add_schema_import_failed");
}

let normalizeCronJobCreate;
let normalizeCronJobPatch;
try {
  ({ r: normalizeCronJobCreate, a: normalizeCronJobPatch } =
    await import(pathToFileURL(pacingBundle).href));
  if (typeof normalizeCronJobCreate !== "function" || typeof normalizeCronJobPatch !== "function") {
    failProbe("cron_normalizer_export_invalid");
  }
} catch {
  fs.rmSync(scratch, { recursive: true, force: true });
  failProbe("cron_normalizer_import_failed");
}

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

check("installed script jobs run under the :trigger cron session shape", () => {
  assert.equal(serverCronSource.includes('sessionKey: `cron:${params.jobId}:trigger`,'), true);
  const sessionKey = resolveCronAgentSessionKey({
    sessionKey: `cron:${JOB_ID}:trigger`,
    agentId: "main",
    mainKey: "main",
    cfg: {},
  });
  assert.equal(sessionKey, `agent:main:cron:${JOB_ID}:trigger`);
  return sessionKey;
});

check("the real stored read view arms and reaches bind and start", async () => {
  const stored = storedToolsAllowFor([...ACP_REPORT_CONTROLLER_TOOLS_ALLOW]);
  const add = buildReportControllerPlaceholderAddCall(DECLARATION_KEY);
  const normalized = normalizeCronJobCreate(add.job, { sessionContext: { sessionKey: "agent:main" } });
  const arm = buildReportControllerArmUpdateCall(JOB_ID, TOKEN);
  const persisted = {
    ...normalized,
    id: JOB_ID,
    declarationKey: DECLARATION_KEY,
    enabled: true,
    deleteAfterRun: false,
    payload: { ...arm.job.payload, toolsAllow: stored },
    createdAtMs: 1756890000000,
    updatedAtMs: 1756900000000,
    state: { nextRunAtMs: 1756900020000 },
  };
  const installedReadView = cronJobReadView(persisted);
  const events = [];
  const result = await runReportControllerPreparation(makeInput(), makeDependencies(events, {
    async armAutomation(call) {
      events.push(["arm", call]);
      // Execute the installed persisted-read-view helper over the normalized
      // stored job; a handwritten successful fixture cannot substitute here.
      return { details: installedReadView };
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
  const add = buildReportControllerPlaceholderAddCall(DECLARATION_KEY);
  const normalized = normalizeCronJobCreate(add.job, { sessionContext: { sessionKey: "agent:main" } });
  assert.equal(validateCronAddParams(normalized), true, JSON.stringify(validateCronAddParams.errors));
  assert.equal(validateCronAddParams({ ...normalized, id: JOB_ID }), false);
  assert.equal(validateCronAddParams({ ...normalized, jobId: JOB_ID }), false);
  assert.equal(validateCronAddParams({ ...normalized, unexpected: true }), false);
  return "installed closed validator accepts exact input and rejects id/jobId/unknown";
});

check("installed create normalization keeps the placeholder disabled and inert", async () => {
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
  const add = buildReportControllerPlaceholderAddCall(DECLARATION_KEY);
  const normalized = normalizeCronJobCreate(add.job, { sessionContext: { sessionKey: "agent:main" } });
  const view = cronJobReadView({
    ...normalized, id: JOB_ID, createdAtMs: 1, updatedAtMs: 2,
    state: { nextRunAtMs: 3, queuedAtMs: 4 },
    createdActor: { private: true }, toolsAllowProvenance: { private: true },
  });
  assert.equal(view.id, JOB_ID);
  assert.equal(view.nextRunAtMs, 3);
  assert.equal(view.state.queuedAtMs, undefined);
  assert.equal(Object.hasOwn(view, "createdActor"), false);
  assert.equal(Object.hasOwn(view, "toolsAllowProvenance"), false);
  assert.match(view.configRevision, /^sha256:[A-Za-z0-9_-]+$/u);
  return "executed installed read view strips private state and derives revision";
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
      schedule: { kind: "every", everyMs: ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS, anchorMs: 1756890000000 },
      payload: { kind: "script", script, timeoutSeconds: 60, toolBudget: 5, toolsAllow: [...toolsAllow] },
      delivery: { mode: "none" },
      createdAtMs: 1756890000000,
      updatedAtMs: 1756900000000,
      configRevision: "rev-1",
      nextRunAtMs: 1756900020000,
      state: {},
    },
  };
}

function makeDependencies(events, overrides = {}) {
  return {
    randomBytes: () => Buffer.alloc(32, 0xab),
    randomUUID: () => UUID,
    async inspectLifecycleGuard() {
      return {
        plugin: {
          id: "acp-lifecycle-guard",
          version: "0.6.4",
          enabled: true,
          activated: true,
          status: "loaded",
          contracts: {
            tools: ["acp_report_controller"],
            trustedToolPolicies: ["acp-report-controller-lifecycle-v1"],
          },
        },
      };
    },
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
  } catch {
    failed += 1;
    // Labels are fixed probe source; installed exception text can contain
    // paths or otherwise unbounded data and is never emitted.
    process.stdout.write(`  FAIL ${label}\n`);
  }
}
fs.rmSync(scratch, { recursive: true, force: true });
process.stdout.write(`installed-boundary probe: ${checks.length - failed}/${checks.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
