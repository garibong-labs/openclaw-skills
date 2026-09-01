import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ACP_AGENT_PRESENTATIONS,
  ACP_BASELINE_ENV_CONTRACT,
  ACP_INJECTION_ENV,
  ACP_SUPPORTED_AGENTS,
  ACPX_UNSUPPORTED_CONTROL_ERROR_CODE,
  ACP_HOST_ACTIVATION_SCHEMA_VERSION,
  CLAUDE_AUTH_KIND,
  CLAUDE_FORBIDDEN_ENV,
  CLAUDE_IMPLICIT_ENV_CONTRACT,
  CLAUDE_INJECTION_ENV,
  CLAUDE_OAUTH_TOKEN_ENV,
  CLAUDE_PROVIDER_INJECTION_ENV,
  CODEX_DEFAULT_MODEL,
  CODEX_DEFAULT_MODEL_IDENTITY,
  CODEX_DEFAULT_REASONING_EFFORT,
  CODEX_IMPLICIT_ENV_CONTRACT,
  CODEX_MODEL_CONFIG_KEY,
  CODEX_PATH_ENV,
  CODEX_REASONING_CONFIG_KEY,
  DEFAULT_HOST_ACTIVATION_TIMEOUT_MS,
  EXIT_CODES,
  assertCanonicalSupportedAgent,
  buildPermissionHandler,
  classifyPermissionRequest,
  containsDetachedShell,
  containsRemoteVcsAction,
  discoverRuntimeLocation,
  isClaudeAgent,
  isCliEntry,
  isCodexAgent,
  isUnsupportedSessionCloseCleanupError,
  loadSupervisorConfig,
  main,
  normalizeRuntimeEvent,
  parseHostActivationLine,
  reconcileLifecycleLedger,
  resolveConfiguredModel,
  resolveConfiguredReasoningEffort,
  modelReportingIdentity,
  runClaudeSupervisorPreflight,
  runCodexSupervisorPreflight,
  runReportingPreflight,
  runStartReceiptPreflight,
  runSupervisor,
  waitForHostActivation,
  validateClaudeAuthEnvFile,
  validateCodexExecutablePath,
  validateRuntimeModuleExports
} from "./acpx-foreground-supervisor.mjs";
import {
  activateLifecycleLedger,
  createLifecycleLedger,
  loadLifecycleLedger,
  recordLifecycleEvent
} from "./acp-lifecycle-ledger.mjs";
import { buildValidReporting } from "./acp-reporting-test-fixture.mjs";

// Canonical codex runs require the operator-injected CODEX_PATH before any
// runtime surface. Tests that omit the env dependency inherit process.env, so
// the suite injects the contract the way an operator would; the test
// process's own node binary is an absolute, existing, executable regular
// file.
process.env[CODEX_PATH_ENV] = process.execPath;

const CONTROL_CONVERSATION_ID = "100000000000000001";
const START_MESSAGE_ID = "100000000000000002";
// Fixed spelling used by parsed (in-memory) lifecycle fixtures; the reporting
// contract binds by spelling while freshness uses deliveredAtMs, so the two
// are independent in fixtures.
const PARSED_DELIVERED_AT = "2026-08-22T09:30:00.000Z";

function rawLifecycle(overrides = {}, receiptOverrides = {}) {
  return {
    controlConversationId: CONTROL_CONVERSATION_ID,
    maxStartReceiptAgeMs: 300000,
    startReceipt: {
      conversationId: CONTROL_CONVERSATION_ID,
      messageId: START_MESSAGE_ID,
      deliveredAt: new Date().toISOString(),
      ...receiptOverrides
    },
    ...overrides
  };
}

function parsedLifecycle(overrides = {}, receiptOverrides = {}) {
  return {
    controlConversationId: CONTROL_CONVERSATION_ID,
    maxStartReceiptAgeMs: 300000,
    startReceipt: {
      conversationId: CONTROL_CONVERSATION_ID,
      messageId: START_MESSAGE_ID,
      deliveredAt: PARSED_DELIVERED_AT,
      deliveredAtMs: Date.now(),
      ...receiptOverrides
    },
    ...overrides
  };
}

// One reusable reporting bundle (acp-reporting-v2 by default) bound to a raw
// or parsed lifecycle fixture, delegating to the shared integration fixture
// builder. Reads the lifecycle defensively so deliberately malformed
// lifecycle fixtures still serialize (they fail on lifecycle before reporting
// is ever validated).
function validReporting(lifecycle = rawLifecycle(), options = {}) {
  const receipt = (lifecycle && lifecycle.startReceipt) || {};
  const agent = options.agent ?? "codex";
  const model = "model" in options
    ? options.model
    : agent === "codex"
      ? `test-model[${CODEX_DEFAULT_REASONING_EFFORT}]`
      : "test-model";
  return buildValidReporting({
    controlConversationId:
      (lifecycle && lifecycle.controlConversationId) ?? CONTROL_CONVERSATION_ID,
    receiptConversationId: receipt.conversationId ?? CONTROL_CONVERSATION_ID,
    messageId: receipt.messageId ?? START_MESSAGE_ID,
    deliveredAt: receipt.deliveredAt ?? PARSED_DELIVERED_AT,
    agent,
    model,
    ...options
  });
}

// Canonicalizes a (possibly deliberately non-canonical) fixture agent to the
// supported agent its reporting bundle should be prepared for, so tests about
// spelling gates still ship an otherwise-valid bundle.
function reportingAgentFor(agent) {
  const normalized = typeof agent === "string" ? agent.trim().toLowerCase() : "";
  return ["claude", "codex"].includes(normalized) ? normalized : "codex";
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function makeConfig(root, overrides = {}) {
  // Reporting must bind to whatever lifecycle and agent the caller overrides
  // with, so the default bundle is derived from the effective fixtures. The
  // generic (non-Claude) fixture agent is the supported canonical "codex".
  const lifecycle = "lifecycle" in overrides ? overrides.lifecycle : parsedLifecycle();
  const agent = "agent" in overrides ? overrides.agent : "codex";
  const reportingAgent = reportingAgentFor(agent);
  const configuredModel = "model" in overrides ? overrides.model : "test-model";
  const configuredReasoningEffort = "reasoningEffort" in overrides
    ? overrides.reasoningEffort
    : agent === "codex"
      ? CODEX_DEFAULT_REASONING_EFFORT
      : undefined;
  const fixtureModel = configuredModel === undefined
    ? reportingAgent === "codex"
      ? CODEX_DEFAULT_MODEL
      : "runtime-default"
    : typeof configuredModel === "string"
      ? configuredModel
      : "test-model";
  const fixtureReasoning = typeof configuredReasoningEffort === "string"
    ? configuredReasoningEffort
    : CODEX_DEFAULT_REASONING_EFFORT;
  const reportingModel = reportingAgent === "codex"
    ? `${fixtureModel}[${fixtureReasoning}]`
    : fixtureModel;
  return {
    agent,
    model: configuredModel,
    ...(configuredReasoningEffort === undefined
      ? {}
      : { reasoningEffort: configuredReasoningEffort }),
    cwd: root,
    sessionKey: "test-session",
    promptText: "perform the bounded test task",
    responseFile: path.join(root, "response-" + Math.random().toString(16).slice(2) + ".txt"),
    stateDir: path.join(root, "state"),
    timeoutMs: 30000,
    progressMs: 0,
    allowKinds: new Set(["read", "search", "think", "edit", "execute"]),
    lifecycle,
    reporting: validReporting(lifecycle, { agent: reportingAgent, model: reportingModel }),
    maxResponseBytes: 1024 * 1024,
    runtimeModule: root,
    ...overrides
  };
}

function asyncEvents(events) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    }
  };
}

function makeRuntimeModule(options = {}) {
  const state = {
    runtimeOptions: undefined,
    ensureInput: undefined,
    turnInput: undefined,
    closeInput: undefined,
    closeInputs: [],
    cancelCalls: 0,
    closeStreamCalls: 0,
    streamClosed: false,
    closeAttempts: 0,
    permissionOutcome: undefined,
    configOptionInputs: [],
    operationOrder: []
  };
  const result = options.result || Promise.resolve({ status: "completed", stopReason: "end_turn" });
  const events = options.events || [];
  const eventIterable = options.eventFactory
    ? options.eventFactory(state)
    : asyncEvents(events);
  const module = {
    createRuntimeStore() {
      return {};
    },
    createAgentRegistry() {
      return {};
    },
    createAcpRuntime(runtimeOptions) {
      state.runtimeOptions = runtimeOptions;
      return {
        async probeAvailability() {
          if (options.onProbe) {
            await options.onProbe(state);
          }
        },
        async ensureSession(input) {
          state.ensureInput = input;
          state.operationOrder.push("ensureSession");
          if (options.permissionRequest) {
            state.permissionOutcome = await state.runtimeOptions.onPermissionRequest(
              options.permissionRequest,
              { signal: { aborted: false } }
            );
          }
          return {
            sessionKey: input.sessionKey,
            backend: "acpx",
            runtimeSessionName: "mock",
            cwd: input.cwd
          };
        },
        ...(options.omitSetConfigOption
          ? {}
          : {
              async setConfigOption(input) {
                state.configOptionInputs.push(input);
                state.operationOrder.push(`setConfigOption:${input.key}`);
                if (options.onSetConfigOption) {
                  await options.onSetConfigOption(input, state);
                }
              }
            }),
        startTurn(input) {
          state.turnInput = input;
          state.operationOrder.push("startTurn");
          return {
            requestId: input.requestId,
            events: eventIterable,
            result,
            async cancel() {
              state.cancelCalls += 1;
              if (options.onCancel) {
                await options.onCancel(state);
              }
            },
            async closeStream() {
              state.closeStreamCalls += 1;
              state.streamClosed = true;
            }
          };
        },
        async close(input) {
          state.closeInput = input;
          state.closeInputs.push(input);
          state.closeAttempts += 1;
          if (typeof options.closeError === "function") {
            const error = options.closeError(input, state);
            if (error) {
              throw error;
            }
            return;
          }
          if (options.closeError) {
            throw new Error("private cleanup detail");
          }
        }
      };
    }
  };
  return { module, state };
}

function permissionRequest(rawInput, kind = "execute") {
  return {
    inferredKind: kind,
    raw: {
      toolCall: {
        kind,
        rawInput
      },
      options: []
    }
  };
}

function activationLine(processHandle = "tracked-session-42") {
  return JSON.stringify({
    schemaVersion: ACP_HOST_ACTIVATION_SCHEMA_VERSION,
    processHandle
  }) + "\n";
}

function onlyLifecycleLedger(stateDir) {
  const names = fs.readdirSync(stateDir).filter((name) => name.endsWith(".lifecycle.json"));
  assert.equal(names.length, 1);
  return path.join(stateDir, names[0]);
}

test("host activation parser accepts one exact bounded handle record", () => {
  assert.deepEqual(parseHostActivationLine(activationLine("session-123").trim()), {
    schemaVersion: ACP_HOST_ACTIVATION_SCHEMA_VERSION,
    processHandle: "session-123"
  });
  assert.equal(DEFAULT_HOST_ACTIVATION_TIMEOUT_MS, 60000);
  for (const invalid of [
    "{}",
    JSON.stringify({ schemaVersion: "wrong", processHandle: "session-123" }),
    JSON.stringify({
      schemaVersion: ACP_HOST_ACTIVATION_SCHEMA_VERSION,
      processHandle: "session 123"
    }),
    JSON.stringify({
      schemaVersion: ACP_HOST_ACTIVATION_SCHEMA_VERSION,
      processHandle: "session-123",
      title: "caller-controlled"
    })
  ]) {
    assert.throws(() => parseHostActivationLine(invalid), /activation_invalid/);
  }
});

test("host activation stream fails closed on timeout, EOF, and malformed input", async () => {
  const timeoutInput = new PassThrough();
  await assert.rejects(
    waitForHostActivation(timeoutInput, { timeoutMs: 5 }),
    /activation_timeout/
  );

  const eofInput = new PassThrough();
  const eofResult = waitForHostActivation(eofInput, { timeoutMs: 100 });
  eofInput.end();
  await assert.rejects(eofResult, /activation_eof/);

  const malformedInput = new PassThrough();
  const malformedResult = waitForHostActivation(malformedInput, { timeoutMs: 100 });
  malformedInput.end("not-json\n");
  await assert.rejects(malformedResult, /activation_invalid/);
});

test("runtime mutation waits for activation from the retained host handle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-activation-gate-"));
  const activationInput = new PassThrough();
  const { module, state } = makeRuntimeModule();
  const config = makeConfig(root);
  const emitted = [];
  const run = runSupervisor(config, {
    runtimeModule: module,
    activationInput,
    activationTimeoutMs: 1000,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emitted.at(-1).type, "activation_required");
  assert.equal(state.runtimeOptions, undefined);
  assert.equal(state.ensureInput, undefined);
  assert.equal(state.turnInput, undefined);

  activationInput.end(activationLine());
  assert.equal(await run, EXIT_CODES.completed);
  assert.equal(emitted.some((event) => event.type === "activation_confirmed"), true);
  assert.notEqual(state.runtimeOptions, undefined);
  assert.notEqual(state.ensureInput, undefined);
  assert.notEqual(state.turnInput, undefined);

  const ledgerFile = onlyLifecycleLedger(config.stateDir);
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  assert.equal(ledger.processHandle, "tracked-session-42");
  assert.equal(ledger.state, "terminal_intent");
  assert.equal(ledger.lastEvent.type, "terminal");
  assert.deepEqual(ledger.exitReconciliation, {
    status: "pending",
    expectedExitCode: EXIT_CODES.completed
  });

  const reconciled = reconcileLifecycleLedger({
    ledgerFile,
    processHandle: "tracked-session-42",
    outcome: "exited",
    exitCode: EXIT_CODES.completed,
    nowMs: Date.now()
  });
  assert.equal(reconciled.state, "exit_reconciled");
  assert.equal(reconciled.exitReconciliation.status, "confirmed");
  const verifiedAgain = reconcileLifecycleLedger({
    ledgerFile,
    processHandle: "tracked-session-42",
    outcome: "exited",
    exitCode: EXIT_CODES.completed,
    nowMs: Date.now() + 1
  });
  assert.deepEqual(verifiedAgain.exitReconciliation, reconciled.exitReconciliation);
  assert.throws(() => reconcileLifecycleLedger({
    ledgerFile,
    processHandle: "tracked-session-42",
    outcome: "exited",
    exitCode: EXIT_CODES.failed
  }), /lifecycle_exit_code_mismatch/);
});

test("missing activation exits before runtime access with a terminal ledger intent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-activation-eof-"));
  const activationInput = new PassThrough();
  const { module, state } = makeRuntimeModule();
  const config = makeConfig(root);
  const emitted = [];
  const run = runSupervisor(config, {
    runtimeModule: module,
    activationInput,
    activationTimeoutMs: 100,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  activationInput.end();

  assert.equal(await run, EXIT_CODES.supervisorError);
  assert.equal(state.runtimeOptions, undefined);
  assert.equal(emitted.at(-1).type, "supervisor_error");
  assert.equal(emitted.at(-1).code, "activation_eof");
  const ledgerFile = onlyLifecycleLedger(config.stateDir);
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  assert.equal(ledger.state, "terminal_intent");
  assert.equal(ledger.terminalIntent.code, "activation_eof");
  assert.equal(ledger.exitReconciliation.expectedExitCode, EXIT_CODES.supervisorError);
  assert.equal(loadLifecycleLedger(ledgerFile).document.processHandle, null);

  const reconciled = reconcileLifecycleLedger({
    ledgerFile,
    processHandle: null,
    outcome: "exited",
    exitCode: EXIT_CODES.supervisorError,
    nowMs: Date.now()
  });
  assert.equal(reconciled.state, "exit_reconciled");
  assert.equal(reconciled.processHandle, null);
  assert.equal(reconciled.activatedAt, null);
  assert.equal(reconciled.exitReconciliation.status, "confirmed");
});

test("pre-activation exit reconciliation rejects invented handles and tracking loss", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-pre-activation-exit-"));
  if (process.platform !== "win32") {
    fs.chmodSync(stateDir, 0o700);
  }
  const writer = createLifecycleLedger({
    stateDir,
    runId: "run-pre-activation",
    requestId: "request-pre-activation",
    nowMs: Date.now()
  });
  recordLifecycleEvent(writer, {
    type: "supervisor_error",
    code: "activation_timeout",
    sequence: 2,
    timestamp: new Date().toISOString()
  }, {
    force: true,
    expectedExitCode: EXIT_CODES.supervisorError
  });

  assert.throws(() => reconcileLifecycleLedger({
    ledgerFile: writer.filePath,
    processHandle: "invented-handle",
    outcome: "exited",
    exitCode: EXIT_CODES.supervisorError
  }), /lifecycle_handle_unexpected/);
  assert.throws(() => reconcileLifecycleLedger({
    ledgerFile: writer.filePath,
    processHandle: null,
    outcome: "tracking_lost"
  }), /lifecycle_tracking_not_activated/);
});

test("terminal delivery failure corrects the private ledger to supervisor exit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-ledger-delivery-fail-"));
  const { module } = makeRuntimeModule();
  const config = makeConfig(root);
  const emitted = [];
  const exitCode = await runSupervisor(config, {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      if (event.type === "terminal") {
        throw new Error("private delivery failure");
      }
      emitted.push(event);
    }
  });

  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(emitted.some((event) => event.type === "terminal"), false);
  const ledger = JSON.parse(fs.readFileSync(onlyLifecycleLedger(config.stateDir), "utf8"));
  assert.equal(ledger.state, "terminal_intent");
  assert.deepEqual(ledger.terminalIntent, {
    type: "supervisor_error",
    code: "supervisor_failure"
  });
  assert.deepEqual(ledger.exitReconciliation, {
    status: "pending",
    expectedExitCode: EXIT_CODES.supervisorError
  });
  assert.equal(JSON.stringify(ledger).includes("private delivery failure"), false);
});

test("dead handle without terminal evidence reconciles only as tracking_lost", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-tracking-lost-"));
  if (process.platform !== "win32") {
    fs.chmodSync(stateDir, 0o700);
  }
  const writer = createLifecycleLedger({
    stateDir,
    runId: "run-1",
    requestId: "request-1",
    nowMs: Date.now()
  });
  activateLifecycleLedger(writer, "tracked-session-99", Date.now());
  recordLifecycleEvent(writer, {
    type: "started",
    sequence: 1,
    timestamp: new Date().toISOString()
  }, { force: true });

  const reconciled = reconcileLifecycleLedger({
    ledgerFile: writer.filePath,
    processHandle: "tracked-session-99",
    outcome: "tracking_lost",
    nowMs: Date.now()
  });
  assert.equal(reconciled.state, "tracking_lost");
  assert.equal(reconciled.trackingFault.code, "tracking_lost");
  assert.equal(reconciled.exitReconciliation.status, "tracking_lost");
  const verifiedAgain = reconcileLifecycleLedger({
    ledgerFile: writer.filePath,
    processHandle: "tracked-session-99",
    outcome: "tracking_lost"
  });
  assert.equal(verifiedAgain.state, "tracking_lost");
  assert.throws(() => reconcileLifecycleLedger({
    ledgerFile: writer.filePath,
    processHandle: "tracked-session-99",
    outcome: "exited",
    exitCode: EXIT_CODES.completed
  }), /lifecycle_tracking_lost/);
});

test("lifecycle ledger loader rejects impossible states and unbounded nested shapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-ledger-shape-"));
  const timestamp = new Date().toISOString();
  const base = {
    schemaVersion: "acp-host-lifecycle.v1",
    runId: "run-1",
    requestId: "request-1",
    processHandle: "tracked-session-42",
    state: "terminal_intent",
    activatedAt: timestamp,
    lastEvent: { type: "terminal", sequence: 4, timestamp },
    terminalIntent: { type: "terminal", status: "completed" },
    exitReconciliation: { status: "pending", expectedExitCode: 0 },
    trackingFault: null,
    updatedAt: timestamp
  };
  const invalidDocuments = [
    {
      ...base,
      state: "active"
    },
    {
      ...base,
      terminalIntent: { type: "terminal", status: "completed", detail: "private" }
    },
    {
      ...base,
      exitReconciliation: { status: "pending" }
    },
    {
      ...base,
      state: "exit_reconciled",
      exitReconciliation: {
        status: "confirmed",
        expectedExitCode: 0,
        exitCode: 20,
        reconciledAt: timestamp
      }
    },
    {
      ...base,
      state: "tracking_lost",
      terminalIntent: null,
      exitReconciliation: { status: "tracking_lost", reconciledAt: timestamp },
      trackingFault: { code: "other", observedAt: timestamp }
    },
    {
      ...base,
      lastEvent: { type: "terminal\nprivate", sequence: 4, timestamp }
    }
  ];

  for (const [index, document] of invalidDocuments.entries()) {
    const ledgerFile = path.join(root, `invalid-${index}.json`);
    fs.writeFileSync(ledgerFile, JSON.stringify(document), { mode: 0o600 });
    assert.throws(
      () => loadLifecycleLedger(ledgerFile),
      /invalid_lifecycle_ledger/,
      `case ${index}`
    );
  }
});

test("permission guard rejects detachment and bypass while allowing foreground parallel runners", () => {
  const allowed = new Set(["execute", "read"]);
  const rejected = [
    [{ run_in_background: true }, "background_flag"],
    [{ run_in_background: "true" }, "background_flag"],
    [{ command: "nohup node server.js" }, "detached_shell"],
    [{ command: "node server.js; disown" }, "detached_shell"],
    [{ command: "setsid node server.js" }, "detached_shell"],
    [{ command: "sleep 1 &" }, "detached_shell"],
    [{ permissionMode: "bypassPermissions" }, "permission_bypass"],
    [{ mode: "bypassPermissions" }, "permission_bypass"]
  ];
  for (const [input, reason] of rejected) {
    assert.equal(classifyPermissionRequest(permissionRequest(input), allowed).reason, reason);
  }

  assert.equal(
    classifyPermissionRequest(permissionRequest({ command: "npm test" }), allowed).allowed,
    true
  );
  assert.equal(
    classifyPermissionRequest(permissionRequest({ command: "xargs -P 4 -n 1 node test.mjs" }), allowed).allowed,
    true
  );
  assert.equal(
    classifyPermissionRequest(permissionRequest({ command: "node test.mjs 2>&1" }), allowed).allowed,
    true
  );
  assert.equal(
    classifyPermissionRequest(permissionRequest({ path: "/tmp/file" }, "delete"), allowed).reason,
    "tool_kind_not_allowed"
  );
  assert.equal(
    classifyPermissionRequest(permissionRequest(undefined), allowed).reason,
    "uninspectable_input"
  );
});

test("detached-shell scanner ignores quoted ampersands and shell redirection", () => {
  assert.equal(containsDetachedShell("printf '%s' 'a & b'"), false);
  assert.equal(containsDetachedShell("node test.mjs 2>&1"), false);
  assert.equal(containsDetachedShell("node a.mjs && node b.mjs"), false);
  assert.equal(containsDetachedShell("node server.mjs &"), true);
});

test("remote VCS guard enforces the ACP local-commit-only handoff", () => {
  const rejected = [
    "git push origin HEAD",
    "git -C repo push --force-with-lease",
    "/usr/bin/git send-pack origin HEAD",
    "git lfs push origin main",
    "git -c alias.ship=push ship origin main",
    "git --config-env=alias.ship=SHIP ship origin main",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ship GIT_CONFIG_VALUE_0=push git ship origin main",
    "git config alias.ship push",
    "env GIT_SSH_COMMAND=ssh git push origin main",
    "bash -lc 'git push origin main'",
    "if true; then git push origin main; fi",
    "time -p git push origin main",
    "nice -n 5 git push origin main",
    "timeout 30 git push origin main",
    "sudo -u builder git push origin main",
    "gh pr create --fill",
    "/opt/homebrew/bin/gh api repos/o/r/pulls -X POST",
    "hub pull-request",
    "glab mr create",
    "npx -y gh pr create",
    "pnpm dlx gh pr create",
    "yarn dlx -- gh pr create",
    "npm exec -- gh pr create",
    "npm exec -c 'gh pr create'",
    "find . -exec git push origin main ;"
  ];
  for (const command of rejected) {
    assert.equal(containsRemoteVcsAction(command), true, command);
  }

  const allowed = [
    "git status --short",
    "git diff --check",
    "git add src test && git commit -m 'fix: local change'",
    "git log -1 --oneline",
    "git fetch --prune origin",
    "git config --get alias.ship",
    "git config alias.ship",
    "rg -n 'git push' docs",
    "printf '%s' 'gh pr create'",
    "command -v gh"
  ];
  for (const command of allowed) {
    assert.equal(containsRemoteVcsAction(command), false, command);
  }
});

test("permission guard rejects opaque execute and remote VCS actions", () => {
  const allowed = new Set(["execute", "edit"]);
  const rejected = [
    [permissionRequest({}, "execute"), "uninspectable_input"],
    [permissionRequest({ opaque: true }, "execute"), "uninspectable_input"],
    [permissionRequest({ command: "git push origin HEAD" }, "execute"), "remote_vcs_action"],
    [permissionRequest({ command: "gh", args: ["pr", "create", "--fill"] }, "execute"), "remote_vcs_action"]
  ];
  for (const [request, reason] of rejected) {
    assert.equal(classifyPermissionRequest(request, allowed).reason, reason);
  }

  assert.equal(
    classifyPermissionRequest(permissionRequest({}, "edit"), allowed).allowed,
    true
  );
  assert.equal(
    classifyPermissionRequest(
      permissionRequest({ command: "git add src && git commit -m 'fix: local'" }, "execute"),
      allowed
    ).allowed,
    true
  );
});

test("public docs bind ACP work to local commit before the owner handoff", () => {
  const skill = fs.readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
  const contract = fs.readFileSync(
    new URL("../references/runtime-contract.md", import.meta.url),
    "utf8"
  );

  for (const doc of [skill, contract]) {
    assert.match(doc, /local-commit-only/);
    assert.match(doc, /git push/);
    assert.match(doc, /git send-pack/);
    assert.match(doc, /git lfs push/);
    assert.match(doc, /`gh`/);
    assert.match(doc, /network sandbox/);
  }
});

test("permission handler only returns one-shot outcomes", async () => {
  const counters = {
    permissionsApproved: 0,
    permissionsRejected: 0,
    permissionsCancelled: 0
  };
  const events = [];
  const handler = buildPermissionHandler({
    allowKinds: new Set(["execute"]),
    counters,
    emit(type, payload) {
      events.push({ type, ...payload });
    }
  });

  assert.deepEqual(
    await handler(permissionRequest({ command: "npm test" }), { signal: { aborted: false } }),
    { outcome: "allow_once" }
  );
  assert.deepEqual(
    await handler(permissionRequest({ run_in_background: true }), { signal: { aborted: false } }),
    { outcome: "reject_once" }
  );
  assert.deepEqual(
    await handler(permissionRequest({ command: "npm test" }), { signal: { aborted: true } }),
    { outcome: "cancel" }
  );
  assert.equal(counters.permissionsApproved, 1);
  assert.equal(counters.permissionsRejected, 1);
  assert.equal(counters.permissionsCancelled, 1);
  assert.equal(events[0].reason, "background_flag");
});

test("completed run emits normalized events and stores response privately", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-supervisor-test-"));
  if (process.platform !== "win32") {
    fs.chmodSync(root, 0o755);
  }
  const { module, state } = makeRuntimeModule({
    events: [
      { type: "text_delta", stream: "output", text: "TOP_SECRET_RESPONSE" },
      {
        type: "tool_call",
        kind: "execute",
        status: "completed",
        title: "secret title",
        rawInput: { command: "echo RAW_SECRET" },
        rawOutput: "RAW_OUTPUT_SECRET"
      }
    ]
  });
  const config = makeConfig(root);
  const emitted = [];

  const exitCode = await runSupervisor(config, {
    runtimeModule: module,
    runtimeVersion: "0.11.2-mock",
    bindSignals: false,
    randomUUID: (() => {
      let value = 0;
      return () => "uuid-" + String(value += 1);
    })(),
    writeEvent(event) {
      emitted.push(event);
    }
  });

  assert.equal(exitCode, EXIT_CODES.completed);
  assert.equal(fs.readFileSync(config.responseFile, "utf8"), "TOP_SECRET_RESPONSE");
  assert.equal(fs.statSync(config.responseFile).mode & 0o077, 0);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(root).mode & 0o777, 0o755);
  }
  const serialized = JSON.stringify(emitted);
  assert.equal(serialized.includes("TOP_SECRET_RESPONSE"), false);
  assert.equal(serialized.includes("RAW_SECRET"), false);
  assert.equal(serialized.includes("RAW_OUTPUT_SECRET"), false);
  assert.equal(serialized.includes("secret title"), false);
  assert.equal(emitted.at(-1).type, "terminal");
  assert.equal(emitted.at(-1).status, "completed");
  assert.equal(emitted.at(-1).supervisorStatus, "ok");
  assert.equal(emitted.at(-1).responseStored, true);
  assert.equal("responseBytes" in emitted.at(-1), false);
  assert.equal("responseSha256" in emitted.at(-1), false);
  assert.equal("workspace" in emitted[0], false);
  assert.equal(state.ensureInput.mode, "oneshot");
  assert.match(state.ensureInput.sessionOptions.systemPrompt.append, /foreground/i);
  assert.match(state.turnInput.text, /foreground/i);
  assert.equal(state.closeInput.discardPersistentState, true);
});

test("supervisor drains buffered output after result before closing the stream", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-supervisor-drain-"));
  const { module } = makeRuntimeModule({
    result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
    eventFactory(state) {
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (!state.streamClosed) {
            yield { type: "text_delta", stream: "output", text: "FINAL_CHUNK" };
          }
        }
      };
    }
  });
  const config = makeConfig(root);
  assert.equal(await runSupervisor(config, {
    runtimeModule: module,
    bindSignals: false,
    writeEvent() {}
  }), EXIT_CODES.completed);
  assert.equal(fs.readFileSync(config.responseFile, "utf8"), "FINAL_CHUNK");
});

test("supervisor waits for the exact turn result after events end", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-supervisor-wait-"));
  const terminal = deferred();
  const { module } = makeRuntimeModule({ result: terminal.promise, events: [] });
  const config = makeConfig(root);
  let settled = false;
  const run = runSupervisor(config, {
    runtimeModule: module,
    bindSignals: false,
    writeEvent() {}
  }).then((value) => {
    settled = true;
    return value;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  terminal.resolve({ status: "completed", stopReason: "end_turn" });
  assert.equal(await run, EXIT_CODES.completed);
});

test("terminal result states preserve distinct exit codes", async () => {
  for (const [result, expected] of [
    [{ status: "cancelled", stopReason: "cancelled" }, EXIT_CODES.cancelled],
    [{ status: "failed", error: { message: "private detail", code: "PRIVATE CODE /tmp/secret" } }, EXIT_CODES.failed]
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-supervisor-result-"));
    const { module } = makeRuntimeModule({ result: Promise.resolve(result) });
    const emitted = [];
    const exitCode = await runSupervisor(makeConfig(root), {
      runtimeModule: module,
      bindSignals: false,
      writeEvent(event) {
        emitted.push(event);
      }
    });
    assert.equal(exitCode, expected);
    assert.equal(emitted.at(-1).status, result.status);
    const serialized = JSON.stringify(emitted);
    assert.equal(serialized.includes("private detail"), false);
    assert.equal(serialized.includes("/tmp/secret"), false);
    if (result.status === "failed") {
      assert.equal(emitted.at(-1).errorCode, "acp_turn_failed");
    }
  }
});

test("normalization drops untrusted ACP labels", () => {
  const counters = {
    outputEvents: 0,
    thoughtEvents: 0,
    statusEvents: 0,
    toolEvents: 0,
    unknownEvents: 0,
    compatibilityTerminalEvents: 0
  };
  const normalized = normalizeRuntimeEvent({
    type: "tool_call",
    tag: "PRIVATE /tmp/tag",
    kind: "PRIVATE_KIND",
    status: "PRIVATE_STATUS",
    title: "PRIVATE_TITLE",
    rawInput: { command: "echo PRIVATE_INPUT" }
  }, counters);
  assert.deepEqual(normalized, {
    activity: "tool",
    toolKind: "unknown",
    toolStatus: "unknown"
  });
  assert.equal(JSON.stringify(normalized).includes("PRIVATE"), false);
});

test("private config rejects a symlinked prompt file", {
  skip: process.platform === "win32"
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-config-symlink-"));
  const prompt = path.join(root, "prompt.txt");
  const promptLink = path.join(root, "prompt-link.txt");
  const configFile = path.join(root, "run.json");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  fs.symlinkSync(prompt, promptLink);
  fs.writeFileSync(configFile, JSON.stringify({
    agent: "codex",
    model: "test-model",
    cwd: root,
    sessionKey: "test-session",
    promptFile: promptLink,
    responseFile: path.join(root, "response.txt"),
    stateDir: path.join(root, "state"),
    runtimeModule: root,
    allowKinds: ["read"]
  }), { mode: 0o600 });
  assert.throws(
    () => loadSupervisorConfig(configFile),
    /invalid_prompt_file_symlink/
  );
});

test("insecure existing state directory fails closed without chmod", {
  skip: process.platform === "win32"
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-state-mode-"));
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { mode: 0o755 });
  fs.chmodSync(stateDir, 0o755);
  const { module, state } = makeRuntimeModule();
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(root, { stateDir }), {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(emitted.at(-1).type, "supervisor_error");
  assert.equal(emitted.at(-1).code, "invalid_state_dir_permissions");
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o755);
  assert.equal(state.runtimeOptions, undefined);
});

test("completed ACP result remains visible when response storage degrades", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-response-store-"));
  const blocker = path.join(root, "blocker");
  fs.writeFileSync(blocker, "not a directory");
  const { module } = makeRuntimeModule();
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(root, {
    responseFile: path.join(blocker, "response.txt")
  }), {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(emitted.at(-1).type, "terminal");
  assert.equal(emitted.at(-1).status, "completed");
  assert.equal(emitted.at(-1).supervisorStatus, "degraded");
  assert.equal(emitted.at(-1).responseStored, false);
});

test("completed ACP result fails closed when the event stream fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-event-fail-"));
  const { module } = makeRuntimeModule({
    eventFactory() {
      return {
        async *[Symbol.asyncIterator]() {
          throw new Error("private stream detail");
        }
      };
    }
  });
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(root), {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(emitted.at(-1).type, "terminal");
  assert.equal(emitted.at(-1).status, "completed");
  assert.equal(emitted.at(-1).supervisorStatus, "degraded");
  assert.equal(emitted.at(-1).eventStreamOk, false);
  assert.equal(JSON.stringify(emitted).includes("private stream detail"), false);
});

test("completed ACP result fails closed when cleanup fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-cleanup-fail-"));
  const { module, state } = makeRuntimeModule({ closeError: true });
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(root), {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(emitted.at(-1).type, "terminal");
  assert.equal(emitted.at(-1).status, "completed");
  assert.equal(emitted.at(-1).supervisorStatus, "degraded");
  assert.equal(emitted.at(-1).cleanupOk, false);
  assert.ok(state.closeAttempts >= 1);
  assert.equal(JSON.stringify(emitted).includes("private cleanup detail"), false);
});

// The structured rejection the ACPX runtime raises when the backend adapter
// does not implement the session/close control requested by a
// discardPersistentState close. The record identifier in the message is
// private detail and must never reach normalized output.
function unsupportedSessionCloseError() {
  const error = new Error("Agent does not support session/close for private-record-id.");
  error.name = "AcpRuntimeError";
  error.code = ACPX_UNSUPPORTED_CONTROL_ERROR_CODE;
  return error;
}

test("unsupported session/close detection is structured, never message-based", () => {
  assert.equal(isUnsupportedSessionCloseCleanupError(unsupportedSessionCloseError()), true);
  // The stable code is the whole surface, so a bare object carrying it also
  // qualifies while a matching message without the code never does.
  assert.equal(
    isUnsupportedSessionCloseCleanupError({ code: ACPX_UNSUPPORTED_CONTROL_ERROR_CODE }),
    true
  );
  assert.equal(
    isUnsupportedSessionCloseCleanupError(
      new Error("Agent does not support session/close for private-record-id.")
    ),
    false
  );
  const otherCode = new Error("Agent does not support session/close for private-record-id.");
  otherCode.code = "ACP_TURN_FAILED";
  assert.equal(isUnsupportedSessionCloseCleanupError(otherCode), false);
  assert.equal(isUnsupportedSessionCloseCleanupError(null), false);
  assert.equal(isUnsupportedSessionCloseCleanupError(undefined), false);
  assert.equal(
    isUnsupportedSessionCloseCleanupError(ACPX_UNSUPPORTED_CONTROL_ERROR_CODE),
    false
  );
});

test("codex oneshot unsupported session/close falls back to a local close", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codex-close-fallback-"));
  const { module, state } = makeRuntimeModule({
    events: [{ type: "text_delta", stream: "output", text: "codex bounded result" }],
    closeError: (input) => input.discardPersistentState === true
      ? unsupportedSessionCloseError()
      : undefined
  });
  const config = makeConfig(root);
  const emitted = [];
  const exitCode = await runSupervisor(config, {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });

  assert.equal(exitCode, EXIT_CODES.completed);
  assert.equal(fs.readFileSync(config.responseFile, "utf8"), "codex bounded result");
  const terminal = emitted.at(-1);
  assert.equal(terminal.type, "terminal");
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.supervisorStatus, "ok");
  assert.equal(terminal.cleanupOk, true);
  assert.equal(terminal.cleanupFallback, true);
  assert.equal(terminal.responseStored, true);
  // No duplicate terminal event and no output after the terminal latch.
  assert.equal(emitted.filter((event) => event.type === "terminal").length, 1);
  assert.equal(
    emitted.filter((event) => event.activity === "cleanup_unsupported_close_fallback").length,
    1
  );
  // Exactly one discard attempt, then one local close without requesting
  // backend persistent-state disposal.
  assert.equal(state.closeAttempts, 2);
  assert.equal(state.closeInputs[0].discardPersistentState, true);
  assert.equal("discardPersistentState" in state.closeInputs[1], false);
  assert.equal(state.closeInputs[1].reason, "supervisor_terminal_unsupported_close");
  assert.equal(JSON.stringify(emitted).includes("private-record-id"), false);
});

test("non-unsupported codex close failures keep the fail-closed cleanup contract", async () => {
  const messageOnly = new Error("Agent does not support session/close for private-record-id.");
  const wrongCode = new Error("backend close failed");
  wrongCode.code = "ACP_TURN_FAILED";
  for (const closeFailure of [messageOnly, wrongCode]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codex-close-hardfail-"));
    const { module, state } = makeRuntimeModule({
      closeError: () => closeFailure
    });
    const emitted = [];
    const exitCode = await runSupervisor(makeConfig(root), {
      runtimeModule: module,
      bindSignals: false,
      writeEvent(event) {
        emitted.push(event);
      }
    });
    assert.equal(exitCode, EXIT_CODES.supervisorError);
    const terminal = emitted.at(-1);
    assert.equal(terminal.type, "terminal");
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.supervisorStatus, "degraded");
    assert.equal(terminal.cleanupOk, false);
    assert.equal("cleanupFallback" in terminal, false);
    // Never a fallback close: every attempt requests the canonical discard.
    assert.ok(state.closeInputs.length >= 1);
    assert.ok(state.closeInputs.every((input) => input.discardPersistentState === true));
    assert.equal(
      emitted.some((event) => event.activity === "cleanup_unsupported_close_fallback"),
      false
    );
    assert.equal(JSON.stringify(emitted).includes("private-record-id"), false);
  }
});

test("codex fallback close failure remains degraded with supervisor exit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codex-fallback-fail-"));
  const { module, state } = makeRuntimeModule({
    closeError: (input) => input.discardPersistentState === true
      ? unsupportedSessionCloseError()
      : new Error("private fallback close detail")
  });
  const config = makeConfig(root);
  const emitted = [];
  const exitCode = await runSupervisor(config, {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  const terminal = emitted.at(-1);
  assert.equal(terminal.type, "terminal");
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.supervisorStatus, "degraded");
  assert.equal(terminal.cleanupOk, false);
  assert.equal("cleanupFallback" in terminal, false);
  assert.equal(
    emitted.filter((event) => event.activity === "cleanup_unsupported_close_fallback").length,
    1
  );
  // Discard attempt, failed local fallback, then the finally-path close.
  assert.equal(state.closeInputs[0].discardPersistentState, true);
  assert.equal("discardPersistentState" in state.closeInputs[1], false);
  const serialized = JSON.stringify(emitted);
  assert.equal(serialized.includes("private fallback close detail"), false);
  assert.equal(serialized.includes("private-record-id"), false);
});

test("unsupported close without an exact completed result never falls back", async () => {
  const results = [
    { status: "failed", stopReason: "turn_failed", error: { code: "acp_turn_failed", retryable: false } },
    { status: "cancelled", stopReason: "cancelled" }
  ];
  for (const result of results) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codex-nonsuccess-close-"));
    const { module, state } = makeRuntimeModule({
      result: Promise.resolve(result),
      closeError: (input) => input.discardPersistentState === true
        ? unsupportedSessionCloseError()
        : undefined
    });
    const emitted = [];
    const exitCode = await runSupervisor(makeConfig(root), {
      runtimeModule: module,
      bindSignals: false,
      writeEvent(event) {
        emitted.push(event);
      }
    });
    assert.equal(exitCode, EXIT_CODES.supervisorError, result.status);
    const terminal = emitted.at(-1);
    assert.equal(terminal.type, "terminal");
    assert.equal(terminal.status, result.status);
    assert.equal(terminal.supervisorStatus, "degraded");
    assert.equal(terminal.cleanupOk, false);
    assert.equal("cleanupFallback" in terminal, false);
    assert.ok(state.closeInputs.every((input) => input.discardPersistentState === true));
    assert.equal(
      emitted.some((event) => event.activity === "cleanup_unsupported_close_fallback"),
      false
    );
  }
});

test("catch-path cleanup never uses the codex unsupported-close fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codex-catch-close-"));
  const terminal = deferred();
  const { module, state } = makeRuntimeModule({
    result: terminal.promise,
    closeError: (input) => input.discardPersistentState === true
      ? unsupportedSessionCloseError()
      : undefined
  });
  const config = makeConfig(root);
  const emitted = [];
  const run = runSupervisor(config, {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const turnError = new Error("acpx_turn_transport_failed");
  turnError.code = "acpx_turn_transport_failed";
  terminal.reject(turnError);

  assert.equal(await run, EXIT_CODES.supervisorError);
  assert.equal(emitted.at(-1).type, "supervisor_error");
  assert.equal(emitted.at(-1).code, "acpx_turn_transport_failed");
  assert.equal(fs.existsSync(config.responseFile), false);
  // The finally path keeps the canonical discard close and never retries a
  // local close, even though the rejection carries the unsupported code.
  assert.ok(state.closeInputs.length >= 1);
  assert.ok(state.closeInputs.every((input) => input.discardPersistentState === true));
  assert.equal(
    emitted.some((event) => event.activity === "cleanup_unsupported_close_fallback"),
    false
  );
});

test("response storage stays authoritative after a successful codex close fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codex-fallback-storage-"));
  const config = makeConfig(root);
  const { module, state } = makeRuntimeModule({
    events: [{ type: "text_delta", stream: "output", text: "codex bounded result" }],
    closeError: (input) => {
      if (input.discardPersistentState === true) {
        return unsupportedSessionCloseError();
      }
      // Occupy the response path during the fallback close so the later
      // exclusive response write fails after cleanup succeeded.
      fs.writeFileSync(config.responseFile, "occupied");
      return undefined;
    }
  });
  const emitted = [];
  const exitCode = await runSupervisor(config, {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  const terminal = emitted.at(-1);
  assert.equal(terminal.type, "terminal");
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.supervisorStatus, "degraded");
  assert.equal(terminal.cleanupOk, true);
  assert.equal(terminal.cleanupFallback, true);
  assert.equal(terminal.responseStored, false);
  assert.equal(state.closeAttempts, 2);
  assert.equal(fs.readFileSync(config.responseFile, "utf8"), "occupied");
});

test("runtime location accepts an explicit package root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-runtime-root-"));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "test" }));
  const location = discoverRuntimeLocation({ runtimeModule: root });
  assert.equal(location.packageRoot, root);
  assert.equal(location.modulePath, path.join(root, "dist", "runtime.js"));
});

test("runtime export capability checks fail closed", () => {
  assert.throws(
    () => validateRuntimeModuleExports({}),
    /acpx_runtime_capability_missing_createAcpRuntime/
  );
});

test("permission guard fails closed for uninspectable and bounded input shapes", () => {
  const allowed = new Set(["execute"]);
  let deep = { run_in_background: true };
  for (let index = 0; index < 14; index += 1) {
    deep = { nested: deep };
  }
  const wide = {};
  for (let index = 0; index < 256; index += 1) {
    wide["safe" + String(index)] = false;
  }
  wide.run_in_background = true;

  const rejected = [
    [null, "uninspectable_input"],
    ["nohup evil.sh &", "uninspectable_input"],
    [42, "uninspectable_input"],
    [{ command: ["bash", "-c", "sleep 1 &"] }, "detached_shell"],
    [{ command: ["nohup", "node", "server.js"] }, "detached_shell"],
    [{ argv: "nohup node server.js &" }, "detached_shell"],
    [{ args: "setsid node server.js" }, "detached_shell"],
    [{ command: "claude --dangerously-skip-permissions -p go" }, "permission_bypass"],
    [deep, "uninspectable_input"],
    [wide, "uninspectable_input"],
    [{ detached: true }, "background_flag"],
    [{ daemon: true }, "background_flag"],
    [{ run_in_background: "yes" }, "background_flag"],
    [{ command: "npx acpx@0.13.0 prompt --agent claude" }, "nested_agent_route"],
    [{ command: "openclaw acp spawn --agent claude" }, "nested_agent_route"],
    [{ command: "claude --background" }, "nested_agent_route"]
  ];
  for (const [input, reason] of rejected) {
    assert.equal(
      classifyPermissionRequest(permissionRequest(input), allowed).reason,
      reason
    );
  }

  assert.equal(
    classifyPermissionRequest(
      permissionRequest({ opaque: true }, "other"),
      new Set(["other"])
    ).reason,
    "unclassified_tool_kind"
  );
});

test("runtime permission callback is wired and rejects opaque input", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-permission-wire-"));
  const { module, state } = makeRuntimeModule({
    permissionRequest: permissionRequest(null)
  });
  const emitted = [];
  assert.equal(await runSupervisor(makeConfig(root), {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  }), EXIT_CODES.completed);
  assert.deepEqual(state.permissionOutcome, { outcome: "reject_once" });
  assert.equal(emitted.at(-1).counters.permissionsRejected, 1);
});

test("runtime permission callback rejects remote VCS actions before execution", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-remote-vcs-wire-"));
  const { module, state } = makeRuntimeModule({
    permissionRequest: permissionRequest({ command: "git push origin HEAD" })
  });
  const emitted = [];
  assert.equal(await runSupervisor(makeConfig(root), {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  }), EXIT_CODES.completed);
  assert.deepEqual(state.permissionOutcome, { outcome: "reject_once" });
  assert.equal(
    emitted.find((event) => event.type === "permission_rejected").reason,
    "remote_vcs_action"
  );
  assert.equal(emitted.at(-1).counters.permissionsRejected, 1);
});

test("config requires a timeout and rejects the unclassified other kind", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-config-required-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const lifecycle = rawLifecycle();
  const base = {
    agent: "codex",
    model: "test-model",
    cwd: root,
    sessionKey: "test-session",
    promptFile: prompt,
    responseFile: path.join(root, "response.txt"),
    stateDir: path.join(root, "state"),
    runtimeModule: root,
    lifecycle,
    reporting: validReporting(lifecycle),
    allowKinds: ["read"]
  };

  const missingTimeout = path.join(root, "missing-timeout.json");
  fs.writeFileSync(missingTimeout, JSON.stringify(base), { mode: 0o600 });
  assert.throws(
    () => loadSupervisorConfig(missingTimeout),
    /invalid_timeout_ms/
  );

  const otherKind = path.join(root, "other-kind.json");
  fs.writeFileSync(otherKind, JSON.stringify({
    ...base,
    timeoutMs: 30000,
    allowKinds: ["other"]
  }), { mode: 0o600 });
  assert.throws(
    () => loadSupervisorConfig(otherKind),
    /invalid_allow_kind/
  );
});

test("environment contract config shape fails closed with exact codes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-env-config-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const lifecycle = rawLifecycle();
  const base = {
    agent: "codex",
    model: "test-model",
    cwd: root,
    sessionKey: "test-session",
    promptFile: prompt,
    responseFile: path.join(root, "response.txt"),
    stateDir: path.join(root, "state"),
    runtimeModule: root,
    timeoutMs: 30000,
    lifecycle,
    reporting: validReporting(lifecycle),
    allowKinds: ["read"]
  };
  const writeCase = (name, extra) => {
    const file = path.join(root, name + ".json");
    fs.writeFileSync(file, JSON.stringify({ ...base, ...extra }), { mode: 0o600 });
    return file;
  };

  const invalid = [
    ["req-string", { requiredEnv: "CLAUDE_CODE_OAUTH_TOKEN" }, "invalid_required_env"],
    ["req-oversize", { requiredEnv: Array.from({ length: 33 }, (_, i) => "VAR_" + String(i)) }, "invalid_required_env"],
    ["req-nonstring", { requiredEnv: [42] }, "invalid_required_env_name"],
    ["req-empty-name", { requiredEnv: [""] }, "invalid_required_env_name"],
    ["req-digit-start", { requiredEnv: ["1BAD"] }, "invalid_required_env_name"],
    ["req-dash", { requiredEnv: ["BAD-NAME"] }, "invalid_required_env_name"],
    ["req-equals", { requiredEnv: ["BAD=VALUE"] }, "invalid_required_env_name"],
    ["req-long", { requiredEnv: ["A".repeat(65)] }, "invalid_required_env_name"],
    ["req-duplicate", { requiredEnv: ["DUP_NAME", "DUP_NAME"] }, "invalid_required_env_duplicate"],
    ["req-case-duplicate", { requiredEnv: ["Dup_Name", "DUP_NAME"] }, "invalid_required_env_duplicate"],
    ["forb-object", { forbiddenEnv: { NAME: true } }, "invalid_forbidden_env"],
    ["forb-bad-name", { forbiddenEnv: ["BAD NAME"] }, "invalid_forbidden_env_name"],
    ["forb-duplicate", { forbiddenEnv: ["DUP_NAME", "DUP_NAME"] }, "invalid_forbidden_env_duplicate"],
    ["forb-case-duplicate", { forbiddenEnv: ["dup_name", "DUP_NAME"] }, "invalid_forbidden_env_duplicate"],
    ["overlap", {
      requiredEnv: ["SHARED_NAME"],
      forbiddenEnv: ["SHARED_NAME"]
    }, "invalid_env_contract_overlap"],
    ["case-overlap", {
      requiredEnv: ["Shared_Name"],
      forbiddenEnv: ["SHARED_NAME"]
    }, "invalid_env_contract_overlap"]
  ];
  for (const [name, extra, expected] of invalid) {
    assert.throws(
      () => loadSupervisorConfig(writeCase(name, extra)),
      { message: expected, code: expected },
      name
    );
  }

  const valid = loadSupervisorConfig(writeCase("valid", {
    requiredEnv: ["A_REQUIRED_TOKEN", "_UNDERSCORE_OK", "Mixed_Case_Kept"],
    forbiddenEnv: ["A_FORBIDDEN_TOKEN"]
  }));
  assert.deepEqual(valid.requiredEnv, ["A_REQUIRED_TOKEN", "_UNDERSCORE_OK", "Mixed_Case_Kept"]);
  assert.deepEqual(valid.forbiddenEnv, ["A_FORBIDDEN_TOKEN"]);

  const omitted = loadSupervisorConfig(writeCase("omitted", {
    responseFile: path.join(root, "response-omitted.txt")
  }));
  assert.deepEqual(omitted.requiredEnv, []);
  assert.deepEqual(omitted.forbiddenEnv, []);
});

test("invalid environment contract retains the invalid-config CLI mapping", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-env-cli-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const configFile = path.join(root, "run.json");
  fs.writeFileSync(configFile, JSON.stringify({
    agent: "codex",
    cwd: root,
    sessionKey: "test-session",
    promptFile: prompt,
    responseFile: path.join(root, "response.txt"),
    stateDir: path.join(root, "state"),
    runtimeModule: root,
    timeoutMs: 30000,
    lifecycle: rawLifecycle(),
    allowKinds: ["read"],
    requiredEnv: "CLAUDE_CODE_OAUTH_TOKEN"
  }), { mode: 0o600 });

  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  let exitCode;
  try {
    exitCode = await main(["--config", configFile]);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(exitCode, EXIT_CODES.invalidConfig);
  const emitted = JSON.parse(writes.join("").trim());
  assert.equal(emitted.type, "supervisor_error");
  assert.equal(emitted.code, "invalid_required_env");
});

test("satisfied environment contract reaches the runtime without value disclosure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-env-ok-"));
  const { module, state } = makeRuntimeModule();
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(root, {
    requiredEnv: ["ACP_TEST_REQUIRED_TOKEN"],
    forbiddenEnv: ["ACP_TEST_FORBIDDEN_TOKEN"]
  }), {
    runtimeModule: module,
    bindSignals: false,
    env: {
      [CODEX_PATH_ENV]: process.execPath,
      ACP_TEST_REQUIRED_TOKEN: "REQUIRED_SECRET_VALUE",
      ACP_TEST_FORBIDDEN_TOKEN: ""
    },
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.completed);
  assert.ok(state.runtimeOptions);
  assert.equal(emitted.at(-1).type, "terminal");
  assert.equal(JSON.stringify(emitted).includes("REQUIRED_SECRET_VALUE"), false);
});

test("missing and empty required variables fail closed before adapter creation", async () => {
  for (const [env, code] of [
    [
      { [CODEX_PATH_ENV]: process.execPath },
      "required_env_missing:ACP_TEST_REQUIRED_TOKEN"
    ],
    [
      { [CODEX_PATH_ENV]: process.execPath, ACP_TEST_REQUIRED_TOKEN: "" },
      "required_env_empty:ACP_TEST_REQUIRED_TOKEN"
    ]
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-env-required-"));
    const { module, state } = makeRuntimeModule();
    const emitted = [];
    const exitCode = await runSupervisor(makeConfig(root, {
      requiredEnv: ["ACP_TEST_REQUIRED_TOKEN"]
    }), {
      runtimeModule: module,
      bindSignals: false,
      env,
      writeEvent(event) {
        emitted.push(event);
      }
    });
    assert.equal(exitCode, EXIT_CODES.supervisorError);
    assert.equal(emitted.at(-1).type, "supervisor_error");
    assert.equal(emitted.at(-1).code, code);
    assert.equal(state.runtimeOptions, undefined);
    assert.equal(state.ensureInput, undefined);
  }
});

test("non-empty forbidden variable fails closed without value disclosure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-env-forbidden-"));
  const { module, state } = makeRuntimeModule();
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(root, {
    forbiddenEnv: ["ACP_TEST_FORBIDDEN_TOKEN"]
  }), {
    runtimeModule: module,
    bindSignals: false,
    env: {
      [CODEX_PATH_ENV]: process.execPath,
      ACP_TEST_FORBIDDEN_TOKEN: "FORBIDDEN_SECRET_VALUE"
    },
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(emitted.at(-1).type, "supervisor_error");
  assert.equal(emitted.at(-1).code, "forbidden_env_present:ACP_TEST_FORBIDDEN_TOKEN");
  assert.equal(state.runtimeOptions, undefined);
  assert.equal(JSON.stringify(emitted).includes("FORBIDDEN_SECRET_VALUE"), false);
});

test("failed environment preflight precedes dynamic runtime loading and probing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-env-order-"));
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(root, {
    requiredEnv: ["ACP_TEST_REQUIRED_TOKEN"],
    runtimeModule: path.join(root, "missing-runtime")
  }), {
    bindSignals: false,
    env: { [CODEX_PATH_ENV]: process.execPath },
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(emitted.at(-1).type, "supervisor_error");
  assert.equal(emitted.at(-1).code, "required_env_missing:ACP_TEST_REQUIRED_TOKEN");
});

test("start-receipt config shape fails closed with exact codes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-receipt-config-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const base = {
    agent: "codex",
    model: "test-model",
    cwd: root,
    sessionKey: "test-session",
    promptFile: prompt,
    responseFile: path.join(root, "response.txt"),
    stateDir: path.join(root, "state"),
    runtimeModule: root,
    timeoutMs: 30000,
    allowKinds: ["read"]
  };
  const writeCase = (name, lifecycle) => {
    const file = path.join(root, name + ".json");
    fs.writeFileSync(
      file,
      JSON.stringify({ ...base, lifecycle, reporting: validReporting(lifecycle) }),
      { mode: 0o600 }
    );
    return file;
  };

  const invalid = [
    ["absent", undefined, "invalid_lifecycle"],
    ["string", "start-receipt", "invalid_lifecycle"],
    ["array", [], "invalid_lifecycle"],
    ["receipt-absent", rawLifecycle({ startReceipt: undefined }), "invalid_start_receipt"],
    ["receipt-array", rawLifecycle({ startReceipt: [] }), "invalid_start_receipt"],
    ["control-absent", rawLifecycle({ controlConversationId: undefined }), "invalid_control_conversation_id"],
    ["control-empty", rawLifecycle({ controlConversationId: "" }), "invalid_control_conversation_id"],
    ["control-nonnumeric", rawLifecycle({ controlConversationId: "channel-one" }), "invalid_control_conversation_id"],
    ["control-long", rawLifecycle({ controlConversationId: "1".repeat(33) }), "invalid_control_conversation_id"],
    ["receipt-conversation-spaced", rawLifecycle({}, { conversationId: "1 2" }), "invalid_start_receipt_conversation_id"],
    ["message-nonnumeric", rawLifecycle({}, { messageId: "msg_1" }), "invalid_start_receipt_message_id"],
    ["message-number", rawLifecycle({}, { messageId: 100000000000000002 }), "invalid_start_receipt_message_id"],
    ["mismatch", rawLifecycle({}, { conversationId: "100000000000000009" }), "invalid_start_receipt_conversation_mismatch"],
    ["delivered-absent", rawLifecycle({}, { deliveredAt: undefined }), "invalid_start_receipt_delivered_at"],
    ["delivered-prose", rawLifecycle({}, { deliveredAt: "yesterday" }), "invalid_start_receipt_delivered_at"],
    ["delivered-no-offset", rawLifecycle({}, { deliveredAt: "2026-08-22T10:00:00" }), "invalid_start_receipt_delivered_at"],
    ["delivered-epoch", rawLifecycle({}, { deliveredAt: 1700000000000 }), "invalid_start_receipt_delivered_at"],
    ["delivered-impossible", rawLifecycle({}, { deliveredAt: "2026-13-45T99:99:99Z" }), "invalid_start_receipt_delivered_at"],
    ["delivered-fraction-too-long", rawLifecycle({}, { deliveredAt: "2026-08-22T07:47:48.5300001+00:00" }), "invalid_start_receipt_delivered_at"],
    ["age-zero", rawLifecycle({ maxStartReceiptAgeMs: 0 }), "invalid_max_start_receipt_age_ms"],
    ["age-below-floor", rawLifecycle({ maxStartReceiptAgeMs: 999 }), "invalid_max_start_receipt_age_ms"],
    ["age-above-ceiling", rawLifecycle({ maxStartReceiptAgeMs: 3600001 }), "invalid_max_start_receipt_age_ms"],
    ["age-fractional", rawLifecycle({ maxStartReceiptAgeMs: 1000.5 }), "invalid_max_start_receipt_age_ms"]
  ];
  for (const [name, lifecycle, expected] of invalid) {
    assert.throws(
      () => loadSupervisorConfig(writeCase(name, lifecycle)),
      { message: expected, code: expected },
      name
    );
  }

  const valid = loadSupervisorConfig(writeCase("valid", rawLifecycle(
    { maxStartReceiptAgeMs: undefined },
    { deliveredAt: "2026-08-22T09:30:00.000Z" }
  )));
  assert.deepEqual(valid.lifecycle, {
    controlConversationId: CONTROL_CONVERSATION_ID,
    maxStartReceiptAgeMs: 300000,
    startReceipt: {
      conversationId: CONTROL_CONVERSATION_ID,
      messageId: START_MESSAGE_ID,
      deliveredAt: "2026-08-22T09:30:00.000Z",
      deliveredAtMs: Date.parse("2026-08-22T09:30:00.000Z")
    }
  });

  const offset = loadSupervisorConfig(writeCase("offset", rawLifecycle(
    {},
    { deliveredAt: "2026-08-22T18:30:00+09:00" }
  )));
  assert.equal(
    offset.lifecycle.startReceipt.deliveredAtMs,
    Date.parse("2026-08-22T09:30:00.000Z")
  );
});

test("delivered-at accepts Discord's native instant within a bounded fraction", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-receipt-instant-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const stateDir = path.join(root, "state");
  const responseFile = path.join(root, "response.txt");
  const writeCase = (name, deliveredAt) => {
    const file = path.join(root, name + ".json");
    const lifecycle = rawLifecycle({}, { deliveredAt });
    fs.writeFileSync(file, JSON.stringify({
      agent: "codex",
      model: "test-model",
      cwd: root,
      sessionKey: "test-session",
      promptFile: prompt,
      responseFile,
      stateDir,
      runtimeModule: root,
      timeoutMs: 30000,
      allowKinds: ["read"],
      lifecycle,
      reporting: validReporting(lifecycle)
    }), { mode: 0o600 });
    return file;
  };

  // Discord serializes message timestamps with six fractional digits and a
  // numeric offset, so that exact wire form must load without rewriting.
  const accepted = [
    ["discord-native", "2026-08-22T07:47:48.530000+00:00"],
    ["discord-native-zulu", "2026-08-22T07:47:48.530000Z"],
    ["discord-native-offset", "2026-08-22T16:47:48.530000+09:00"],
    ["millisecond", "2026-08-22T07:47:48.530Z"],
    ["single-digit-fraction", "2026-08-22T07:47:48.5Z"],
    ["no-fraction", "2026-08-22T07:47:48Z"]
  ];
  for (const [name, deliveredAt] of accepted) {
    const config = loadSupervisorConfig(writeCase(name, deliveredAt));
    assert.equal(
      config.lifecycle.startReceipt.deliveredAtMs,
      Date.parse(deliveredAt),
      name
    );
  }

  // The fraction stays bounded and the explicit zone stays mandatory.
  const rejected = [
    ["seven-digit-fraction", "2026-08-22T07:47:48.5300001+00:00"],
    ["unbounded-fraction", "2026-08-22T07:47:48." + "5".repeat(64) + "Z"],
    ["empty-fraction", "2026-08-22T07:47:48.+00:00"],
    ["no-zone", "2026-08-22T07:47:48.530000"],
    ["offset-without-colon", "2026-08-22T07:47:48.530000+0000"],
    ["lowercase-zulu", "2026-08-22T07:47:48.530000z"],
    ["spaced-offset", "2026-08-22T07:47:48.530000 +00:00"]
  ];
  for (const [name, deliveredAt] of rejected) {
    assert.throws(
      () => loadSupervisorConfig(writeCase(name, deliveredAt)),
      { message: "invalid_start_receipt_delivered_at", code: "invalid_start_receipt_delivered_at" },
      name
    );
  }

  // Config parsing precedes every side effect, so nothing was created.
  assert.equal(fs.existsSync(stateDir), false);
  assert.equal(fs.existsSync(responseFile), false);
});

test("invalid start receipt retains the invalid-config CLI mapping", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-receipt-cli-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const configFile = path.join(root, "run.json");
  fs.writeFileSync(configFile, JSON.stringify({
    agent: "codex",
    cwd: root,
    sessionKey: "test-session",
    promptFile: prompt,
    responseFile: path.join(root, "response.txt"),
    stateDir: path.join(root, "state"),
    runtimeModule: root,
    timeoutMs: 30000,
    lifecycle: rawLifecycle({}, { conversationId: "100000000000000009" }),
    allowKinds: ["read"]
  }), { mode: 0o600 });

  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  let exitCode;
  try {
    exitCode = await main(["--config", configFile]);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(exitCode, EXIT_CODES.invalidConfig);
  const emitted = JSON.parse(writes.join("").trim());
  assert.equal(emitted.type, "supervisor_error");
  assert.equal(emitted.code, "invalid_start_receipt_conversation_mismatch");
  assert.equal(fs.existsSync(path.join(root, "state")), false);
});

test("malformed reporting fails closed before any runtime module access", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-reporting-gate-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });

  // A real runtime module that records every stage of access: static import,
  // probe, and adapter construction each leave a sentinel file behind.
  const sentinelFile = path.join(root, "runtime-touched.txt");
  const runtimeFile = path.join(root, "runtime.mjs");
  fs.writeFileSync(runtimeFile, [
    'import fs from "node:fs";',
    `fs.writeFileSync(${JSON.stringify(sentinelFile)}, "imported");`,
    "export function createRuntimeStore() { return {}; }",
    "export function createAgentRegistry() { return {}; }",
    "export function createAcpRuntime() {",
    `  fs.writeFileSync(${JSON.stringify(sentinelFile)}, "adapter-started");`,
    "  return {",
    "    async probeAvailability() {",
    `      fs.writeFileSync(${JSON.stringify(sentinelFile)}, "probed");`,
    "    },",
    "    async ensureSession() { return {}; },",
    "    startTurn() { return {}; },",
    "    async close() {}",
    "  };",
    "}"
  ].join("\n"), { mode: 0o600 });

  const lifecycle = rawLifecycle();
  const writeCase = (name, reporting) => {
    const file = path.join(root, name + ".json");
    fs.writeFileSync(file, JSON.stringify({
      agent: "codex",
      model: "test-model",
      cwd: root,
      sessionKey: "test-session",
      promptFile: prompt,
      responseFile: path.join(root, "response-" + name + ".txt"),
      stateDir: path.join(root, "state"),
      runtimeModule: runtimeFile,
      timeoutMs: 30000,
      lifecycle,
      allowKinds: ["read"],
      ...(reporting === undefined ? {} : { reporting })
    }), { mode: 0o600 });
    return file;
  };

  // Absent reporting is invalid config, not a pass-through.
  assert.throws(
    () => loadSupervisorConfig(writeCase("absent", undefined)),
    { message: "invalid_reporting_root", code: "invalid_reporting_root" }
  );

  // Malformed reporting keeps the module's stable bounded code.
  const misrouted = {
    ...validReporting(lifecycle),
    startDestination: "999888777666555444"
  };
  assert.throws(
    () => loadSupervisorConfig(writeCase("misrouted", misrouted)),
    { message: "invalid_reporting_destination", code: "invalid_reporting_destination" }
  );

  // The CLI layer maps the same failure to the invalid-config exit while
  // preserving the code.
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  let exitCode;
  try {
    exitCode = await main(["--config", writeCase("misrouted-cli", misrouted)]);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(exitCode, EXIT_CODES.invalidConfig);
  const emitted = JSON.parse(writes.join("").trim());
  assert.equal(emitted.type, "supervisor_error");
  assert.equal(emitted.code, "invalid_reporting_destination");

  // The runtime module was never imported, probed, or started, and no
  // supervisor side effects happened.
  assert.equal(fs.existsSync(sentinelFile), false);
  assert.equal(fs.existsSync(path.join(root, "state")), false);
  assert.equal(fs.existsSync(path.join(root, "response-misrouted-cli.txt")), false);

  // A valid bundle still loads, with the normalized frozen result stored on
  // the supervisor config.
  const valid = loadSupervisorConfig(writeCase("valid", validReporting(lifecycle)));
  assert.equal(valid.reporting.schemaVersion, "acp-reporting-v2");
  assert.equal(valid.reporting.agent, "codex");
  assert.equal(valid.reporting.startReceipt.deliveredAt, lifecycle.startReceipt.deliveredAt);
  assert.equal(valid.reporting.startDestination, CONTROL_CONVERSATION_ID);
  assert.equal(Object.isFrozen(valid.reporting), true);
  assert.equal(Object.isFrozen(valid.reporting.watchdog.payload), true);
});

test("in-memory reporting preflight backstop fails closed before runtime access", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-reporting-backstop-"));

  // Direct unit surface: a valid in-memory config passes, and bundles or
  // contexts a caller tampered with after (or instead of) loading keep the
  // module's stable bounded codes.
  runReportingPreflight(makeConfig(root));
  assert.throws(
    () => runReportingPreflight(makeConfig(root, { reporting: undefined })),
    { message: "invalid_reporting_root", code: "invalid_reporting_root" }
  );
  assert.throws(
    () => runReportingPreflight(makeConfig(root, { lifecycle: undefined })),
    { message: "invalid_reporting_context", code: "invalid_reporting_context" }
  );
  assert.throws(
    () => runReportingPreflight(makeConfig(root, { model: 42 })),
    { message: "invalid_reporting_context", code: "invalid_reporting_context" }
  );
  const rerouted = makeConfig(root);
  rerouted.reporting = { ...rerouted.reporting, terminalDestination: "999888777666555444" };
  assert.throws(
    () => runReportingPreflight(rerouted),
    { message: "invalid_reporting_destination", code: "invalid_reporting_destination" }
  );

  // Through runSupervisor: the failure is emitted as a bounded
  // supervisor_error and the injected runtime module is never constructed.
  const { module, state } = makeRuntimeModule({});
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(root, { reporting: undefined }), {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(emitted.at(-1).type, "supervisor_error");
  assert.equal(emitted.at(-1).code, "invalid_reporting_root");
  assert.equal(state.runtimeOptions, undefined);
  assert.equal(fs.existsSync(path.join(root, "state")), false);
});

test("claude omitted model keeps the runtime-default reporting contract", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-reporting-no-model-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const lifecycle = rawLifecycle();
  const writeCase = (name, extra) => {
    const file = path.join(root, name + ".json");
    fs.writeFileSync(file, JSON.stringify({
      agent: "claude",
      auth: { kind: CLAUDE_AUTH_KIND, envFile: "/private/claude-acp-oauth.env" },
      cwd: root,
      sessionKey: "test-session",
      promptFile: prompt,
      responseFile: path.join(root, "response-" + name + ".txt"),
      stateDir: path.join(root, "state"),
      runtimeModule: root,
      timeoutMs: 30000,
      lifecycle,
      allowKinds: ["read"],
      ...extra
    }), { mode: 0o600 });
    return file;
  };

  // Claude has no supervisor-side omission default: a config without model
  // loads with model undefined when the templates use the runtime-default
  // label, and the normalized bundle keeps that label on the identity lines.
  const loaded = loadSupervisorConfig(writeCase("no-model", {
    reporting: validReporting(lifecycle, { agent: "claude", model: "runtime-default" })
  }));
  assert.equal(loaded.model, undefined);
  assert.match(loaded.reporting.startMessage, /`runtime-default`/);
  assert.equal(resolveConfiguredModel("claude", undefined), undefined);

  // Without model, templates claiming a concrete model are a mismatch, not a
  // silent pass: the identity line no longer matches the expected label.
  assert.throws(
    () => loadSupervisorConfig(writeCase("no-model-mismatch", {
      reporting: validReporting(lifecycle, { agent: "claude", model: "test-model" })
    })),
    { message: "invalid_reporting_start_message", code: "invalid_reporting_start_message" }
  );

  // The in-memory backstop agrees: a claude config without model binds its
  // reporting to the runtime-default label, not to any implicit default.
  const memRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-reporting-no-model-mem-"));
  const memLifecycle = parsedLifecycle();
  runReportingPreflight(makeConfig(memRoot, {
    agent: "claude",
    model: undefined,
    lifecycle: memLifecycle,
    reporting: validReporting(memLifecycle, { agent: "claude", model: "runtime-default" })
  }));
});

test("codex omitted model resolves to the explicit medium default on every surface", async () => {
  // Runtime selections are separate; the composite constant is reporting
  // metadata only and must never be sent back as the ACPX model value.
  assert.equal(CODEX_DEFAULT_MODEL, "gpt-5.6-sol");
  assert.equal(CODEX_DEFAULT_REASONING_EFFORT, "medium");
  assert.equal(CODEX_DEFAULT_MODEL_IDENTITY, "gpt-5.6-sol[medium]");
  assert.equal(resolveConfiguredModel("codex", undefined), CODEX_DEFAULT_MODEL);
  assert.equal(
    resolveConfiguredReasoningEffort("codex", undefined),
    CODEX_DEFAULT_REASONING_EFFORT
  );
  assert.equal(
    modelReportingIdentity("codex", CODEX_DEFAULT_MODEL, CODEX_DEFAULT_REASONING_EFFORT),
    CODEX_DEFAULT_MODEL_IDENTITY
  );
  assert.throws(
    () => resolveConfiguredModel("codex", "gpt-5.6-sol[low]"),
    { message: "codex_model_must_be_base_id", code: "codex_model_must_be_base_id" }
  );
  assert.equal(resolveConfiguredModel("claude", "test-model"), "test-model");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codex-default-model-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const lifecycle = rawLifecycle();
  const writeCase = (name, extra) => {
    const file = path.join(root, name + ".json");
    fs.writeFileSync(file, JSON.stringify({
      agent: "codex",
      cwd: root,
      sessionKey: "test-session",
      promptFile: prompt,
      responseFile: path.join(root, "response-" + name + ".txt"),
      stateDir: path.join(root, "state"),
      runtimeModule: root,
      timeoutMs: 30000,
      lifecycle,
      allowKinds: ["read"],
      ...extra
    }), { mode: 0o600 });
    return file;
  };

  // Loader: an omitted codex model is normalized to the explicit default
  // before reporting validation, so the loaded config carries the default and
  // the reporting bundle must bind its identity lines to the same explicit ID.
  const loaded = loadSupervisorConfig(writeCase("codex-no-model", {
    reporting: validReporting(lifecycle, { model: CODEX_DEFAULT_MODEL_IDENTITY })
  }));
  assert.equal(loaded.model, CODEX_DEFAULT_MODEL);
  assert.equal(loaded.reasoningEffort, CODEX_DEFAULT_REASONING_EFFORT);
  assert.ok(loaded.reporting.startMessage.includes("`" + CODEX_DEFAULT_MODEL_IDENTITY + "`"));

  // A codex bundle claiming runtime-default for an omitted model cannot load:
  // reporting is validated against the normalized explicit default.
  assert.throws(
    () => loadSupervisorConfig(writeCase("codex-runtime-default-claim", {
      reporting: validReporting(lifecycle, { model: "runtime-default" })
    })),
    { message: "invalid_reporting_start_message", code: "invalid_reporting_start_message" }
  );

  // The in-memory backstop rejects the same runtime-default claim, so a
  // config assembled without the loader cannot diverge either.
  const memRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codex-default-mem-"));
  const memLifecycle = parsedLifecycle();
  assert.throws(
    () => runReportingPreflight(makeConfig(memRoot, {
      model: undefined,
      lifecycle: memLifecycle,
      reporting: validReporting(memLifecycle, { model: "runtime-default" })
    })),
    { message: "invalid_reporting_start_message", code: "invalid_reporting_start_message" }
  );

  // End to end through runSupervisor: the started event and the runtime
  // session options both carry the explicit default — the adapter/backend
  // preset is never inherited for an omitted codex model.
  const { module, state } = makeRuntimeModule({
    events: [{ type: "text_delta", stream: "output", text: "ok" }]
  });
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(memRoot, {
    model: undefined,
    lifecycle: memLifecycle,
    reporting: validReporting(memLifecycle, { model: CODEX_DEFAULT_MODEL_IDENTITY })
  }), {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.completed);
  const started = emitted.find((event) => event.type === "started");
  assert.equal(started.model, CODEX_DEFAULT_MODEL_IDENTITY);
  assert.equal(started.reasoningEffort, CODEX_DEFAULT_REASONING_EFFORT);
  assert.equal("model" in state.ensureInput.sessionOptions, false);
  // codex-acp advertises id `reasoning_effort`, category `thought_level`,
  // and select values such as `medium`. Using the category as the id was the
  // production mismatch this literal regression guard must catch.
  assert.equal(CODEX_REASONING_CONFIG_KEY, "reasoning_effort");
  assert.deepEqual(
    state.configOptionInputs.map(({ key, value }) => ({ key, value })),
    [
      { key: CODEX_MODEL_CONFIG_KEY, value: CODEX_DEFAULT_MODEL },
      {
        key: CODEX_REASONING_CONFIG_KEY,
        value: CODEX_DEFAULT_REASONING_EFFORT
      }
    ]
  );
  assert.deepEqual(state.operationOrder, [
    "ensureSession",
    `setConfigOption:${CODEX_MODEL_CONFIG_KEY}`,
    `setConfigOption:${CODEX_REASONING_CONFIG_KEY}`,
    "startTurn"
  ]);
});

test("codex model and reasoning config fail closed before prompt start", async () => {
  const runCase = async (name, runtimeOptions) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `acp-codex-config-${name}-`));
    const lifecycle = parsedLifecycle();
    const { module, state } = makeRuntimeModule(runtimeOptions);
    const emitted = [];
    const exitCode = await runSupervisor(makeConfig(root, {
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      lifecycle,
      reporting: validReporting(lifecycle, { model: "gpt-5.6-sol[medium]" })
    }), {
      runtimeModule: module,
      bindSignals: false,
      writeEvent(event) {
        emitted.push(event);
      }
    });
    return { exitCode, emitted, state };
  };

  const missing = await runCase("missing-control", { omitSetConfigOption: true });
  assert.equal(missing.exitCode, EXIT_CODES.supervisorError);
  assert.equal(
    missing.emitted.at(-1).code,
    "acpx_runtime_instance_missing_setConfigOption"
  );
  assert.equal(missing.state.ensureInput, undefined);
  assert.equal(missing.state.turnInput, undefined);

  const modelRejected = await runCase("model-rejected", {
    onSetConfigOption(input) {
      if (input.key === CODEX_MODEL_CONFIG_KEY) {
        throw new Error("private adapter model detail");
      }
    }
  });
  assert.equal(modelRejected.exitCode, EXIT_CODES.supervisorError);
  assert.equal(modelRejected.emitted.at(-1).code, "codex_model_config_apply_failed");
  assert.equal(modelRejected.state.configOptionInputs.length, 1);
  assert.equal(modelRejected.state.turnInput, undefined);
  assert.equal(modelRejected.state.closeAttempts, 1);

  const reasoningRejected = await runCase("reasoning-rejected", {
    onSetConfigOption(input) {
      if (input.key === CODEX_REASONING_CONFIG_KEY) {
        throw new Error("private adapter reasoning detail");
      }
    }
  });
  assert.equal(reasoningRejected.exitCode, EXIT_CODES.supervisorError);
  assert.equal(
    reasoningRejected.emitted.at(-1).code,
    "codex_reasoning_config_apply_failed"
  );
  assert.deepEqual(
    reasoningRejected.state.configOptionInputs.map((input) => input.key),
    [CODEX_MODEL_CONFIG_KEY, CODEX_REASONING_CONFIG_KEY]
  );
  assert.equal(reasoningRejected.state.turnInput, undefined);
  assert.equal(reasoningRejected.state.closeAttempts, 1);

  assert.throws(
    () => resolveConfiguredReasoningEffort("claude", "medium"),
    {
      message: "reasoning_effort_unsupported_agent",
      code: "reasoning_effort_unsupported_agent"
    }
  );
});

test("codex accepts base model IDs and fails closed on composite or malformed IDs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-model-grammar-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const lifecycle = rawLifecycle();
  const writeCase = (name, extra) => {
    const file = path.join(root, name + ".json");
    fs.writeFileSync(file, JSON.stringify({
      agent: "codex",
      cwd: root,
      sessionKey: "test-session",
      promptFile: prompt,
      responseFile: path.join(root, "response-" + name + ".txt"),
      stateDir: path.join(root, "state"),
      runtimeModule: root,
      timeoutMs: 30000,
      lifecycle,
      allowKinds: ["read"],
      ...extra
    }), { mode: 0o600 });
    return file;
  };

  // Codex accepts only base identifier-grammar model IDs. Reporting composes
  // those base IDs with the separately defaulted reasoning effort.
  const valid = [
    ["plain", "test-model"],
    ["plain-dotted", "gpt-5.2"],
    ["max-reporting-length", "m".repeat(248)]
  ];
  for (const [name, model] of valid) {
    const reportingModel = `${model}[${CODEX_DEFAULT_REASONING_EFFORT}]`;
    const loaded = loadSupervisorConfig(writeCase(name, {
      model,
      reporting: validReporting(lifecycle, { model: reportingModel })
    }));
    assert.equal(loaded.model, model, name);
    assert.ok(loaded.reporting.startMessage.includes("`" + reportingModel + "`"), name);
  }

  for (const model of ["gpt-5.6-sol[low]", "gpt-5.2[high]"]) {
    assert.throws(
      () => loadSupervisorConfig(writeCase("composite-" + model, {
        model,
        reporting: validReporting(lifecycle, { model })
      })),
      {
        message: "codex_model_must_be_base_id",
        code: "codex_model_must_be_base_id"
      },
      model
    );
  }

  // Malformed bracket forms fail closed with the stable invalid_model code:
  // empty suffix, unmatched or nested brackets, repeated suffixes, trailing
  // characters, a suffix-only value, whitespace, controls, backticks,
  // unrelated punctuation, and the over-length boundary.
  const invalid = [
    ["empty-suffix", "gpt-5.2[]"],
    ["unmatched-open", "gpt-5.2[high"],
    ["unmatched-close", "gpt-5.2]high"],
    ["close-before-open", "gpt-5.2]high["],
    ["nested", "gpt-5.2[[high]]"],
    ["double-suffix", "gpt-5.2[low][high]"],
    ["trailing-after-close", "gpt-5.2[high]x"],
    ["suffix-only", "[high]"],
    ["inner-whitespace", "gpt-5.2[hi gh]"],
    ["outer-whitespace", "gpt-5.2 [high]"],
    ["inner-punctuation", "gpt-5.2[high;]"],
    ["inner-hyphen", "gpt-5.2[extra-high]"],
    ["backtick", "gpt-5.2[`high`]"],
    ["control", "gpt-5.2[high]\n"],
    ["over-length", "m".repeat(257)]
  ];
  for (const [name, model] of invalid) {
    assert.throws(
      () => loadSupervisorConfig(writeCase(name, {
        model,
        reporting: validReporting(lifecycle, { model })
      })),
      { message: "invalid_model", code: "invalid_model" },
      name
    );
  }

  // The generic identifier grammar was not relaxed: a bracketed agent name is
  // still rejected before the closed-set gate or any other validation runs.
  assert.throws(
    () => loadSupervisorConfig(writeCase("bracketed-agent", {
      agent: "codex[high]",
      model: "test-model",
      reporting: validReporting(lifecycle)
    })),
    { message: "invalid_agent", code: "invalid_agent" }
  );
});

test("claude bracketed model ID reaches runtime session options unchanged", {
  skip: process.platform === "win32"
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-model-passthrough-"));
  const envFile = makeClaudeAuthFixture(root);
  const model = "claude-fable-5[1m]";
  const lifecycle = parsedLifecycle();
  const { module, state } = makeRuntimeModule({
    events: [{ type: "text_delta", stream: "output", text: "bounded result" }]
  });
  const emitted = [];
  const exitCode = await runSupervisor(makeClaudeConfig(root, envFile, {
    model,
    lifecycle,
    reporting: validReporting(lifecycle, { agent: "claude", model })
  }), {
    runtimeModule: module,
    bindSignals: false,
    env: claudeEnv(envFile),
    execArgv: ["--env-file=" + envFile],
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.completed);
  assert.equal(state.ensureInput.sessionOptions.model, model);
  assert.deepEqual(state.configOptionInputs, []);
  const started = emitted.find((event) => event.type === "started");
  assert.equal(started.model, model);
  assert.equal(emitted.at(-1).type, "terminal");
  assert.equal(emitted.at(-1).status, "completed");
});

test("claude openclaw provider-prefixed model fails closed before runtime access on both paths", async () => {
  // Unit surface: the shared resolver rejects the OpenClaw provider/catalog
  // namespace for canonical claude only, in any letter case, with one stable
  // bounded code. Canonical adapter-advertised Claude IDs — including the
  // bracketed ACPX form — pass through byte-for-byte, and slash-containing
  // IDs for other agents are untouched.
  for (const model of ["anthropic/claude-fable-5", "Anthropic/claude-opus-5", "anthropic/x"]) {
    assert.throws(
      () => resolveConfiguredModel("claude", model),
      {
        message: "invalid_model_openclaw_provider_key",
        code: "invalid_model_openclaw_provider_key"
      },
      model
    );
  }
  assert.equal(resolveConfiguredModel("claude", "claude-fable-5"), "claude-fable-5");
  assert.equal(resolveConfiguredModel("claude", "claude-opus-5"), "claude-opus-5");
  assert.equal(resolveConfiguredModel("claude", "claude-fable-5[1m]"), "claude-fable-5[1m]");
  assert.equal(
    resolveConfiguredModel("codex", "anthropic/claude-fable-5"),
    "anthropic/claude-fable-5"
  );
  assert.equal(resolveConfiguredModel("codex", "openai/gpt-5.2"), "openai/gpt-5.2");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-provider-prefix-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const lifecycle = rawLifecycle();
  const writeCase = (name, extra) => {
    const file = path.join(root, name + ".json");
    fs.writeFileSync(file, JSON.stringify({
      agent: "claude",
      auth: { kind: CLAUDE_AUTH_KIND, envFile: "/private/claude-acp-oauth.env" },
      cwd: root,
      sessionKey: "test-session",
      promptFile: prompt,
      responseFile: path.join(root, "response-" + name + ".txt"),
      stateDir: path.join(root, "state"),
      runtimeModule: root,
      timeoutMs: 30000,
      lifecycle,
      allowKinds: ["read"],
      ...extra
    }), { mode: 0o600 });
    return file;
  };

  // On-disk path: the loader rejects the provider-prefixed key as invalid
  // config, and main keeps the invalid-config exit mapping — a bounded
  // supervisor_error on stdout and EXIT_CODES.invalidConfig, with no runtime
  // import, probe, or state side effect.
  const badConfig = writeCase("provider-prefixed", {
    model: "anthropic/claude-fable-5",
    reporting: validReporting(lifecycle, { agent: "claude", model: "anthropic/claude-fable-5" })
  });
  assert.throws(
    () => loadSupervisorConfig(badConfig),
    {
      message: "invalid_model_openclaw_provider_key",
      code: "invalid_model_openclaw_provider_key"
    }
  );
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  let exitCode;
  try {
    exitCode = await main(["--config", badConfig]);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(exitCode, EXIT_CODES.invalidConfig);
  const cliEmitted = JSON.parse(writes.join("").trim());
  assert.equal(cliEmitted.type, "supervisor_error");
  assert.equal(cliEmitted.code, "invalid_model_openclaw_provider_key");
  assert.equal(fs.existsSync(path.join(root, "state")), false);

  // Canonical adapter-advertised Claude IDs still load through the same
  // preflight, bracketed form included.
  for (const model of ["claude-fable-5", "claude-opus-5", "claude-fable-5[1m]"]) {
    const loaded = loadSupervisorConfig(writeCase("canonical-" + model.replace(/[^a-z0-9-]/g, ""), {
      model,
      reporting: validReporting(lifecycle, { agent: "claude", model })
    }));
    assert.equal(loaded.model, model);
    assert.ok(loaded.reporting.startMessage.includes("`" + model + "`"), model);
  }

  // In-memory path: runSupervisor fails closed with the same stable code and
  // the supervisor-error exit before the injected runtime module is ever
  // constructed — no probe, no adapter startup, no state directory. The
  // reporting-preflight backstop rejects the same config when invoked
  // directly.
  const memRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-provider-prefix-mem-"));
  const memLifecycle = parsedLifecycle();
  const memConfig = makeConfig(memRoot, {
    agent: "claude",
    auth: { kind: CLAUDE_AUTH_KIND, envFile: "/private/claude-acp-oauth.env" },
    model: "anthropic/claude-fable-5",
    lifecycle: memLifecycle,
    reporting: validReporting(memLifecycle, {
      agent: "claude",
      model: "anthropic/claude-fable-5"
    })
  });
  assert.throws(
    () => runReportingPreflight(memConfig),
    {
      message: "invalid_model_openclaw_provider_key",
      code: "invalid_model_openclaw_provider_key"
    }
  );
  const { module, state } = makeRuntimeModule({});
  const emitted = [];
  const memExitCode = await runSupervisor(memConfig, {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(memExitCode, EXIT_CODES.supervisorError);
  assert.equal(emitted.at(-1).type, "supervisor_error");
  assert.equal(emitted.at(-1).code, "invalid_model_openclaw_provider_key");
  assert.equal(state.runtimeOptions, undefined);
  assert.equal(fs.existsSync(path.join(memRoot, "state")), false);
});

test("public docs describe separate Codex model and reasoning config", () => {
  const skill = fs.readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
  const contract = fs.readFileSync(
    new URL("../references/runtime-contract.md", import.meta.url),
    "utf8"
  );
  const ackTemplate = JSON.parse(fs.readFileSync(
    new URL("../templates/host-transport-ack-report.json", import.meta.url),
    "utf8"
  ));

  for (const doc of [skill, contract]) {
    assert.match(doc, /gpt-5\.6-sol/);
    assert.match(doc, /reasoningEffort/);
    assert.match(doc, /medium/);
    assert.match(doc, /reasoning_effort/);
    assert.match(doc, /thought_level/);
    assert.match(doc, /codex_model_config_apply_failed/);
    assert.match(doc, /codex_reasoning_config_apply_failed/);
    assert.match(doc, /codex_model_must_be_base_id/);
    // The composed value remains public reporting metadata only.
    assert.match(doc, /gpt-5\.6-sol\[medium\]/);
    assert.match(doc, /runtime-default/);
    // Both docs distinguish the adapter-advertised ACP model ID from the
    // OpenClaw provider/catalog key and name the stable rejection code.
    assert.match(doc, /`claude-fable-5`/);
    assert.match(doc, /anthropic\//);
    assert.match(doc, /invalid_model_openclaw_provider_key/);
  }
  assert.match(skill, /"model": "gpt-5\.6-sol"/);
  assert.match(skill, /"reasoningEffort": "medium"/);
  assert.match(skill, /anthropic\/claude-fable-5/);
  assert.match(contract, /claude-fable-5\[1m\]/);
  assert.match(contract, /sessionOptions\.model/);
  assert.equal(
    ackTemplate.receipt.deliveredAt,
    "2026-08-31T10:00:05.000000+00:00"
  );
});

test("metadata containing forbidden-pattern words loads while free-text slots stay screened", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-reporting-metadata-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const lifecycle = rawLifecycle();
  const writeCase = (name, reporting) => {
    const file = path.join(root, name + ".json");
    fs.writeFileSync(file, JSON.stringify({
      agent: "codex",
      model: "test-model",
      cwd: root,
      sessionKey: "test-session",
      promptFile: prompt,
      responseFile: path.join(root, "response-" + name + ".txt"),
      stateDir: path.join(root, "state"),
      runtimeModule: root,
      timeoutMs: 30000,
      lifecycle,
      allowKinds: ["read"],
      reporting
    }), { mode: 0o600 });
    return file;
  };

  // Ordinary repository/branch names that merely contain denylisted words are
  // legal metadata through the full loader path.
  const cases = [
    ["fix-routing", { branch: "fix/routing" }],
    ["cron-schedule", { branch: "feat/cron-schedule" }],
    ["snapshot-tool", { repository: "snapshot-tool" }]
  ];
  for (const [name, overrides] of cases) {
    const loaded = loadSupervisorConfig(
      writeCase(name, validReporting(lifecycle, overrides))
    );
    if (overrides.branch) {
      assert.equal(loaded.reporting.branch, overrides.branch, name);
    }
    if (overrides.repository) {
      assert.equal(loaded.reporting.repository, overrides.repository, name);
    }
  }

  // The same words in a free-text slot still fail closed.
  assert.throws(
    () => loadSupervisorConfig(writeCase("screened-bullet", validReporting(lifecycle, {
      scopeBullet: "- 스케줄러 cron 상태 점검"
    }))),
    { message: "invalid_reporting_forbidden_content", code: "invalid_reporting_forbidden_content" }
  );
});

test("fresh same-conversation start receipt reaches the runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-receipt-fresh-"));
  const deliveredAtMs = Date.parse("2026-08-22T09:30:00.000Z");
  const { module, state } = makeRuntimeModule();
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(root, {
    lifecycle: parsedLifecycle({ maxStartReceiptAgeMs: 60000 }, { deliveredAtMs })
  }), {
    runtimeModule: module,
    bindSignals: false,
    now: () => deliveredAtMs + 60000,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.completed);
  assert.ok(state.runtimeOptions);
  assert.equal(emitted.at(-1).type, "terminal");
  assert.equal(emitted.at(-1).status, "completed");
});

test("start-receipt freshness boundaries are exact", () => {
  const deliveredAtMs = Date.parse("2026-08-22T09:30:00.000Z");
  const config = { lifecycle: parsedLifecycle({ maxStartReceiptAgeMs: 60000 }, { deliveredAtMs }) };

  runStartReceiptPreflight(config, deliveredAtMs + 60000);
  runStartReceiptPreflight(config, deliveredAtMs - 1000);
  assert.throws(
    () => runStartReceiptPreflight(config, deliveredAtMs + 60001),
    { code: "start_receipt_stale" }
  );
  assert.throws(
    () => runStartReceiptPreflight(config, deliveredAtMs - 1001),
    { code: "start_receipt_future" }
  );
});

test("direct preflight re-asserts the documented freshness window bounds", () => {
  const deliveredAtMs = Date.parse("2026-08-22T09:30:00.000Z");
  const withAge = (maxStartReceiptAgeMs) => ({
    lifecycle: parsedLifecycle({ maxStartReceiptAgeMs }, { deliveredAtMs })
  });

  runStartReceiptPreflight(withAge(1000), deliveredAtMs + 1000);
  runStartReceiptPreflight(withAge(3600000), deliveredAtMs + 3600000);
  for (const outOfRange of [0, 999, 3600001, 86400000, 60000.5]) {
    assert.throws(
      () => runStartReceiptPreflight(withAge(outOfRange), deliveredAtMs),
      { code: "start_receipt_missing" },
      String(outOfRange)
    );
  }
});

test("direct preflight rejects numeric identifiers without coercion", () => {
  const deliveredAtMs = Date.parse("2026-08-22T09:30:00.000Z");
  const numericControl = Number(CONTROL_CONVERSATION_ID);
  const cases = [
    ["control", parsedLifecycle({ controlConversationId: numericControl }, { deliveredAtMs })],
    ["conversation", parsedLifecycle({}, { conversationId: numericControl, deliveredAtMs })],
    ["message", parsedLifecycle({}, { messageId: Number(START_MESSAGE_ID), deliveredAtMs })],
    [
      "self-consistent-numbers",
      parsedLifecycle(
        { controlConversationId: numericControl },
        {
          conversationId: numericControl,
          messageId: Number(START_MESSAGE_ID),
          deliveredAtMs
        }
      )
    ]
  ];

  for (const [name, lifecycle] of cases) {
    assert.throws(
      () => runStartReceiptPreflight({ lifecycle }, deliveredAtMs),
      { code: "start_receipt_missing" },
      name
    );
  }
});

test("rejected start receipts fail closed before runtime loading and probing", async () => {
  const deliveredAtMs = Date.parse("2026-08-22T09:30:00.000Z");
  const cases = [
    ["absent", undefined, deliveredAtMs, "start_receipt_missing"],
    ["receipt-absent", parsedLifecycle({ startReceipt: undefined }), deliveredAtMs, "start_receipt_missing"],
    [
      "unparsed-delivery",
      parsedLifecycle({}, { deliveredAtMs: "2026-08-22T09:30:00.000Z" }),
      deliveredAtMs,
      "start_receipt_missing"
    ],
    [
      "mismatch",
      parsedLifecycle({}, { conversationId: "100000000000000009", deliveredAtMs }),
      deliveredAtMs,
      "start_receipt_conversation_mismatch"
    ],
    [
      "future",
      parsedLifecycle({}, { deliveredAtMs }),
      deliveredAtMs - 1001,
      "start_receipt_future"
    ],
    [
      "stale",
      parsedLifecycle({ maxStartReceiptAgeMs: 60000 }, { deliveredAtMs }),
      deliveredAtMs + 60001,
      "start_receipt_stale"
    ],
    // A JSON number is not a decimal identifier spelling. Coercing it would
    // let a hand-built config satisfy both the digit shape and the
    // same-conversation comparison without ever holding a chat identifier.
    [
      "numeric-message-id",
      parsedLifecycle({}, { messageId: Number(START_MESSAGE_ID), deliveredAtMs }),
      deliveredAtMs,
      "start_receipt_missing"
    ],
    [
      "numeric-conversation-ids",
      parsedLifecycle(
        { controlConversationId: Number(CONTROL_CONVERSATION_ID) },
        { conversationId: Number(CONTROL_CONVERSATION_ID), deliveredAtMs }
      ),
      deliveredAtMs,
      "start_receipt_missing"
    ],
    // The documented 1000-3600000 freshness window is re-asserted here, not
    // only at config load, so an in-memory config cannot widen or collapse it.
    [
      "age-below-floor",
      parsedLifecycle({ maxStartReceiptAgeMs: 999 }, { deliveredAtMs }),
      deliveredAtMs,
      "start_receipt_missing"
    ],
    [
      "age-above-ceiling",
      parsedLifecycle({ maxStartReceiptAgeMs: 86400000 }, { deliveredAtMs }),
      deliveredAtMs + 3600001,
      "start_receipt_missing"
    ],
    [
      "age-fractional",
      parsedLifecycle({ maxStartReceiptAgeMs: 60000.5 }, { deliveredAtMs }),
      deliveredAtMs,
      "start_receipt_missing"
    ]
  ];

  for (const [name, lifecycle, nowMs, expected] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-receipt-reject-"));
    const config = makeConfig(root, {
      lifecycle,
      runtimeModule: path.join(root, "missing-runtime")
    });
    const emitted = [];
    const exitCode = await runSupervisor(config, {
      bindSignals: false,
      now: () => nowMs,
      writeEvent(event) {
        emitted.push(event);
      }
    });
    assert.equal(exitCode, EXIT_CODES.supervisorError, name);
    assert.equal(emitted.at(-1).type, "supervisor_error", name);
    assert.equal(emitted.at(-1).code, expected, name);
    assert.equal(fs.existsSync(config.stateDir), false, name);
    assert.equal(fs.existsSync(config.responseFile), false, name);
  }
});

test("start-receipt identifiers stay out of normalized output", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-receipt-quiet-"));
  const { module } = makeRuntimeModule({
    events: [{ type: "text_delta", stream: "output", text: "bounded result" }]
  });
  const config = makeConfig(root);
  const emitted = [];
  assert.equal(await runSupervisor(config, {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  }), EXIT_CODES.completed);

  const serialized = JSON.stringify(emitted);
  assert.equal(serialized.includes(CONTROL_CONVERSATION_ID), false);
  assert.equal(serialized.includes(START_MESSAGE_ID), false);
  assert.equal(
    fs.readFileSync(config.responseFile, "utf8").includes(START_MESSAGE_ID),
    false
  );
});

test("public docs and template describe the start-receipt gate", () => {
  const skill = fs.readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
  const contract = fs.readFileSync(
    new URL("../references/runtime-contract.md", import.meta.url),
    "utf8"
  );
  const template = JSON.parse(fs.readFileSync(
    new URL("../templates/supervisor-config.json", import.meta.url),
    "utf8"
  ));

  assert.match(contract, /^## Start-receipt gate$/m);
  for (const doc of [skill, contract]) {
    assert.match(doc, /controlConversationId/);
    assert.match(doc, /startReceipt/);
    assert.match(doc, /caller-attested receipt metadata/);
  }

  assert.equal(
    template.lifecycle.startReceipt.conversationId,
    template.lifecycle.controlConversationId
  );
  assert.equal(template.lifecycle.maxStartReceiptAgeMs, 300000);
  assert.equal(typeof template.lifecycle.startReceipt.messageId, "string");
  assert.equal(typeof template.lifecycle.startReceipt.deliveredAt, "string");
  assert.doesNotMatch(skill + contract + JSON.stringify(template), /\b\d{15,}\b/);
});

test("public docs and template describe the generic environment preflight", () => {
  const skill = fs.readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
  const contract = fs.readFileSync(
    new URL("../references/runtime-contract.md", import.meta.url),
    "utf8"
  );
  const template = JSON.parse(fs.readFileSync(
    new URL("../templates/supervisor-config.json", import.meta.url),
    "utf8"
  ));

  assert.match(contract, /^## Environment preflight$/m);
  for (const doc of [skill, contract]) {
    assert.match(doc, /requiredEnv/);
    assert.match(doc, /forbiddenEnv/);
    assert.match(doc, /does not prove how a variable was injected/);
  }
  assert.deepEqual(template.requiredEnv, []);
  assert.deepEqual(template.forbiddenEnv, []);
});

test("template ships the two-hour emergency timeout ceiling", () => {
  const template = JSON.parse(fs.readFileSync(
    new URL("../templates/supervisor-config.json", import.meta.url),
    "utf8"
  ));
  assert.equal(template.timeoutMs, 7200000);
});

test("public docs separate tmux transport ownership from host caller blocking", () => {
  const skill = fs.readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
  const contract = fs.readFileSync(
    new URL("../references/runtime-contract.md", import.meta.url),
    "utf8"
  );

  assert.match(contract, /^## Host wait boundaries$/m);
  assert.match(contract, /^## Host activation and lifecycle ledger$/m);
  for (const doc of [skill, contract]) {
    assert.match(doc, /1, 2, 4, and then 5 seconds/);
    assert.match(doc, /exact non-empty (?:process|session) handle/);
    assert.match(doc, /acp-host-transport-cli\.mjs/);
    assert.match(doc, /prepare/);
    assert.match(doc, /activate/);
    assert.match(doc, /acp-host-activation\.v1/);
    assert.match(doc, /tracking_lost/);
    assert.match(doc, /acp-lifecycle-reconcile-cli\.mjs/);
    assert.match(doc, /unless the message explicitly cancels or replaces it/);
    assert.match(
      doc,
      /both the matching normalized terminal event and the mapped/
    );
  }

  assert.doesNotMatch(skill + contract, /exec_command|write_stdin/);

  assert.doesNotMatch(skill + contract, /ten-minute|10-minute/i);
  assert.match(
    contract,
    /discover or reconstruct a lost host handle/
  );
});

test("runtime location rejects a symlinked package root", {
  skip: process.platform === "win32"
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-runtime-link-"));
  const realRoot = path.join(root, "real");
  const linkedRoot = path.join(root, "linked");
  fs.mkdirSync(realRoot);
  fs.symlinkSync(realRoot, linkedRoot);
  assert.throws(
    () => discoverRuntimeLocation({ runtimeModule: linkedRoot }),
    /invalid_runtime_module_symlink/
  );
});

test("independent deadline cancels and fails closed without an exact result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-deadline-"));
  const never = deferred();
  const { module, state } = makeRuntimeModule({ result: never.promise });
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(root, { timeoutMs: 10 }), {
    runtimeModule: module,
    bindSignals: false,
    deadlineGraceMs: 10,
    eventDrainTimeoutMs: 5,
    eventCloseGraceMs: 5,
    cleanupTimeoutMs: 20,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(state.cancelCalls, 1);
  assert.equal(emitted.at(-1).type, "supervisor_error");
  assert.equal(emitted.at(-1).code, "supervisor_timeout");
});

test("progress snapshots expose evidence age before the exact result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-progress-"));
  const terminal = deferred();
  const { module } = makeRuntimeModule({ result: terminal.promise });
  const emitted = [];
  const run = runSupervisor(makeConfig(root, {
    timeoutMs: 1000,
    progressMs: 5
  }), {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 18));
  terminal.resolve({ status: "completed", stopReason: "end_turn" });
  assert.equal(await run, EXIT_CODES.completed);
  const snapshots = emitted.filter((event) => event.type === "progress");
  assert.ok(snapshots.length >= 1);
  assert.ok(snapshots.every((event) => Number.isFinite(event.evidenceAgeMs)));
});

test("pending signal cancels the exact turn and stays bound through terminal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-signal-"));
  const terminal = deferred();
  const signalSource = new EventEmitter();
  let listenersAtTerminal = 0;
  const { module, state } = makeRuntimeModule({
    result: terminal.promise,
    onProbe() {
      signalSource.emit("SIGTERM");
    },
    onCancel() {
      terminal.resolve({ status: "cancelled", stopReason: "cancelled" });
    }
  });
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(root), {
    runtimeModule: module,
    signalSource,
    writeEvent(event) {
      emitted.push(event);
      if (event.type === "terminal") {
        listenersAtTerminal = signalSource.listenerCount("SIGTERM");
      }
    }
  });
  assert.equal(exitCode, EXIT_CODES.cancelled);
  assert.equal(state.cancelCalls, 1);
  assert.equal(listenersAtTerminal, 1);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  assert.equal(emitted.at(-1).type, "terminal");
});

test("terminal is structurally the final event after a late stream", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-terminal-last-"));
  const { module } = makeRuntimeModule({
    eventFactory() {
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise((resolve) => setTimeout(resolve, 25));
          yield { type: "status", tag: "usage_update", used: 1, size: 2 };
        }
      };
    }
  });
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(root), {
    runtimeModule: module,
    bindSignals: false,
    eventDrainTimeoutMs: 5,
    eventCloseGraceMs: 5,
    cleanupTimeoutMs: 20,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(emitted.at(-1).type, "terminal");
  assert.equal(
    emitted.filter((event) => event.type === "terminal").length,
    1
  );
});

const DUMMY_CLAUDE_TOKEN = "test-dummy-oauth-token-value-0123456789";
const POSIX_ONLY = { skip: process.platform === "win32" };

function makeClaudeAuthFixture(root, options = {}) {
  const authDir = path.join(root, "auth");
  fs.mkdirSync(authDir, { mode: 0o700 });
  fs.chmodSync(authDir, options.parentMode ?? 0o700);
  const envFile = path.join(authDir, "claude-acp-oauth.env");
  const content = options.content ??
    (CLAUDE_OAUTH_TOKEN_ENV + "=" + (options.token ?? DUMMY_CLAUDE_TOKEN) + "\n");
  fs.writeFileSync(envFile, content, { mode: 0o600 });
  fs.chmodSync(envFile, options.fileMode ?? 0o600);
  return envFile;
}

function makeClaudeConfig(root, envFile, overrides = {}) {
  return makeConfig(root, {
    agent: "claude",
    auth: { kind: CLAUDE_AUTH_KIND, envFile },
    ...overrides
  });
}

function claudeEnv(envFile, overrides = {}) {
  return { [CLAUDE_OAUTH_TOKEN_ENV]: DUMMY_CLAUDE_TOKEN, ...overrides };
}

test("claude config requires the exact setup-token auth profile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-auth-config-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const lifecycle = rawLifecycle();
  const base = {
    agent: "claude",
    model: "test-model",
    cwd: root,
    sessionKey: "test-session",
    promptFile: prompt,
    stateDir: path.join(root, "state"),
    runtimeModule: root,
    timeoutMs: 30000,
    lifecycle,
    reporting: validReporting(lifecycle, { agent: "claude" }),
    allowKinds: ["read"]
  };
  let caseIndex = 0;
  const writeCase = (extra) => {
    caseIndex += 1;
    const file = path.join(root, "case-" + String(caseIndex) + ".json");
    fs.writeFileSync(file, JSON.stringify({
      ...base,
      responseFile: path.join(root, "response-" + String(caseIndex) + ".txt"),
      ...extra
    }), { mode: 0o600 });
    return file;
  };

  const invalid = [
    [{}, "invalid_auth"],
    [{ auth: "claude-setup-token-env-file" }, "invalid_auth"],
    [{ auth: [] }, "invalid_auth"],
    [{ auth: { kind: CLAUDE_AUTH_KIND } }, "invalid_auth"],
    [{
      auth: { kind: CLAUDE_AUTH_KIND, envFile: "/private/x.env", extra: true }
    }, "invalid_auth"],
    [{ auth: { kind: "api-key", envFile: "/private/x.env" } }, "invalid_auth_kind"],
    [{ auth: { kind: CLAUDE_AUTH_KIND, envFile: 7 } }, "invalid_auth_env_file"],
    [{
      auth: { kind: CLAUDE_AUTH_KIND, envFile: "relative/x.env" }
    }, "invalid_auth_env_file_not_absolute"],
    [{
      auth: { kind: CLAUDE_AUTH_KIND, envFile: "/private/x.env" },
      requiredEnv: ["ANTHROPIC_API_KEY"]
    }, "invalid_env_contract_overlap"],
    [{
      auth: { kind: CLAUDE_AUTH_KIND, envFile: "/private/x.env" },
      requiredEnv: ["NODE_OPTIONS"]
    }, "invalid_env_contract_overlap"],
    [{
      auth: { kind: CLAUDE_AUTH_KIND, envFile: "/private/x.env" },
      forbiddenEnv: ["claude_code_oauth_token"]
    }, "invalid_env_contract_overlap"],
    [{
      agent: "codex",
      auth: { kind: CLAUDE_AUTH_KIND, envFile: "/private/x.env" }
    }, "invalid_auth_agent"]
  ];
  for (const [extra, expected] of invalid) {
    assert.throws(
      () => loadSupervisorConfig(writeCase(extra)),
      { message: expected, code: expected },
      expected
    );
  }

  const valid = loadSupervisorConfig(writeCase({
    auth: { kind: CLAUDE_AUTH_KIND, envFile: "/private/claude-acp-oauth.env" }
  }));
  assert.deepEqual(valid.auth, {
    kind: CLAUDE_AUTH_KIND,
    envFile: path.normalize("/private/claude-acp-oauth.env")
  });

  const generic = loadSupervisorConfig(writeCase({
    agent: "codex",
    reporting: validReporting(lifecycle, { agent: "codex" }),
    requiredEnv: ["ANTHROPIC_API_KEY"]
  }));
  assert.equal(generic.auth, undefined);
  assert.deepEqual(generic.requiredEnv, ["ANTHROPIC_API_KEY"]);
});

test("missing claude auth keeps the invalid-config CLI mapping", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-auth-cli-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const configFile = path.join(root, "run.json");
  fs.writeFileSync(configFile, JSON.stringify({
    agent: "claude",
    cwd: root,
    sessionKey: "test-session",
    promptFile: prompt,
    responseFile: path.join(root, "response.txt"),
    stateDir: path.join(root, "state"),
    runtimeModule: root,
    timeoutMs: 30000,
    lifecycle: rawLifecycle(),
    allowKinds: ["read"]
  }), { mode: 0o600 });

  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  let exitCode;
  try {
    exitCode = await main(["--config", configFile]);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(exitCode, EXIT_CODES.invalidConfig);
  const emitted = JSON.parse(writes.join("").trim());
  assert.equal(emitted.type, "supervisor_error");
  assert.equal(emitted.code, "invalid_auth");
});

test("claude auth env file validation fails closed without disclosure", POSIX_ONLY, () => {
  const cases = [
    [{ content: "" }, "claude_env_file_size"],
    [{ content: "X".repeat(4097) }, "claude_env_file_size"],
    [{ content: "ANTHROPIC_API_KEY=" + DUMMY_CLAUDE_TOKEN + "\n" }, "claude_env_file_format"],
    [{
      content: CLAUDE_OAUTH_TOKEN_ENV + "=" + DUMMY_CLAUDE_TOKEN + "\nEXTRA_VAR=x\n"
    }, "claude_env_file_format"],
    [{
      content: CLAUDE_OAUTH_TOKEN_ENV + "=" + DUMMY_CLAUDE_TOKEN + "\n\n"
    }, "claude_env_file_format"],
    [{ content: CLAUDE_OAUTH_TOKEN_ENV + "=\n" }, "claude_env_file_format"],
    [{
      content: CLAUDE_OAUTH_TOKEN_ENV + "=\"" + DUMMY_CLAUDE_TOKEN + "\"\n"
    }, "claude_env_file_format"],
    [{
      content: CLAUDE_OAUTH_TOKEN_ENV + "='" + DUMMY_CLAUDE_TOKEN + "'\n"
    }, "claude_env_file_format"],
    [{ content: CLAUDE_OAUTH_TOKEN_ENV + "=$HOME_TOKEN\n" }, "claude_env_file_format"],
    [{
      content: "# comment\n" + CLAUDE_OAUTH_TOKEN_ENV + "=" + DUMMY_CLAUDE_TOKEN + "\n"
    }, "claude_env_file_format"],
    [{
      content: CLAUDE_OAUTH_TOKEN_ENV + "=" + DUMMY_CLAUDE_TOKEN + " \n"
    }, "claude_env_file_format"],
    [{
      content: CLAUDE_OAUTH_TOKEN_ENV + "=" + DUMMY_CLAUDE_TOKEN + "\r\n"
    }, "claude_env_file_format"],
    [{ fileMode: 0o644 }, "claude_env_file_permissions"],
    [{ fileMode: 0o640 }, "claude_env_file_permissions"],
    [{ parentMode: 0o755 }, "claude_env_file_parent_permissions"],
    [{ parentMode: 0o750 }, "claude_env_file_parent_permissions"]
  ];
  for (const [options, expected] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-envfile-"));
    const envFile = makeClaudeAuthFixture(root, options);
    let observed;
    try {
      validateClaudeAuthEnvFile(envFile);
    } catch (error) {
      observed = error;
    }
    assert.ok(observed, expected);
    assert.equal(observed.code, expected);
    assert.equal(String(observed.message).includes(DUMMY_CLAUDE_TOKEN), false);
  }

  assert.throws(
    () => validateClaudeAuthEnvFile("relative/claude.env"),
    { code: "claude_env_file_not_absolute" }
  );
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-envfile-"));
  fs.chmodSync(missingRoot, 0o700);
  assert.throws(
    () => validateClaudeAuthEnvFile(path.join(missingRoot, "missing.env")),
    { code: "claude_env_file_missing" }
  );
  assert.throws(
    () => validateClaudeAuthEnvFile(path.join(missingRoot, "gone", "missing.env")),
    { code: "claude_env_file_parent_missing" }
  );

  const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-envlink-"));
  const realEnvFile = makeClaudeAuthFixture(linkRoot);
  const linkFile = path.join(path.dirname(realEnvFile), "link.env");
  fs.symlinkSync(realEnvFile, linkFile);
  assert.throws(
    () => validateClaudeAuthEnvFile(linkFile),
    { code: "claude_env_file_symlink" }
  );

  const linkedParentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-envparent-"));
  makeClaudeAuthFixture(linkedParentRoot);
  const parentLink = path.join(linkedParentRoot, "auth-link");
  fs.symlinkSync(path.join(linkedParentRoot, "auth"), parentLink);
  assert.throws(
    () => validateClaudeAuthEnvFile(path.join(parentLink, "claude-acp-oauth.env")),
    { code: "claude_env_file_parent_symlink" }
  );

  const okRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-envok-"));
  assert.equal(
    validateClaudeAuthEnvFile(makeClaudeAuthFixture(okRoot)),
    DUMMY_CLAUDE_TOKEN
  );
  const noNewlineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-envok2-"));
  assert.equal(
    validateClaudeAuthEnvFile(makeClaudeAuthFixture(noNewlineRoot, {
      content: CLAUDE_OAUTH_TOKEN_ENV + "=" + DUMMY_CLAUDE_TOKEN
    })),
    DUMMY_CLAUDE_TOKEN
  );
});

test("bare claude supervisor launch fails closed before runtime loading", POSIX_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-bare-"));
  const envFile = makeClaudeAuthFixture(root);
  const config = makeClaudeConfig(root, envFile, {
    runtimeModule: path.join(root, "missing-runtime")
  });
  const emitted = [];
  const exitCode = await runSupervisor(config, {
    bindSignals: false,
    env: claudeEnv(envFile),
    execArgv: [],
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(emitted.at(-1).type, "supervisor_error");
  assert.equal(emitted.at(-1).code, "claude_env_file_option_missing");
  assert.equal(fs.existsSync(config.stateDir), false);
  assert.equal(fs.existsSync(config.responseFile), false);
});

test("claude exec argv proof rejects every bypass spelling", POSIX_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-argv-"));
  const envFile = makeClaudeAuthFixture(root);
  const cases = [
    // Property-presence dependency injection: the explicit undefined must
    // exercise the non-array branch instead of falling back to the host
    // process's own exec argv.
    [undefined, "claude_env_file_option_missing"],
    [[], "claude_env_file_option_missing"],
    [["--test"], "claude_env_file_option_mismatch"],
    [["--env-file=relative/claude.env"], "claude_env_file_option_mismatch"],
    [["--env-file=" + envFile + ".other"], "claude_env_file_option_mismatch"],
    [["--env-file-if-exists=" + envFile], "claude_env_file_option_mismatch"],
    [["--env-file", envFile], "claude_env_file_option_mismatch"],
    [["--env-file=" + envFile, "--env-file=" + envFile], "claude_env_file_option_mismatch"],
    [["--env-file=" + envFile, "--experimental-vm-modules"], "claude_env_file_option_mismatch"]
  ];
  for (const [execArgv, expected] of cases) {
    const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-argv-case-"));
    const config = makeClaudeConfig(caseRoot, envFile, {
      runtimeModule: path.join(caseRoot, "missing-runtime")
    });
    const emitted = [];
    const exitCode = await runSupervisor(config, {
      bindSignals: false,
      env: claudeEnv(envFile),
      execArgv,
      writeEvent(event) {
        emitted.push(event);
      }
    });
    assert.equal(exitCode, EXIT_CODES.supervisorError, expected);
    assert.equal(emitted.at(-1).code, expected, JSON.stringify(execArgv));
    assert.equal(fs.existsSync(config.stateDir), false, expected);
  }
});

test("claude contract is automatic even with empty caller env arrays", POSIX_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-auto-"));
  const envFile = makeClaudeAuthFixture(root);
  // The implicit contract covers the credential selectors and every
  // injection-capable variable (NODE_OPTIONS preloads, dynamic-linker
  // preloads, endpoint/header/config selectors, proxies): none of them can
  // be non-empty in the token-bearing supervisor's environment.
  const cases = [
    [{}, "required_env_missing:" + CLAUDE_OAUTH_TOKEN_ENV],
    [{ [CLAUDE_OAUTH_TOKEN_ENV]: "" }, "required_env_empty:" + CLAUDE_OAUTH_TOKEN_ENV],
    ...CLAUDE_IMPLICIT_ENV_CONTRACT.forbiddenEnv.map((name) => [
      claudeEnv(envFile, { [name]: "FORBIDDEN_SECRET_VALUE" }),
      "forbidden_env_present:" + name
    ])
  ];
  assert.ok(CLAUDE_IMPLICIT_ENV_CONTRACT.forbiddenEnv.includes("NODE_OPTIONS"));
  assert.ok(CLAUDE_IMPLICIT_ENV_CONTRACT.forbiddenEnv.includes("LD_PRELOAD"));
  assert.ok(CLAUDE_IMPLICIT_ENV_CONTRACT.forbiddenEnv.includes("DYLD_INSERT_LIBRARIES"));
  assert.ok(CLAUDE_IMPLICIT_ENV_CONTRACT.forbiddenEnv.includes("ANTHROPIC_BASE_URL"));
  for (const name of CLAUDE_FORBIDDEN_ENV) {
    assert.ok(CLAUDE_IMPLICIT_ENV_CONTRACT.forbiddenEnv.includes(name), name);
  }
  for (const name of CLAUDE_INJECTION_ENV) {
    assert.ok(CLAUDE_IMPLICIT_ENV_CONTRACT.forbiddenEnv.includes(name), name);
  }
  for (const [env, expected] of cases) {
    const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-auto-case-"));
    const config = makeClaudeConfig(caseRoot, envFile, {
      requiredEnv: [],
      forbiddenEnv: [],
      runtimeModule: path.join(caseRoot, "missing-runtime")
    });
    const emitted = [];
    const exitCode = await runSupervisor(config, {
      bindSignals: false,
      env,
      execArgv: ["--env-file=" + envFile],
      writeEvent(event) {
        emitted.push(event);
      }
    });
    assert.equal(exitCode, EXIT_CODES.supervisorError, expected);
    assert.equal(emitted.at(-1).code, expected);
    assert.equal(
      JSON.stringify(emitted).includes("FORBIDDEN_SECRET_VALUE"),
      false
    );
  }
});

test("claude guard proves the token came from the declared env file", POSIX_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-source-"));
  const envFile = makeClaudeAuthFixture(root);
  const config = makeClaudeConfig(root, envFile, {
    runtimeModule: path.join(root, "missing-runtime")
  });
  const emitted = [];
  const exitCode = await runSupervisor(config, {
    bindSignals: false,
    env: { [CLAUDE_OAUTH_TOKEN_ENV]: "another-injected-token-value" },
    execArgv: ["--env-file=" + envFile],
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(emitted.at(-1).code, "claude_env_token_source_mismatch");
  const serialized = JSON.stringify(emitted);
  assert.equal(serialized.includes(DUMMY_CLAUDE_TOKEN), false);
  assert.equal(serialized.includes("another-injected-token-value"), false);
});

test("in-memory claude config without auth cannot bypass the guard", POSIX_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-inmemory-"));
  const envFile = makeClaudeAuthFixture(root);
  for (const auth of [undefined, { kind: "api-key", envFile }]) {
    const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-inmemory-case-"));
    const config = makeConfig(caseRoot, {
      agent: "claude",
      auth,
      runtimeModule: path.join(caseRoot, "missing-runtime")
    });
    const emitted = [];
    const exitCode = await runSupervisor(config, {
      bindSignals: false,
      env: claudeEnv(envFile),
      execArgv: ["--env-file=" + envFile],
      writeEvent(event) {
        emitted.push(event);
      }
    });
    assert.equal(exitCode, EXIT_CODES.supervisorError);
    assert.equal(emitted.at(-1).code, "claude_auth_missing");
  }

  assert.throws(
    () => runClaudeSupervisorPreflight(
      makeConfig(root, { agent: "codex", auth: { kind: CLAUDE_AUTH_KIND, envFile } }),
      claudeEnv(envFile),
      []
    ),
    { code: "claude_auth_not_applicable" }
  );
});

test("canonical claude launch reaches the runtime without token disclosure", POSIX_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-happy-"));
  const envFile = makeClaudeAuthFixture(root);
  const { module, state } = makeRuntimeModule({
    events: [{ type: "text_delta", stream: "output", text: "bounded result" }]
  });
  const config = makeClaudeConfig(root, envFile);
  const emitted = [];
  const exitCode = await runSupervisor(config, {
    runtimeModule: module,
    bindSignals: false,
    env: claudeEnv(envFile),
    execArgv: ["--env-file=" + envFile],
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.completed);
  assert.ok(state.runtimeOptions);
  assert.equal(emitted.at(-1).type, "terminal");
  assert.equal(emitted.at(-1).status, "completed");
  assert.equal(JSON.stringify(emitted).includes(DUMMY_CLAUDE_TOKEN), false);
});

test("claude omitted model keeps genuine omission through the runtime", POSIX_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-no-model-"));
  const envFile = makeClaudeAuthFixture(root);
  const { module, state } = makeRuntimeModule({
    events: [{ type: "text_delta", stream: "output", text: "bounded result" }]
  });
  const lifecycle = parsedLifecycle();
  const config = makeClaudeConfig(root, envFile, {
    model: undefined,
    lifecycle,
    reporting: validReporting(lifecycle, { agent: "claude", model: "runtime-default" })
  });
  const emitted = [];
  const exitCode = await runSupervisor(config, {
    runtimeModule: module,
    bindSignals: false,
    env: claudeEnv(envFile),
    execArgv: ["--env-file=" + envFile],
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.completed);
  // No codex default leaks into claude: the started event keeps the public
  // runtime-default label and the runtime session options omit model, so the
  // adapter's own runtime default stays in charge.
  const started = emitted.find((event) => event.type === "started");
  assert.equal(started.model, "runtime-default");
  assert.equal("model" in state.ensureInput.sessionOptions, false);
});

test("claude unsupported session/close keeps the fail-closed cleanup contract", POSIX_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-close-unsupported-"));
  const envFile = makeClaudeAuthFixture(root);
  const { module, state } = makeRuntimeModule({
    events: [{ type: "text_delta", stream: "output", text: "bounded result" }],
    closeError: (input) => input.discardPersistentState === true
      ? unsupportedSessionCloseError()
      : undefined
  });
  const config = makeClaudeConfig(root, envFile);
  const emitted = [];
  const exitCode = await runSupervisor(config, {
    runtimeModule: module,
    bindSignals: false,
    env: claudeEnv(envFile),
    execArgv: ["--env-file=" + envFile],
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  const terminal = emitted.at(-1);
  assert.equal(terminal.type, "terminal");
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.supervisorStatus, "degraded");
  assert.equal(terminal.cleanupOk, false);
  assert.equal("cleanupFallback" in terminal, false);
  // The codex-only fallback never runs for claude: every close attempt keeps
  // the canonical persistent-state discard.
  assert.ok(state.closeInputs.length >= 1);
  assert.ok(state.closeInputs.every((input) => input.discardPersistentState === true));
  assert.equal(
    emitted.some((event) => event.activity === "cleanup_unsupported_close_fallback"),
    false
  );
  assert.equal(JSON.stringify(emitted).includes("private-record-id"), false);
});

test("non-claude agents keep the generic environment contract without argv proof", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-generic-env-"));
  const { module, state } = makeRuntimeModule();
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(root, {
    requiredEnv: ["ACP_TEST_REQUIRED_TOKEN"]
  }), {
    runtimeModule: module,
    bindSignals: false,
    env: {
      [CODEX_PATH_ENV]: process.execPath,
      ACP_TEST_REQUIRED_TOKEN: "present"
    },
    execArgv: [],
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.completed);
  assert.ok(state.runtimeOptions);
});

test("non-canonical claude spellings cannot bypass the claude gates", POSIX_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-case-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });

  assert.equal(isClaudeAgent("claude"), true);
  assert.equal(isClaudeAgent("Claude"), true);
  assert.equal(isClaudeAgent("CLAUDE"), true);
  assert.equal(isClaudeAgent(" claude "), true);
  assert.equal(isClaudeAgent("claude-x"), false);
  assert.equal(isClaudeAgent(7), false);

  // On-disk configs: any spelling ACPX would normalize to "claude" other
  // than the canonical one is invalid config, with or without auth.
  let caseIndex = 0;
  for (const agent of ["Claude", "CLAUDE", "cLaUdE"]) {
    caseIndex += 1;
    const configFile = path.join(root, "case-" + String(caseIndex) + ".json");
    fs.writeFileSync(configFile, JSON.stringify({
      agent,
      cwd: root,
      sessionKey: "test-session",
      promptFile: prompt,
      responseFile: path.join(root, "response-" + String(caseIndex) + ".txt"),
      stateDir: path.join(root, "state"),
      runtimeModule: root,
      timeoutMs: 30000,
      lifecycle: rawLifecycle(),
      allowKinds: ["read"]
    }), { mode: 0o600 });
    assert.throws(
      () => loadSupervisorConfig(configFile),
      { code: "invalid_agent_not_canonical" },
      agent
    );
  }

  // In-memory configs: a normalized-to-claude spelling reaching the
  // supervisor without the canonical value fails the centralized closed-set
  // gate with the same stable loader code — previously "Claude" skipped
  // auth, argv proof, and the credential contract entirely and still
  // resolved to Claude in ACPX.
  for (const agent of ["Claude", " claude "]) {
    const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-case-mem-"));
    const config = makeConfig(caseRoot, {
      agent,
      runtimeModule: path.join(caseRoot, "missing-runtime")
    });
    const emitted = [];
    const exitCode = await runSupervisor(config, {
      bindSignals: false,
      env: {},
      execArgv: [],
      writeEvent(event) {
        emitted.push(event);
      }
    });
    assert.equal(exitCode, EXIT_CODES.supervisorError, agent);
    assert.equal(emitted.at(-1).code, "invalid_agent_not_canonical", agent);
    assert.equal(fs.existsSync(config.stateDir), false, agent);
  }

  // The exported Claude route guard keeps its own non-canonical rejection as
  // defense in depth when invoked directly, behind the centralized gate.
  assert.throws(
    () => runClaudeSupervisorPreflight({ agent: "Claude" }, {}, []),
    { code: "claude_agent_not_canonical" }
  );
});

test("claude env file rejects a FIFO without blocking", POSIX_ONLY, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-fifo-"));
  const authDir = path.join(root, "auth");
  fs.mkdirSync(authDir, { mode: 0o700 });
  fs.chmodSync(authDir, 0o700);
  const fifoPath = path.join(authDir, "claude-acp-oauth.env");
  const created = spawnSync("mkfifo", ["-m", "600", fifoPath], { timeout: 5000 });
  assert.equal(created.status, 0, String(created.stderr));

  // An open-first validation would block here forever waiting for a writer;
  // the lstat pre-check must fail closed immediately instead.
  const startedAt = Date.now();
  assert.throws(
    () => validateClaudeAuthEnvFile(fifoPath),
    { code: "claude_env_file_not_regular" }
  );
  assert.ok(Date.now() - startedAt < 2000);
});

test("claude env file open errors map to bounded distinct codes", POSIX_ONLY, () => {
  // EACCES on open: correct type and ownership, but no read permission. The
  // mode gate itself lives behind fstat, so the open is what fails first.
  const deniedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-denied-"));
  const deniedFile = makeClaudeAuthFixture(deniedRoot, { fileMode: 0o000 });
  assert.throws(
    () => validateClaudeAuthEnvFile(deniedFile),
    { code: "claude_env_file_open_denied" }
  );

  // ENOENT stays the missing-file code.
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-claude-envmap-"));
  fs.chmodSync(missingRoot, 0o700);
  assert.throws(
    () => validateClaudeAuthEnvFile(path.join(missingRoot, "absent.env")),
    { code: "claude_env_file_missing" }
  );
});

test("cli entry guard is realpath-safe for symlinked entry paths", () => {
  const moduleUrl = pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href;
  assert.equal(isCliEntry(fileURLToPath(import.meta.url), moduleUrl), true);
  assert.equal(isCliEntry(undefined, moduleUrl), false);
  assert.equal(isCliEntry("", moduleUrl), false);
  assert.equal(isCliEntry(path.join(os.tmpdir(), "does-not-exist.mjs"), moduleUrl), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-entry-guard-"));
  const link = path.join(root, "entry-link.mjs");
  fs.symlinkSync(fileURLToPath(import.meta.url), link);
  assert.equal(isCliEntry(link, moduleUrl), true);
});

test("supervisor invoked through a symlinked path still runs main", POSIX_ONLY, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-entry-symlink-"));
  const supervisorFile = fileURLToPath(
    new URL("./acpx-foreground-supervisor.mjs", import.meta.url)
  );
  const link = path.join(root, "supervisor-link.mjs");
  fs.symlinkSync(supervisorFile, link);

  // Before the realpath-safe guard, a symlinked argv path (or macOS /tmp)
  // made the module-vs-argv comparison false, so the CLI silently exited 0
  // without running main. A usage failure proves main actually ran.
  const result = spawnSync(process.execPath, [link], {
    encoding: "utf8",
    timeout: 15000
  });
  assert.equal(result.status, EXIT_CODES.invalidConfig);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "supervisor_error");
  assert.equal(events.at(-1).code, "usage");
});

test("closed agent presentation mapping is exactly claude and codex", () => {
  assert.deepEqual(ACP_SUPPORTED_AGENTS, ["claude", "codex"]);
  assert.deepEqual(
    { ...ACP_AGENT_PRESENTATIONS },
    { claude: "Claude Code", codex: "Codex" }
  );
  assert.ok(Object.isFrozen(ACP_AGENT_PRESENTATIONS));
});

test("loader binds reporting to the canonical agent for both supported agents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-agent-neutral-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const lifecycle = rawLifecycle();
  let caseIndex = 0;
  const writeCase = (extra) => {
    caseIndex += 1;
    const file = path.join(root, "case-" + String(caseIndex) + ".json");
    fs.writeFileSync(file, JSON.stringify({
      agent: "codex",
      model: "test-model",
      cwd: root,
      sessionKey: "test-session",
      promptFile: prompt,
      responseFile: path.join(root, "response-" + String(caseIndex) + ".txt"),
      stateDir: path.join(root, "state"),
      runtimeModule: root,
      timeoutMs: 30000,
      lifecycle,
      allowKinds: ["read"],
      reporting: validReporting(lifecycle),
      ...extra
    }), { mode: 0o600 });
    return file;
  };

  // codex loads only with a v2 bundle attesting agent "codex" and presenting
  // the closed "Codex" label.
  const codex = loadSupervisorConfig(writeCase({}));
  assert.equal(codex.agent, "codex");
  assert.equal(codex.reporting.schemaVersion, "acp-reporting-v2");
  assert.equal(codex.reporting.agent, "codex");
  assert.match(
    codex.reporting.startMessage,
    /🤖 \*\*ACP\*\*: Codex · `test-model\[medium\]`/
  );
  assert.equal(codex.reporting.startMessage.includes("Claude Code"), false);

  // claude keeps loading a v2 bundle, and — during the bounded migration —
  // the legacy v1 bundle shape with the Claude Code label.
  const claudeAuth = { kind: CLAUDE_AUTH_KIND, envFile: "/private/claude-acp-oauth.env" };
  const claudeV2 = loadSupervisorConfig(writeCase({
    agent: "claude",
    auth: claudeAuth,
    reporting: validReporting(lifecycle, { agent: "claude" })
  }));
  assert.equal(claudeV2.reporting.agent, "claude");
  assert.match(claudeV2.reporting.startMessage, /🤖 \*\*ACP\*\*: Claude Code · `test-model`/);

  const claudeV1 = loadSupervisorConfig(writeCase({
    agent: "claude",
    auth: claudeAuth,
    reporting: validReporting(lifecycle, {
      agent: "claude",
      schemaVersion: "acp-reporting-v1"
    })
  }));
  assert.equal(claudeV1.reporting.schemaVersion, "acp-reporting-v1");
  assert.equal("agent" in claudeV1.reporting, false);
  assert.match(claudeV1.reporting.startMessage, /🤖 \*\*ACP\*\*: Claude Code · `test-model`/);

  // The legacy v1 shape is rejected for codex before any runtime loading.
  assert.throws(
    () => loadSupervisorConfig(writeCase({
      reporting: validReporting(lifecycle, {
        agent: "codex",
        schemaVersion: "acp-reporting-v1"
      })
    })),
    { message: "invalid_reporting_schema_version", code: "invalid_reporting_schema_version" }
  );

  // A caller cannot choose the public harness label: a codex config whose
  // templates present as Claude Code fails on the exact identity line even
  // though the agent attestation is truthful.
  assert.throws(
    () => loadSupervisorConfig(writeCase({
      reporting: validReporting(lifecycle, {
        agent: "codex",
        agentLabel: "Claude Code"
      })
    })),
    { message: "invalid_reporting_start_message", code: "invalid_reporting_start_message" }
  );

  // A cross-agent attestation (codex config, claude-labeled claude bundle)
  // fails on the attestation itself.
  assert.throws(
    () => loadSupervisorConfig(writeCase({
      reporting: validReporting(lifecycle, { agent: "claude" })
    })),
    { message: "invalid_reporting_agent", code: "invalid_reporting_agent" }
  );

  // An agent outside the closed mapping is rejected as invalid config with
  // its own stable code before any runtime import, regardless of what its
  // bundle claims.
  for (const agent of ["test-agent", "gemini", "claude-code"]) {
    assert.throws(
      () => loadSupervisorConfig(writeCase({ agent })),
      { message: "invalid_agent_unsupported", code: "invalid_agent_unsupported" },
      agent
    );
  }

  // Any spelling ACPX would normalize to a supported agent other than the
  // canonical lowercase value stays invalid config for codex, like claude.
  for (const agent of ["Codex", "CODEX", "cOdEx"]) {
    assert.throws(
      () => loadSupervisorConfig(writeCase({ agent })),
      { code: "invalid_agent_not_canonical" },
      agent
    );
  }

  // Nothing above created supervisor side effects.
  assert.equal(fs.existsSync(path.join(root, "state")), false);
});

test("unsupported agent fails the in-memory gate before runtime access", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-agent-backstop-"));
  const { module, state } = makeRuntimeModule();
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(root, { agent: "test-agent" }), {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(emitted.at(-1).type, "supervisor_error");
  assert.equal(emitted.at(-1).code, "invalid_agent_unsupported");
  assert.equal(state.runtimeOptions, undefined);
  assert.equal(fs.existsSync(path.join(root, "state")), false);

  // Direct unit surface: the pure reporting contract keeps its own
  // contract-level boundary code when the backstop is invoked standalone,
  // even though the bundle itself is a valid codex bundle.
  assert.throws(
    () => runReportingPreflight(makeConfig(root, { agent: "gemini" })),
    { message: "invalid_reporting_agent", code: "invalid_reporting_agent" }
  );
});

test("non-canonical codex spelling fails closed in memory", async () => {
  // "Codex" reaches ACPX's codex adapter after trim/lowercase normalization,
  // so an in-memory config using it must fail the centralized closed-set
  // gate with the same stable code the loader uses — symmetric with the
  // non-canonical Claude spellings above.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codex-case-"));
  const { module, state } = makeRuntimeModule();
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(root, { agent: "Codex" }), {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(emitted.at(-1).code, "invalid_agent_not_canonical");
  assert.equal(state.runtimeOptions, undefined);
});

test("centralized agent gate accepts only canonical supported spellings", () => {
  assert.equal(assertCanonicalSupportedAgent("claude"), "claude");
  assert.equal(assertCanonicalSupportedAgent("codex"), "codex");
  // A spelling that ACPX would normalize to a supported agent, but is not
  // the exact canonical lowercase value, is symmetric between claude and
  // codex: one stable code, no per-agent asymmetry.
  for (const agent of ["Claude", "CLAUDE", " claude ", "Codex", "CODEX", "cOdEx", "codex "]) {
    assert.throws(
      () => assertCanonicalSupportedAgent(agent),
      { message: "invalid_agent_not_canonical", code: "invalid_agent_not_canonical" },
      JSON.stringify(agent)
    );
  }
  // Anything outside the closed set — including non-strings — fails with its
  // own stable explicit code.
  for (const agent of ["gemini", "claude-code", "test-agent", "", 7, undefined, null]) {
    assert.throws(
      () => assertCanonicalSupportedAgent(agent),
      { message: "invalid_agent_unsupported", code: "invalid_agent_unsupported" },
      String(agent)
    );
  }
});

test("agent gate precedes unrelated filesystem access in the loader", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-agent-early-"));
  // Every later filesystem field points at a missing path: reaching any of
  // them would surface a different code (or a raw ENOENT), so the stable
  // agent codes prove the closed-set gate ran before cwd, prompt, response,
  // state-dir, or runtime-module I/O.
  let caseIndex = 0;
  const writeCase = (agent) => {
    caseIndex += 1;
    const file = path.join(root, "case-" + String(caseIndex) + ".json");
    fs.writeFileSync(file, JSON.stringify({
      agent,
      cwd: path.join(root, "missing-cwd"),
      sessionKey: "test-session",
      promptFile: path.join(root, "missing-prompt.txt"),
      responseFile: path.join(root, "response-" + String(caseIndex) + ".txt"),
      stateDir: path.join(root, "state"),
      runtimeModule: path.join(root, "missing-runtime"),
      timeoutMs: 30000,
      lifecycle: rawLifecycle(),
      allowKinds: ["read"],
      reporting: validReporting()
    }), { mode: 0o600 });
    return file;
  };

  assert.throws(
    () => loadSupervisorConfig(writeCase("gemini")),
    { message: "invalid_agent_unsupported", code: "invalid_agent_unsupported" }
  );
  for (const agent of ["Claude", "Codex"]) {
    assert.throws(
      () => loadSupervisorConfig(writeCase(agent)),
      { message: "invalid_agent_not_canonical", code: "invalid_agent_not_canonical" },
      agent
    );
  }

  // The unsupported-agent code keeps the invalid-config CLI exit mapping.
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  let exitCode;
  try {
    exitCode = await main(["--config", writeCase("gemini")]);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(exitCode, EXIT_CODES.invalidConfig);
  const emitted = JSON.parse(writes.join("").trim());
  assert.equal(emitted.type, "supervisor_error");
  assert.equal(emitted.code, "invalid_agent_unsupported");
});

test("provider-neutral injection baseline is implicitly forbidden for codex", async () => {
  // The baseline is exactly the agent-neutral process-integrity set: Node
  // module/preload selectors, dynamic-linker preload/library selectors, and
  // the proxy selectors in both letter cases. No Anthropic-specific selector
  // belongs to it.
  assert.deepEqual([...ACP_INJECTION_ENV], [
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_REPL_EXTERNAL_MODULE",
    "LD_PRELOAD",
    "LD_AUDIT",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy"
  ]);
  assert.ok(Object.isFrozen(ACP_INJECTION_ENV));
  assert.ok(Object.isFrozen(ACP_BASELINE_ENV_CONTRACT));
  assert.deepEqual([...ACP_BASELINE_ENV_CONTRACT.requiredEnv], []);
  assert.deepEqual(
    [...ACP_BASELINE_ENV_CONTRACT.forbiddenEnv],
    [...ACP_INJECTION_ENV]
  );

  // Every baseline variable is rejected for a codex run with empty caller
  // env arrays, before any runtime module import, without value disclosure.
  for (const name of ACP_INJECTION_ENV) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-baseline-codex-"));
    const config = makeConfig(root, {
      requiredEnv: [],
      forbiddenEnv: [],
      runtimeModule: path.join(root, "missing-runtime")
    });
    const emitted = [];
    const exitCode = await runSupervisor(config, {
      bindSignals: false,
      env: { [name]: "INJECTED_SECRET_VALUE" },
      writeEvent(event) {
        emitted.push(event);
      }
    });
    assert.equal(exitCode, EXIT_CODES.supervisorError, name);
    assert.equal(emitted.at(-1).type, "supervisor_error", name);
    assert.equal(emitted.at(-1).code, "forbidden_env_present:" + name, name);
    assert.equal(fs.existsSync(config.stateDir), false, name);
    assert.equal(
      JSON.stringify(emitted).includes("INJECTED_SECRET_VALUE"),
      false,
      name
    );
  }

  // Empty values cannot inject anything: with every baseline variable
  // present but empty, a codex run still completes.
  const okRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-baseline-empty-"));
  const { module, state } = makeRuntimeModule();
  const emitted = [];
  const exitCode = await runSupervisor(makeConfig(okRoot), {
    runtimeModule: module,
    bindSignals: false,
    env: {
      ...Object.fromEntries(ACP_INJECTION_ENV.map((name) => [name, ""])),
      [CODEX_PATH_ENV]: process.execPath
    },
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.completed);
  assert.ok(state.runtimeOptions);
  assert.equal(emitted.at(-1).type, "terminal");
});

test("caller cannot require an implicitly forbidden baseline variable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-baseline-overlap-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const lifecycle = rawLifecycle();
  let caseIndex = 0;
  const writeCase = (extra) => {
    caseIndex += 1;
    const file = path.join(root, "case-" + String(caseIndex) + ".json");
    fs.writeFileSync(file, JSON.stringify({
      agent: "codex",
      model: "test-model",
      cwd: root,
      sessionKey: "test-session",
      promptFile: prompt,
      responseFile: path.join(root, "response-" + String(caseIndex) + ".txt"),
      stateDir: path.join(root, "state"),
      runtimeModule: root,
      timeoutMs: 30000,
      lifecycle,
      reporting: validReporting(lifecycle),
      allowKinds: ["read"],
      ...extra
    }), { mode: 0o600 });
    return file;
  };

  // Baseline overlap is judged case-insensitively for the non-Claude path,
  // matching the contract's portable case-insensitive name identity.
  for (const name of ["NODE_OPTIONS", "node_options", "Node_Options", "LD_PRELOAD", "Ld_Preload", "HTTP_PROXY", "http_proxy", "Dyld_Insert_Libraries"]) {
    assert.throws(
      () => loadSupervisorConfig(writeCase({ requiredEnv: [name] })),
      { message: "invalid_env_contract_overlap", code: "invalid_env_contract_overlap" },
      name
    );
  }

  // Restating a baseline variable as forbidden is consistent, not
  // contradictory, and Anthropic-specific selectors are Claude-layered, not
  // baseline: a codex run may still require them through the generic
  // contract.
  const consistent = loadSupervisorConfig(writeCase({
    forbiddenEnv: ["NODE_OPTIONS"],
    requiredEnv: ["ANTHROPIC_BASE_URL"]
  }));
  assert.deepEqual(consistent.forbiddenEnv, ["NODE_OPTIONS"]);
  assert.deepEqual(consistent.requiredEnv, ["ANTHROPIC_BASE_URL"]);
});

test("claude keeps the superset of baseline plus anthropic-specific selectors", () => {
  assert.deepEqual([...CLAUDE_PROVIDER_INJECTION_ENV], [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
    "CLAUDE_CONFIG_DIR"
  ]);
  // The Claude injection set is exactly the agent-neutral baseline plus the
  // Anthropic-specific layer — nothing dropped, nothing else added.
  assert.deepEqual(
    [...CLAUDE_INJECTION_ENV],
    [...ACP_INJECTION_ENV, ...CLAUDE_PROVIDER_INJECTION_ENV]
  );
  for (const name of CLAUDE_PROVIDER_INJECTION_ENV) {
    assert.equal(ACP_INJECTION_ENV.includes(name), false, name);
  }
  // The automatic Claude credential contract forbids the whole superset on
  // top of its credential selectors, and still requires only the setup
  // token.
  for (const name of [...ACP_INJECTION_ENV, ...CLAUDE_PROVIDER_INJECTION_ENV, ...CLAUDE_FORBIDDEN_ENV]) {
    assert.ok(CLAUDE_IMPLICIT_ENV_CONTRACT.forbiddenEnv.includes(name), name);
  }
  assert.deepEqual([...CLAUDE_IMPLICIT_ENV_CONTRACT.requiredEnv], [CLAUDE_OAUTH_TOKEN_ENV]);
  assert.ok(Object.isFrozen(CLAUDE_PROVIDER_INJECTION_ENV));
  assert.ok(Object.isFrozen(CLAUDE_INJECTION_ENV));
});

test("codex implicit contract requires an operator-injected CODEX_PATH", async () => {
  assert.equal(CODEX_PATH_ENV, "CODEX_PATH");
  assert.ok(Object.isFrozen(CODEX_IMPLICIT_ENV_CONTRACT));
  assert.deepEqual([...CODEX_IMPLICIT_ENV_CONTRACT.requiredEnv], [CODEX_PATH_ENV]);
  // The shared injection baseline is preserved, not replaced: the Codex
  // contract forbids exactly the agent-neutral set.
  assert.deepEqual(
    [...CODEX_IMPLICIT_ENV_CONTRACT.forbiddenEnv],
    [...ACP_INJECTION_ENV]
  );
  // Claude non-regression: the Claude contract neither requires nor forbids
  // the Codex executable path.
  assert.equal(CLAUDE_IMPLICIT_ENV_CONTRACT.requiredEnv.includes(CODEX_PATH_ENV), false);
  assert.equal(CLAUDE_IMPLICIT_ENV_CONTRACT.forbiddenEnv.includes(CODEX_PATH_ENV), false);

  assert.equal(isCodexAgent("codex"), true);
  assert.equal(isCodexAgent("Codex"), true);
  assert.equal(isCodexAgent(" codex "), true);
  assert.equal(isCodexAgent("codex-x"), false);
  assert.equal(isCodexAgent(7), false);

  // The exported Codex route guard is inert for other agents, keeps its own
  // non-canonical rejection as defense in depth, and enforces the implicit
  // contract even when the caller-declared arrays are empty.
  assert.equal(runCodexSupervisorPreflight({ agent: "claude" }, {}), undefined);
  assert.throws(
    () => runCodexSupervisorPreflight(
      { agent: "Codex" },
      { [CODEX_PATH_ENV]: process.execPath }
    ),
    { message: "codex_agent_not_canonical", code: "codex_agent_not_canonical" }
  );

  // In-memory runs: missing and empty keep the sanitized generic
  // required-env codes, fail before any runtime module access or state
  // directory creation, and disclose no value.
  for (const [env, code] of [
    [{}, "required_env_missing:" + CODEX_PATH_ENV],
    [{ [CODEX_PATH_ENV]: "" }, "required_env_empty:" + CODEX_PATH_ENV]
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codex-path-req-"));
    const { module, state } = makeRuntimeModule();
    const config = makeConfig(root);
    const emitted = [];
    const exitCode = await runSupervisor(config, {
      runtimeModule: module,
      bindSignals: false,
      env,
      writeEvent(event) {
        emitted.push(event);
      }
    });
    assert.equal(exitCode, EXIT_CODES.supervisorError, code);
    assert.equal(emitted.at(-1).type, "supervisor_error", code);
    assert.equal(emitted.at(-1).code, code);
    assert.equal(state.runtimeOptions, undefined, code);
    assert.equal(fs.existsSync(config.stateDir), false, code);
  }

  // The implicit Codex contract precedes the caller-declared generic
  // contract, exactly like the implicit Claude contract.
  const orderRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codex-path-order-"));
  const orderEmitted = [];
  const orderExit = await runSupervisor(makeConfig(orderRoot, {
    requiredEnv: ["ACP_TEST_REQUIRED_TOKEN"],
    runtimeModule: path.join(orderRoot, "missing-runtime")
  }), {
    bindSignals: false,
    env: {},
    writeEvent(event) {
      orderEmitted.push(event);
    }
  });
  assert.equal(orderExit, EXIT_CODES.supervisorError);
  assert.equal(orderEmitted.at(-1).code, "required_env_missing:" + CODEX_PATH_ENV);
});

test("codex path validation fails closed on shape, existence, type, and executability", POSIX_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codex-path-shape-"));
  const nonExecutable = path.join(root, "codex-non-exec");
  fs.writeFileSync(nonExecutable, "#!/bin/sh\n", { mode: 0o600 });
  const cases = [
    ["bin/codex", "codex_path_not_absolute"],
    [path.join(root, "missing-codex"), "codex_path_missing"],
    [root, "codex_path_not_regular"],
    [nonExecutable, "codex_path_not_executable"]
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => validateCodexExecutablePath(value),
      { message: code, code },
      code
    );
  }
  // Non-string and over-length values are invalid shape, not a crash.
  for (const value of [undefined, 7, "", "/" + "a".repeat(4096)]) {
    assert.throws(
      () => validateCodexExecutablePath(value),
      { code: "codex_path_not_absolute" }
    );
  }

  // Through runSupervisor: each class is a bounded supervisor_error emitted
  // before the runtime module is ever touched, and the rejected path value is
  // never echoed or hashed into events.
  for (const [value, code] of cases) {
    const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codex-path-case-"));
    const config = makeConfig(caseRoot, {
      runtimeModule: path.join(caseRoot, "missing-runtime")
    });
    const emitted = [];
    const exitCode = await runSupervisor(config, {
      bindSignals: false,
      env: { [CODEX_PATH_ENV]: value },
      writeEvent(event) {
        emitted.push(event);
      }
    });
    assert.equal(exitCode, EXIT_CODES.supervisorError, code);
    assert.equal(emitted.at(-1).type, "supervisor_error", code);
    assert.equal(emitted.at(-1).code, code);
    assert.equal(fs.existsSync(config.stateDir), false, code);
    assert.equal(JSON.stringify(emitted).includes(value), false, code);
  }
});

test("codex symlink entrypoint stays valid and reaches the runtime", POSIX_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codex-path-symlink-"));
  // A Homebrew-style bin symlink to a regular executable target is a valid
  // entrypoint: resolution follows the link instead of rejecting it.
  const link = path.join(root, "codex-link");
  fs.symlinkSync(process.execPath, link);
  validateCodexExecutablePath(link);

  const { module, state } = makeRuntimeModule({
    events: [{ type: "text_delta", stream: "output", text: "bounded result" }]
  });
  const config = makeConfig(root);
  const emitted = [];
  const exitCode = await runSupervisor(config, {
    runtimeModule: module,
    bindSignals: false,
    env: { [CODEX_PATH_ENV]: link },
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.completed);
  assert.ok(state.runtimeOptions);
  assert.equal(JSON.stringify(emitted).includes(link), false);
});

test("codex config cannot forbid the implicitly required CODEX_PATH", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codex-path-overlap-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const lifecycle = rawLifecycle();
  let caseIndex = 0;
  const writeCase = (extra) => {
    caseIndex += 1;
    const file = path.join(root, "case-" + String(caseIndex) + ".json");
    fs.writeFileSync(file, JSON.stringify({
      agent: "codex",
      model: "test-model",
      cwd: root,
      sessionKey: "test-session",
      promptFile: prompt,
      responseFile: path.join(root, "response-" + String(caseIndex) + ".txt"),
      stateDir: path.join(root, "state"),
      runtimeModule: root,
      timeoutMs: 30000,
      lifecycle,
      reporting: validReporting(lifecycle),
      allowKinds: ["read"],
      ...extra
    }), { mode: 0o600 });
    return file;
  };

  // Forbidding the implicitly required executable path contradicts the
  // Codex contract under any letter case and fails config loading.
  for (const name of ["CODEX_PATH", "codex_path", "Codex_Path"]) {
    assert.throws(
      () => loadSupervisorConfig(writeCase({ forbiddenEnv: [name] })),
      { message: "invalid_env_contract_overlap", code: "invalid_env_contract_overlap" },
      name
    );
  }

  // Restating CODEX_PATH as required is consistent, not contradictory.
  const consistent = loadSupervisorConfig(writeCase({
    requiredEnv: ["CODEX_PATH"]
  }));
  assert.deepEqual(consistent.requiredEnv, ["CODEX_PATH"]);

  // Claude non-regression: the Codex contract is codex-scoped, so a claude
  // config declaring CODEX_PATH forbidden keeps the generic semantics.
  const claudeFile = writeCase({
    agent: "claude",
    auth: { kind: CLAUDE_AUTH_KIND, envFile: "/private/claude-acp-oauth.env" },
    reporting: validReporting(lifecycle, { agent: "claude" }),
    forbiddenEnv: ["CODEX_PATH"]
  });
  assert.deepEqual(loadSupervisorConfig(claudeFile).forbiddenEnv, ["CODEX_PATH"]);
});

test("codex run completes end to end with the codex identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-codex-e2e-"));
  const { module, state } = makeRuntimeModule({
    events: [{ type: "text_delta", stream: "output", text: "bounded result" }]
  });
  const config = makeConfig(root);
  const emitted = [];
  const exitCode = await runSupervisor(config, {
    runtimeModule: module,
    bindSignals: false,
    writeEvent(event) {
      emitted.push(event);
    }
  });
  assert.equal(exitCode, EXIT_CODES.completed);
  const started = emitted.find((event) => event.type === "started");
  assert.equal(started.agent, "codex");
  assert.equal(state.ensureInput.agent, "codex");
  assert.equal(emitted.at(-1).type, "terminal");
  assert.equal(emitted.at(-1).status, "completed");
  assert.equal(fs.readFileSync(config.responseFile, "utf8"), "bounded result");
});
