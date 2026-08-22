import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXIT_CODES,
  buildPermissionHandler,
  classifyPermissionRequest,
  containsDetachedShell,
  discoverRuntimeLocation,
  loadSupervisorConfig,
  main,
  normalizeRuntimeEvent,
  runStartReceiptPreflight,
  runSupervisor,
  validateRuntimeModuleExports
} from "./acpx-foreground-supervisor.mjs";

const CONTROL_CONVERSATION_ID = "100000000000000001";
const START_MESSAGE_ID = "100000000000000002";

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
      deliveredAtMs: Date.now(),
      ...receiptOverrides
    },
    ...overrides
  };
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
  return {
    agent: "claude",
    model: "test-model",
    cwd: root,
    sessionKey: "test-session",
    promptText: "perform the bounded test task",
    responseFile: path.join(root, "response-" + Math.random().toString(16).slice(2) + ".txt"),
    stateDir: path.join(root, "state"),
    timeoutMs: 30000,
    progressMs: 0,
    allowKinds: new Set(["read", "search", "think", "edit", "execute"]),
    lifecycle: parsedLifecycle(),
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
    cancelCalls: 0,
    closeStreamCalls: 0,
    streamClosed: false,
    closeAttempts: 0,
    permissionOutcome: undefined
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
        startTurn(input) {
          state.turnInput = input;
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
          state.closeAttempts += 1;
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
    agent: "claude",
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

test("config requires a timeout and rejects the unclassified other kind", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-config-required-"));
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "bounded task", { mode: 0o600 });
  const base = {
    agent: "claude",
    model: "test-model",
    cwd: root,
    sessionKey: "test-session",
    promptFile: prompt,
    responseFile: path.join(root, "response.txt"),
    stateDir: path.join(root, "state"),
    runtimeModule: root,
    lifecycle: rawLifecycle(),
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
  const base = {
    agent: "claude",
    model: "test-model",
    cwd: root,
    sessionKey: "test-session",
    promptFile: prompt,
    responseFile: path.join(root, "response.txt"),
    stateDir: path.join(root, "state"),
    runtimeModule: root,
    timeoutMs: 30000,
    lifecycle: rawLifecycle(),
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
    agent: "claude",
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
    [{}, "required_env_missing:ACP_TEST_REQUIRED_TOKEN"],
    [{ ACP_TEST_REQUIRED_TOKEN: "" }, "required_env_empty:ACP_TEST_REQUIRED_TOKEN"]
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
    env: { ACP_TEST_FORBIDDEN_TOKEN: "FORBIDDEN_SECRET_VALUE" },
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
    env: {},
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
    agent: "claude",
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
    fs.writeFileSync(file, JSON.stringify({ ...base, lifecycle }), { mode: 0o600 });
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

test("invalid start receipt retains the invalid-config CLI mapping", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-receipt-cli-"));
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

test("public docs separate foreground ownership from host caller blocking", () => {
  const skill = fs.readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
  const contract = fs.readFileSync(
    new URL("../references/runtime-contract.md", import.meta.url),
    "utf8"
  );

  assert.match(contract, /^## Host wait boundaries$/m);
  for (const doc of [skill, contract]) {
    assert.match(doc, /1, 2, 4, and then 5 seconds/);
    assert.match(doc, /exact non-empty process handle/);
    assert.match(doc, /unless the message explicitly cancels or replaces it/);
    assert.match(
      doc,
      /both the matching normalized terminal event and the mapped/
    );
  }

  assert.doesNotMatch(skill + contract, /ten-minute|10-minute/i);
  assert.match(
    contract,
    /define host-specific stale-session detection or recovery/
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
