import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildSupervisorExecution,
  main,
  runLauncherEnvironmentPreflight
} from "./claude-acp-launcher.mjs";
import {
  ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS,
  ACP_REPORTING_ERROR_CODES
} from "./acp-reporting-contract.mjs";
import { buildValidReporting } from "./acp-reporting-test-fixture.mjs";
import {
  CLAUDE_AUTH_KIND,
  CLAUDE_FORBIDDEN_ENV,
  CLAUDE_INJECTION_ENV,
  CLAUDE_OAUTH_TOKEN_ENV,
  EXIT_CODES,
  loadSupervisorConfig
} from "./acpx-foreground-supervisor.mjs";
import { assembleSupervisorConfig } from "./acpx-runtime-preflight.mjs";

const LAUNCHER_PATH = fileURLToPath(new URL("./claude-acp-launcher.mjs", import.meta.url));
const SUPERVISOR_PATH = fileURLToPath(
  new URL("./acpx-foreground-supervisor.mjs", import.meta.url)
);
const DUMMY_CLAUDE_TOKEN = "test-dummy-oauth-token-value-0123456789";
const POSIX_ONLY = { skip: process.platform === "win32" };
const EXECVE_E2E = {
  skip: process.platform === "win32" || typeof process.execve !== "function"
};

// The mock runtime proves three things from inside the replaced process: the
// supervisor kept the launcher's PID, the setup token arrived through Node's
// --env-file startup parsing, and no token value ever reaches the caller.
const MOCK_RUNTIME_SOURCE = `
export function createRuntimeStore() { return {}; }
export function createAgentRegistry() { return {}; }
export function createAcpRuntime() {
  return {
    async probeAvailability() {},
    async ensureSession(input) {
      return {
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: "mock",
        cwd: input.cwd
      };
    },
    startTurn(input) {
      const tokenPresent = typeof process.env.CLAUDE_CODE_OAUTH_TOKEN === "string" &&
        process.env.CLAUDE_CODE_OAUTH_TOKEN.length > 0;
      const marker = "pid=" + String(process.pid) +
        ";token_present=" + String(tokenPresent);
      return {
        requestId: input.requestId,
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "text_delta", stream: "output", text: marker };
          }
        },
        result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        async cancel() {},
        async closeStream() {}
      };
    },
    async close() {}
  };
}
`;

function makeAuthEnvFile(root, token = DUMMY_CLAUDE_TOKEN) {
  const authDir = path.join(root, "auth");
  fs.mkdirSync(authDir, { mode: 0o700 });
  fs.chmodSync(authDir, 0o700);
  const envFile = path.join(authDir, "claude-acp-oauth.env");
  fs.writeFileSync(envFile, CLAUDE_OAUTH_TOKEN_ENV + "=" + token + "\n", { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  return envFile;
}

function makeMockRuntimePackage(root) {
  const runtimeDir = path.join(root, "acpx-mock");
  fs.mkdirSync(path.join(runtimeDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "package.json"), JSON.stringify({
    name: "acpx-mock",
    version: "0.11.2-mock",
    type: "module"
  }));
  fs.writeFileSync(path.join(runtimeDir, "dist", "runtime.js"), MOCK_RUNTIME_SOURCE);
  return runtimeDir;
}

const CONTROL_CONVERSATION_ID = "100000000000000001";
const START_MESSAGE_ID = "100000000000000002";

// Deterministic claude acp-reporting-v2 bundle from the shared integration
// fixture, bound to the launcher lifecycle fixture. Launcher fixtures need
// this to pass the mandatory reporting config gate and reach auth/exec
// behavior.
function validReporting({
  controlConversationId = CONTROL_CONVERSATION_ID,
  messageId = START_MESSAGE_ID,
  deliveredAt,
  agent = "claude",
  model = agent === "codex" ? "test-model[medium]" : "test-model"
}) {
  return buildValidReporting({
    agent,
    controlConversationId,
    messageId,
    deliveredAt,
    model
  });
}

function writeClaudeRunConfig(root, overrides = {}) {
  const prompt = path.join(root, "prompt.txt");
  fs.writeFileSync(prompt, "perform the bounded test task", { mode: 0o600 });
  const configFile = path.join(root, "run.json");
  const deliveredAt = new Date().toISOString();
  // The reporting bundle must bind to the effective agent so overriding the
  // agent (to exercise the launcher's own agent gate) still ships a bundle
  // the loader accepts; deliberately non-canonical spellings fail the loader
  // before reporting and keep the default claude bundle.
  const agent = overrides.agent ?? "claude";
  const reportingAgent = agent === "codex" ? "codex" : "claude";
  fs.writeFileSync(configFile, JSON.stringify({
    agent: "claude",
    model: "test-model",
    cwd: root,
    sessionKey: "launcher-test-session",
    promptFile: prompt,
    responseFile: path.join(root, "response.txt"),
    stateDir: path.join(root, "state"),
    runtimeModule: path.join(root, "missing-runtime"),
    timeoutMs: 30000,
    progressMs: 0,
    lifecycle: {
      controlConversationId: CONTROL_CONVERSATION_ID,
      maxStartReceiptAgeMs: 300000,
      startReceipt: {
        conversationId: CONTROL_CONVERSATION_ID,
        messageId: START_MESSAGE_ID,
        deliveredAt
      }
    },
    reporting: validReporting({ deliveredAt, agent: reportingAgent }),
    allowKinds: ["read", "execute"],
    ...overrides
  }), { mode: 0o600 });
  return configFile;
}

function cleanSpawnEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  if (!(CLAUDE_OAUTH_TOKEN_ENV in overrides)) {
    delete env[CLAUDE_OAUTH_TOKEN_ENV];
  }
  for (const name of [...CLAUDE_FORBIDDEN_ENV, ...CLAUDE_INJECTION_ENV]) {
    if (!(name in overrides)) {
      delete env[name];
    }
  }
  return env;
}

function collectEvents() {
  const events = [];
  return {
    events,
    writeEvent(event) {
      events.push(event);
    }
  };
}

test("execve argv contract is deterministic and token-free", () => {
  const execution = buildSupervisorExecution(
    "/private/run.json",
    "/private/auth/claude-acp-oauth.env",
    { execPath: "/opt/node/bin/node", supervisorPath: "/skills/acpx-foreground-supervisor.mjs" }
  );
  assert.deepEqual(execution, {
    file: "/opt/node/bin/node",
    args: [
      "/opt/node/bin/node",
      "--env-file=/private/auth/claude-acp-oauth.env",
      "/skills/acpx-foreground-supervisor.mjs",
      "--config",
      "/private/run.json"
    ]
  });

  const defaulted = buildSupervisorExecution("/private/run.json", "/private/a.env");
  assert.equal(defaulted.file, process.execPath);
  assert.equal(defaulted.args[0], process.execPath);
  assert.equal(defaulted.args[2], SUPERVISOR_PATH);
});

test("launcher parent-environment preflight fails closed per credential", () => {
  runLauncherEnvironmentPreflight({ PATH: "/usr/bin", HOME: "/tmp" });

  assert.throws(
    () => runLauncherEnvironmentPreflight({ [CLAUDE_OAUTH_TOKEN_ENV]: "value" }),
    { code: "claude_oauth_token_preexisting" }
  );
  assert.throws(
    () => runLauncherEnvironmentPreflight({ [CLAUDE_OAUTH_TOKEN_ENV]: "" }),
    { code: "claude_oauth_token_preexisting" }
  );
  for (const name of CLAUDE_FORBIDDEN_ENV) {
    assert.throws(
      () => runLauncherEnvironmentPreflight({ [name]: "1" }),
      { code: "claude_competing_credential:" + name },
      name
    );
    runLauncherEnvironmentPreflight({ [name]: "" });
  }
  for (const name of CLAUDE_INJECTION_ENV) {
    assert.throws(
      () => runLauncherEnvironmentPreflight({ [name]: "--require /tmp/x" }),
      { code: "claude_env_injection_capable:" + name },
      name
    );
    runLauncherEnvironmentPreflight({ [name]: "" });
  }
});

test("launcher CLI usage and config-shape errors keep exit 64", POSIX_ONLY, async () => {
  for (const argv of [[], ["--config"], ["run.json"], ["--config", "/a", "/b"], ["--conf", "/a"]]) {
    const sink = collectEvents();
    assert.equal(await main(argv, { env: {}, writeEvent: sink.writeEvent }), EXIT_CODES.invalidConfig);
    assert.equal(sink.events.at(-1).type, "launcher_error");
    assert.equal(sink.events.at(-1).code, "usage");
  }

  const relativeSink = collectEvents();
  assert.equal(
    await main(["--config", "relative/run.json"], { env: {}, writeEvent: relativeSink.writeEvent }),
    EXIT_CODES.invalidConfig
  );
  assert.equal(relativeSink.events.at(-1).code, "invalid_config_path_not_absolute");

  // A valid supported non-Claude agent loads but is refused by the launcher:
  // the canonical Claude route is for agent "claude" only.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-launcher-agent-"));
  makeAuthEnvFile(root);
  const configFile = writeClaudeRunConfig(root, { agent: "codex" });
  const agentSink = collectEvents();
  assert.equal(
    await main(["--config", configFile], { env: {}, writeEvent: agentSink.writeEvent }),
    EXIT_CODES.invalidConfig
  );
  assert.equal(agentSink.events.at(-1).code, "launcher_agent_not_claude");

  // An agent outside the closed supported set never loads at all: the
  // loader's early closed-set gate rejects it with its stable explicit code
  // before any unrelated filesystem access and before the launcher's own
  // agent gate.
  const unsupportedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-launcher-unsupported-"));
  makeAuthEnvFile(unsupportedRoot);
  const unsupportedConfig = writeClaudeRunConfig(unsupportedRoot, { agent: "test-agent" });
  const unsupportedSink = collectEvents();
  assert.equal(
    await main(["--config", unsupportedConfig], { env: {}, writeEvent: unsupportedSink.writeEvent }),
    EXIT_CODES.invalidConfig
  );
  assert.equal(unsupportedSink.events.at(-1).code, "invalid_agent_unsupported");

  const missingAuthRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-launcher-noauth-"));
  const missingAuthConfig = writeClaudeRunConfig(missingAuthRoot);
  const authSink = collectEvents();
  assert.equal(
    await main(["--config", missingAuthConfig], { env: {}, writeEvent: authSink.writeEvent }),
    EXIT_CODES.invalidConfig
  );
  assert.equal(authSink.events.at(-1).code, "invalid_auth");
});

test("launcher rejects credentialed parent environments before re-exec", POSIX_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-launcher-env-"));
  const envFile = makeAuthEnvFile(root);
  const configFile = writeClaudeRunConfig(root, {
    auth: { kind: CLAUDE_AUTH_KIND, envFile }
  });

  const cases = [
    [{ [CLAUDE_OAUTH_TOKEN_ENV]: "value" }, "claude_oauth_token_preexisting"],
    [{ [CLAUDE_OAUTH_TOKEN_ENV]: "" }, "claude_oauth_token_preexisting"],
    ...CLAUDE_FORBIDDEN_ENV.map((name) => [
      { [name]: "1" },
      "claude_competing_credential:" + name
    ]),
    // Injection-capable variables (Node preloads, dynamic-linker preloads,
    // Anthropic endpoint/header/config selectors, proxies) never show up in
    // the supervisor's exec-argv proof, so the launcher must reject them
    // before the token-bearing re-exec. Empty values stay allowed: an empty
    // string cannot inject anything.
    ...CLAUDE_INJECTION_ENV.map((name) => [
      { [name]: "/tmp/injected" },
      "claude_env_injection_capable:" + name
    ])
  ];
  for (const [env, expected] of cases) {
    let execveCalled = false;
    const sink = collectEvents();
    const exitCode = await main(["--config", configFile], {
      env,
      execve() {
        execveCalled = true;
      },
      writeEvent: sink.writeEvent
    });
    assert.equal(exitCode, EXIT_CODES.supervisorError, expected);
    assert.equal(sink.events.at(-1).type, "launcher_error");
    assert.equal(sink.events.at(-1).code, expected);
    assert.equal(execveCalled, false, expected);
  }
});

test("launcher re-validates the env file and fails closed before re-exec", POSIX_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-launcher-envfile-"));
  const envFile = makeAuthEnvFile(root);
  fs.chmodSync(envFile, 0o644);
  const configFile = writeClaudeRunConfig(root, {
    auth: { kind: CLAUDE_AUTH_KIND, envFile }
  });
  let execveCalled = false;
  const sink = collectEvents();
  const exitCode = await main(["--config", configFile], {
    env: {},
    execve() {
      execveCalled = true;
    },
    writeEvent: sink.writeEvent
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(sink.events.at(-1).code, "claude_env_file_permissions");
  assert.equal(execveCalled, false);

  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-launcher-envmissing-"));
  makeAuthEnvFile(missingRoot);
  const missingConfig = writeClaudeRunConfig(missingRoot, {
    auth: {
      kind: CLAUDE_AUTH_KIND,
      envFile: path.join(missingRoot, "auth", "absent.env")
    }
  });
  const missingSink = collectEvents();
  assert.equal(
    await main(["--config", missingConfig], { env: {}, writeEvent: missingSink.writeEvent }),
    EXIT_CODES.supervisorError
  );
  assert.equal(missingSink.events.at(-1).code, "claude_env_file_missing");
});

test("launcher fails closed without process.execve and on a returning execve", POSIX_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-launcher-execve-"));
  const envFile = makeAuthEnvFile(root);
  const configFile = writeClaudeRunConfig(root, {
    auth: { kind: CLAUDE_AUTH_KIND, envFile }
  });

  const unsupportedSink = collectEvents();
  assert.equal(
    await main(["--config", configFile], {
      env: {},
      execve: undefined,
      writeEvent: unsupportedSink.writeEvent
    }),
    EXIT_CODES.supervisorError
  );
  assert.equal(unsupportedSink.events.at(-1).code, "execve_unsupported");

  const captured = [];
  const parentEnv = { PATH: "/usr/bin" };
  const returningSink = collectEvents();
  const exitCode = await main(["--config", configFile], {
    env: parentEnv,
    execve(file, args, env) {
      captured.push({ file, args, env });
    },
    writeEvent: returningSink.writeEvent
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(returningSink.events.at(-1).code, "execve_returned");
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0], {
    file: process.execPath,
    args: [
      process.execPath,
      "--env-file=" + envFile,
      SUPERVISOR_PATH,
      "--config",
      configFile
    ],
    env: parentEnv
  });
  assert.equal(
    JSON.stringify(captured).includes(DUMMY_CLAUDE_TOKEN),
    false
  );
});

test("canonical launcher replaces itself with the supervisor under one PID", EXECVE_E2E, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-launcher-e2e-"));
  const envFile = makeAuthEnvFile(root);
  const runtimeDir = makeMockRuntimePackage(root);
  const configFile = writeClaudeRunConfig(root, {
    runtimeModule: runtimeDir,
    auth: { kind: CLAUDE_AUTH_KIND, envFile }
  });

  const result = spawnSync(process.execPath, [LAUNCHER_PATH, "--config", configFile], {
    env: cleanSpawnEnv(),
    encoding: "utf8",
    input: JSON.stringify({
      schemaVersion: "acp-host-activation.v1",
      processHandle: "launcher-e2e-session"
    }) + "\n",
    timeout: 30000
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events[0].type, "activation_required");
  assert.equal(events[1].type, "activation_confirmed");
  const started = events.find((event) => event.type === "started");
  assert.equal(started.agent, "claude");
  assert.equal(events.at(-1).type, "terminal");
  assert.equal(events.at(-1).status, "completed");
  assert.equal(events.at(-1).supervisorStatus, "ok");

  // The response was produced by the supervisor process, and its PID is the
  // launcher's own spawned PID: execve replaced the image without creating a
  // second tracked process, and the token arrived through --env-file.
  const response = fs.readFileSync(path.join(root, "response.txt"), "utf8");
  assert.equal(response, "pid=" + String(result.pid) + ";token_present=true");
  assert.equal((result.stdout + result.stderr).includes(DUMMY_CLAUDE_TOKEN), false);
});

test("bare direct claude supervisor launch fails closed before runtime loading", POSIX_ONLY, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-bare-e2e-"));
  const envFile = makeAuthEnvFile(root);
  const runtimeDir = makeMockRuntimePackage(root);
  const configFile = writeClaudeRunConfig(root, {
    runtimeModule: runtimeDir,
    auth: { kind: CLAUDE_AUTH_KIND, envFile }
  });

  const result = spawnSync(process.execPath, [SUPERVISOR_PATH, "--config", configFile], {
    env: cleanSpawnEnv(),
    encoding: "utf8",
    timeout: 30000
  });

  assert.equal(result.status, EXIT_CODES.supervisorError);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "supervisor_error");
  assert.equal(events.at(-1).code, "claude_env_file_option_missing");
  assert.equal(fs.existsSync(path.join(root, "state")), false);
  assert.equal(fs.existsSync(path.join(root, "response.txt")), false);
});

test("launcher CLI rejects a pre-credentialed parent environment", POSIX_ONLY, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-launcher-precred-"));
  const envFile = makeAuthEnvFile(root);
  const runtimeDir = makeMockRuntimePackage(root);
  const configFile = writeClaudeRunConfig(root, {
    runtimeModule: runtimeDir,
    auth: { kind: CLAUDE_AUTH_KIND, envFile }
  });

  const result = spawnSync(process.execPath, [LAUNCHER_PATH, "--config", configFile], {
    env: cleanSpawnEnv({ [CLAUDE_OAUTH_TOKEN_ENV]: "" }),
    encoding: "utf8",
    timeout: 30000
  });

  assert.equal(result.status, EXIT_CODES.supervisorError);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "launcher_error");
  assert.equal(events.at(-1).code, "claude_oauth_token_preexisting");
  assert.equal(fs.existsSync(path.join(root, "state")), false);
});

test("public docs and template describe the canonical claude route", () => {
  const skill = fs.readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");
  const contract = fs.readFileSync(
    new URL("../references/runtime-contract.md", import.meta.url),
    "utf8"
  );
  const template = JSON.parse(fs.readFileSync(
    new URL("../templates/supervisor-config.json", import.meta.url),
    "utf8"
  ));

  const claudeProfile = JSON.parse(fs.readFileSync(
    new URL("../templates/claude-auth-profile.json", import.meta.url),
    "utf8"
  ));

  for (const doc of [skill, contract]) {
    assert.match(doc, /claude-acp-launcher\.mjs/);
    assert.match(doc, /claude-setup-token-env-file/);
    assert.match(doc, /process\.execve|--env-file/);
    // Accurate runtime matrix: execve exists in 22.15+ (22.x), 23.11+
    // (23.x), and every later release line, on POSIX platforms only.
    assert.match(doc, /22\.15/);
    assert.match(doc, /23\.11/);
    // The clean-baseline contract names the preload-injection rejection.
    assert.match(doc, /NODE_OPTIONS/);
  }
  assert.match(contract, /^## Claude credential injection$/m);
  assert.match(contract, /launcher_error/);

  // The main template is agent-neutral: no auth block ships in it, and the
  // agent is a caller-substituted placeholder. Claude-specific auth lives in
  // the explicitly provider-specific profile template.
  assert.equal(template.agent, "AGENT_NAME");
  assert.equal("auth" in template, false);
  assert.equal(claudeProfile.agent, "claude");
  assert.equal(claudeProfile.auth.kind, CLAUDE_AUTH_KIND);
  assert.match(claudeProfile.auth.envFile, /^\/absolute\//);

  // Both public docs must describe the mandatory fail-closed reporting gate —
  // the current v3 report-pump schema, the accepted v2 shape, its bounded v1
  // Claude migration path, and the closed agent presentation mapping — and
  // the runtime contract must document every stable reporting error code the
  // validator can produce.
  for (const doc of [skill, contract]) {
    assert.match(doc, /acp-reporting-v3/);
    assert.match(doc, /acp-reporting-v2/);
    assert.match(doc, /acp-reporting-v1/);
    assert.match(doc, /invalid_reporting_/);
    assert.match(doc, /Claude Code/);
    assert.match(doc, /Codex/);
  }
  assert.match(contract, /^## Reporting contract$/m);
  for (const code of ACP_REPORTING_ERROR_CODES) {
    assert.ok(contract.includes(code), `runtime contract must document ${code}`);
  }

  // The early closed-set agent gate and the agent-neutral process-integrity
  // environment baseline are documented with their stable codes.
  for (const code of [
    "invalid_agent_unsupported",
    "invalid_agent_not_canonical",
    "invalid_env_contract_overlap"
  ]) {
    assert.ok(contract.includes(code), `runtime contract must document ${code}`);
  }
  assert.match(contract, /process-integrity/);
  assert.match(skill, /process-integrity/);

  const serialized = skill + contract + JSON.stringify(template) + JSON.stringify(claudeProfile);
  assert.doesNotMatch(serialized, /sk-ant-/);
  assert.doesNotMatch(serialized, /\/Users\/[a-z]/);
});

test("template substitution counts match the documented guidance", () => {
  const templateText = fs.readFileSync(
    new URL("../templates/supervisor-config.json", import.meta.url),
    "utf8"
  );
  const skill = fs.readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");

  // "AGENT_DISPLAY_NAME" does not contain "AGENT_NAME" as a contiguous
  // substring, so the two counts are independent of each other.
  assert.equal("AGENT_DISPLAY_NAME".includes("AGENT_NAME"), false);
  // AGENT_NAME: the config `agent` and the reporting bundle's `agent`
  // attestation. AGENT_DISPLAY_NAME: the start message and its byte-identical
  // receipt copy — the v3 report-pump attestation carries no static report
  // payload, so no third occurrence exists.
  assert.equal(templateText.split("AGENT_NAME").length - 1, 2);
  assert.equal(templateText.split("AGENT_DISPLAY_NAME").length - 1, 2);

  // The operator instructions state the exact occurrence counts, so a
  // template change that adds or removes a placeholder must update both.
  assert.match(skill, /`AGENT_NAME` appears exactly twice/);
  assert.match(skill, /`AGENT_DISPLAY_NAME` appears exactly twice/);
});

test("substituted public template loads through the real supervisor loader", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-template-load-"));
  const promptFile = path.join(root, "prompt.txt");
  fs.writeFileSync(promptFile, "perform the bounded template task", { mode: 0o600 });
  const templateText = fs.readFileSync(
    new URL("../templates/supervisor-config.json", import.meta.url),
    "utf8"
  );

  // Every caller-substituted placeholder must be present, then bound, so the
  // loaded config exercises the loader's full reporting context wiring —
  // agent, model, repository, branch, receipt, and destinations — not just
  // IDs. AGENT_DISPLAY_NAME is replaced before AGENT_NAME so the longer
  // placeholder can never be corrupted by the shorter one.
  const placeholders = [
    "AGENT_DISPLAY_NAME",
    "AGENT_NAME",
    "MODEL_REPORTING_IDENTITY",
    "MODEL_ID",
    "REASONING_EFFORT",
    "CONTROL_CONVERSATION_ID",
    "START_MESSAGE_ID",
    "START_MESSAGE_DELIVERED_AT_ISO_8601",
    "REPOSITORY_BASENAME",
    "BRANCH_NAME"
  ];
  for (const placeholder of placeholders) {
    assert.ok(templateText.includes(placeholder), `template must ship ${placeholder}`);
  }
  const deliveredAt = "2026-08-24T09:30:00.530000+00:00";
  const bind = (agent, displayName, suffix) => {
    const reportingModel = agent === "codex" ? "test-model[medium]" : "test-model";
    const bound = templateText
      .replaceAll("AGENT_DISPLAY_NAME", displayName)
      .replaceAll("AGENT_NAME", agent)
      .replaceAll("MODEL_REPORTING_IDENTITY", reportingModel)
      .replaceAll("MODEL_ID", "test-model")
      .replaceAll("REASONING_EFFORT", "medium")
      .replaceAll("CONTROL_CONVERSATION_ID", CONTROL_CONVERSATION_ID)
      .replaceAll("START_MESSAGE_ID", START_MESSAGE_ID)
      .replaceAll("START_MESSAGE_DELIVERED_AT_ISO_8601", deliveredAt)
      .replaceAll("REPOSITORY_BASENAME", "openclaw-skills")
      .replaceAll("BRANCH_NAME", "fix/acp-reporting-fail-closed-guard")
      .replaceAll("/absolute/path/to/workspace", root)
      .replaceAll("/absolute/private/path/prompt.txt", promptFile)
      .replaceAll("/absolute/private/path/response.txt", path.join(root, "response-" + suffix + ".txt"))
      .replaceAll("/absolute/private/path/acpx-state", path.join(root, "acpx-state"));
    for (const placeholder of placeholders) {
      assert.equal(bound.includes(placeholder), false, `${placeholder} must be bound`);
    }
    // The template ships runtimeModule as the deliberately non-absolute
    // preflight sentinel; the canonical preparation replaces it through the
    // runtime-preflight assemble seam, exercised here with an attested-style
    // absolute path.
    const draft = JSON.parse(bound);
    if (agent === "claude") {
      delete draft.reasoningEffort;
    }
    assert.equal(draft.runtimeModule, "RUNTIME_MODULE_FROM_PREFLIGHT");
    return JSON.stringify(assembleSupervisorConfig(draft, { runtimeModule: root }));
  };

  // The agent-neutral template loads as-is for codex: no auth block needed.
  const codexFile = path.join(root, "template-codex.json");
  fs.writeFileSync(codexFile, bind("codex", "Codex", "codex"), { mode: 0o600 });
  const codex = loadSupervisorConfig(codexFile);
  assert.equal(codex.agent, "codex");
  assert.equal(codex.auth, undefined);
  assert.equal(codex.reporting.schemaVersion, "acp-reporting-v3");
  assert.equal(codex.reporting.agent, "codex");
  assert.match(
    codex.reporting.startMessage,
    /🤖 \*\*ACP\*\*: Codex · `test-model\[medium\]`/
  );

  // For claude, the same neutral template composes with the provider-specific
  // auth profile template: substitute claude/Claude Code and merge the
  // profile's auth block.
  const claudeProfile = JSON.parse(fs.readFileSync(
    new URL("../templates/claude-auth-profile.json", import.meta.url),
    "utf8"
  ));
  const claudeConfig = JSON.parse(bind("claude", "Claude Code", "claude"));
  assert.equal(claudeConfig.agent, claudeProfile.agent);
  claudeConfig.auth = claudeProfile.auth;
  const claudeFile = path.join(root, "template-claude.json");
  fs.writeFileSync(claudeFile, JSON.stringify(claudeConfig), { mode: 0o600 });
  const loaded = loadSupervisorConfig(claudeFile);

  assert.equal(loaded.agent, "claude");
  assert.equal(loaded.auth.kind, CLAUDE_AUTH_KIND);
  assert.equal(loaded.model, "test-model");
  assert.equal(loaded.lifecycle.controlConversationId, CONTROL_CONVERSATION_ID);
  assert.equal(loaded.lifecycle.startReceipt.deliveredAt, deliveredAt);
  assert.equal(Object.isFrozen(loaded.reporting), true);
  assert.equal(loaded.reporting.schemaVersion, "acp-reporting-v3");
  assert.equal(loaded.reporting.agent, "claude");
  assert.equal(loaded.reporting.roundIndex, 1);
  assert.equal(loaded.reporting.repository, "openclaw-skills");
  assert.equal(loaded.reporting.branch, "fix/acp-reporting-fail-closed-guard");
  assert.equal(loaded.reporting.startMessage.split("\n").length, 13);
  assert.match(loaded.reporting.startMessage, /🤖 \*\*ACP\*\*: Claude Code · `test-model`/);
  assert.equal(loaded.reporting.startDestination, CONTROL_CONVERSATION_ID);
  assert.equal(loaded.reporting.pumpDestination, CONTROL_CONVERSATION_ID);
  assert.equal(loaded.reporting.terminalDestination, CONTROL_CONVERSATION_ID);
  assert.equal(loaded.reporting.startReceipt.messageId, START_MESSAGE_ID);
  assert.equal(loaded.reporting.startReceipt.deliveredAt, deliveredAt);
  // The v3 bundle attests the enabled deterministic script structure without
  // carrying the substituted script, lease token, or a static report.
  assert.equal(loaded.reporting.reportPump.enabled, true);
  assert.equal(loaded.reporting.reportPump.sessionTarget, "isolated");
  assert.deepEqual(loaded.reporting.reportPump.schedule, {
    kind: "every",
    everyMs: ACP_REPORT_CONTROLLER_POLL_INTERVAL_MS
  });
  assert.deepEqual(loaded.reporting.reportPump.payload, {
    kind: "script",
    scriptVersion: "acp-report-controller-script.v1",
    scriptSha256: "1dd0ccd2d2bd25ef25c002672a2b6ac4ccf7721b2b9e6304bdf4ddd8ce8ca6f2",
    timeoutSeconds: 60,
    toolBudget: 5,
    toolsAllow: ["acp_report_controller", "message", "automations"]
  });
  assert.equal("watchdog" in loaded.reporting, false);
  assert.deepEqual(loaded.reporting.reportPump.delivery, { mode: "none" });
});

test("launcher rejects a non-canonical claude spelling as invalid config", POSIX_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-launcher-case-"));
  const envFile = makeAuthEnvFile(root);
  const configFile = writeClaudeRunConfig(root, {
    agent: "Claude",
    auth: { kind: CLAUDE_AUTH_KIND, envFile }
  });
  let execveCalled = false;
  const sink = collectEvents();
  const exitCode = await main(["--config", configFile], {
    env: {},
    execve() {
      execveCalled = true;
    },
    writeEvent: sink.writeEvent
  });
  assert.equal(exitCode, EXIT_CODES.invalidConfig);
  assert.equal(sink.events.at(-1).type, "launcher_error");
  assert.equal(sink.events.at(-1).code, "invalid_agent_not_canonical");
  assert.equal(execveCalled, false);
});

test("launcher pre-checks exec targets and maps a throwing execve", POSIX_ONLY, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-launcher-targets-"));
  const envFile = makeAuthEnvFile(root);
  const configFile = writeClaudeRunConfig(root, {
    auth: { kind: CLAUDE_AUTH_KIND, envFile }
  });

  const targetCases = [
    [{ execPath: path.join(root, "missing-node") }, "launcher_exec_target_missing"],
    [{ supervisorPath: path.join(root, "missing-supervisor.mjs") }, "launcher_supervisor_missing"]
  ];
  for (const [overrides, expected] of targetCases) {
    let execveCalled = false;
    const sink = collectEvents();
    const exitCode = await main(["--config", configFile], {
      env: {},
      ...overrides,
      execve() {
        execveCalled = true;
      },
      writeEvent: sink.writeEvent
    });
    assert.equal(exitCode, EXIT_CODES.supervisorError, expected);
    assert.equal(sink.events.at(-1).code, expected);
    assert.equal(execveCalled, false, expected);
  }

  // The real process.execve throws a catchable system error on failure; the
  // launcher maps it to a bounded code instead of leaking error text.
  const throwingSink = collectEvents();
  const exitCode = await main(["--config", configFile], {
    env: {},
    execve() {
      const error = new Error("boom");
      error.code = "ETXTBSY";
      throw error;
    },
    writeEvent: throwingSink.writeEvent
  });
  assert.equal(exitCode, EXIT_CODES.supervisorError);
  assert.equal(throwingSink.events.at(-1).code, "execve_failed:ETXTBSY");
});

test("real execve failure throws and is catchable, not an abort", EXECVE_E2E, () => {
  // Regression proof for the launcher's failure contract: a failing
  // process.execve raises a normal system error in-process, so the
  // launcher's catch path is reachable with the real binding.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-execve-throw-"));
  const probe = path.join(root, "probe.mjs");
  fs.writeFileSync(probe, [
    "try {",
    "  process.execve(process.argv[2], [process.argv[2]], {});",
    "  console.log('returned');",
    "} catch (error) {",
    "  console.log('threw:' + error.code);",
    "}"
  ].join("\n"), { mode: 0o600 });
  const result = spawnSync(process.execPath, [
    probe,
    path.join(root, "missing-target")
  ], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /^threw:ENOENT$/m);
});

test("parent NODE_OPTIONS preload cannot reach the token-bearing re-exec", POSIX_ONLY, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-launcher-preload-"));
  const envFile = makeAuthEnvFile(root);
  const runtimeDir = makeMockRuntimePackage(root);
  const configFile = writeClaudeRunConfig(root, {
    runtimeModule: runtimeDir,
    auth: { kind: CLAUDE_AUTH_KIND, envFile }
  });

  // The preload marker records whether it ever observed the setup token.
  // Node itself preloads it into the launcher process (that is unavoidable
  // and token-free); the launcher must then refuse the re-exec so the marker
  // never runs inside a process whose environment holds the token.
  const canary = path.join(root, "preload-canary.txt");
  const marker = path.join(root, "marker.cjs");
  fs.writeFileSync(marker, [
    "require('node:fs').appendFileSync(" + JSON.stringify(canary) + ",",
    "  'token_present=' + String(" +
      JSON.stringify(CLAUDE_OAUTH_TOKEN_ENV) + " in process.env) + '\\n');"
  ].join("\n"), { mode: 0o600 });

  const result = spawnSync(process.execPath, [LAUNCHER_PATH, "--config", configFile], {
    env: cleanSpawnEnv({ NODE_OPTIONS: "--require " + marker }),
    encoding: "utf8",
    timeout: 30000
  });

  assert.equal(result.status, EXIT_CODES.supervisorError);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "launcher_error");
  assert.equal(events.at(-1).code, "claude_env_injection_capable:NODE_OPTIONS");
  // No supervisor start, no state, no response: the re-exec never happened.
  assert.equal(events.some((event) => event.type === "started"), false);
  assert.equal(fs.existsSync(path.join(root, "state")), false);
  assert.equal(fs.existsSync(path.join(root, "response.txt")), false);
  // The marker ran only in token-free processes.
  if (fs.existsSync(canary)) {
    assert.doesNotMatch(fs.readFileSync(canary, "utf8"), /token_present=true/);
  }
});

test("launcher invoked through a symlinked path still runs main", POSIX_ONLY, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-launcher-symlink-"));
  const link = path.join(root, "launcher-link.mjs");
  fs.symlinkSync(LAUNCHER_PATH, link);

  // Before the realpath-safe entry guard, a symlinked argv path (or macOS
  // /tmp) silently exited 0 without running main. A usage failure proves
  // main actually ran.
  const result = spawnSync(process.execPath, [link], {
    env: cleanSpawnEnv(),
    encoding: "utf8",
    timeout: 15000
  });
  assert.equal(result.status, EXIT_CODES.invalidConfig);
  const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "launcher_error");
  assert.equal(events.at(-1).code, "usage");
});
