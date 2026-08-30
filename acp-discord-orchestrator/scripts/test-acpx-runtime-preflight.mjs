import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACPX_MINIMUM_RUNTIME_VERSION,
  ACPX_RUNTIME_ATTESTATION_SCHEMA_VERSION,
  ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION,
  assembleSupervisorConfig,
  createRuntimeAttestation,
  inspectAcpxRuntimePackage,
  readRuntimeAttestation,
  selectAcpxRuntimeModule,
  validateAcpxRuntimePackage,
  verifyRuntimeAttestation,
  writeRuntimeAttestation
} from "./acpx-runtime-preflight.mjs";
import { main } from "./acpx-runtime-preflight-cli.mjs";

const CAPABILITY_EXPORTS = ["createAcpRuntime", "createRuntimeStore", "createAgentRegistry"];

function makeRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Synthetic ACPX runtime package: a CommonJS dist/runtime.js whose
// `exports.<name> =` assignments surface as named exports through dynamic
// import, exactly the shape the supervisor's capability check consumes.
function makeAcpxPackage(root, options = {}) {
  const name = options.name ?? "acpx";
  const version = options.version ?? ACPX_MINIMUM_RUNTIME_VERSION;
  const exportNames = options.exportNames ?? CAPABILITY_EXPORTS;
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name, version }, null, 2)
  );
  if (options.withEntry !== false) {
    fs.writeFileSync(
      path.join(root, "dist", "runtime.js"),
      exportNames.map((exportName) => `exports.${exportName} = function () {};`).join("\n") + "\n"
    );
  }
  return root;
}

function makePluginInfo(pluginRoot, dependencies, extra = {}) {
  return {
    name: "@openclaw/acpx",
    path: pluginRoot,
    dependencies,
    ...extra
  };
}

function writePrivateJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
  return filePath;
}

function assertFailsWith(callback, code) {
  assert.throws(callback, (error) => error && error.code === code, "expected code " + code);
}

async function assertRejectsWith(promise, code) {
  await assert.rejects(promise, (error) => error && error.code === code, "expected code " + code);
}

async function runCliMain(inputFile, dependencies = {}) {
  const results = [];
  const errors = [];
  const exitCode = await main(["--input", inputFile], {
    writeResult: (event) => results.push(event),
    writeEvent: (event) => errors.push(event),
    ...dependencies
  });
  return { exitCode, results, errors };
}

test("selects the exact nested acpx dependency by absolute resolvedPath", () => {
  const pluginRoot = "/private/plugins/@openclaw/acpx";
  const nested = "/private/plugins/@openclaw/acpx/node_modules/acpx";
  const selected = selectAcpxRuntimeModule(makePluginInfo(pluginRoot, [
    { name: "@openclaw/plugin-sdk", resolvedPath: "/private/plugins/@openclaw/plugin-sdk" },
    { name: "acpx", resolvedPath: nested },
    { name: "acpx-utils", resolvedPath: "/private/plugins/acpx-utils" }
  ]));
  assert.equal(selected, path.normalize(nested));
});

test("rejects the active plugin package root offered as the acpx dependency", () => {
  const pluginRoot = "/private/plugins/@openclaw/acpx";
  assertFailsWith(
    () => selectAcpxRuntimeModule(makePluginInfo(pluginRoot, [
      { name: "acpx", resolvedPath: pluginRoot }
    ])),
    "plugin_info_plugin_root_selected"
  );
});

test("rejects plugin info without an exact acpx dependency", () => {
  assertFailsWith(
    () => selectAcpxRuntimeModule(makePluginInfo("/private/plugins/@openclaw/acpx", [
      { name: "@openclaw/acpx", resolvedPath: "/private/plugins/@openclaw/acpx" },
      { name: "acpx-utils", resolvedPath: "/private/plugins/acpx-utils" },
      { name: "Acpx", resolvedPath: "/private/plugins/acpx-cased" }
    ])),
    "plugin_info_dependency_missing"
  );
});

test("rejects duplicate exact acpx dependency entries", () => {
  assertFailsWith(
    () => selectAcpxRuntimeModule(makePluginInfo("/private/plugins/@openclaw/acpx", [
      { name: "acpx", resolvedPath: "/private/a/acpx" },
      { name: "acpx", resolvedPath: "/private/b/acpx" }
    ])),
    "plugin_info_dependency_duplicate"
  );
});

test("rejects relative and malformed resolved paths", () => {
  for (const resolvedPath of ["node_modules/acpx", "./acpx", "", 42, undefined, "/private/\0acpx"]) {
    assertFailsWith(
      () => selectAcpxRuntimeModule(makePluginInfo("/private/plugins/@openclaw/acpx", [
        { name: "acpx", resolvedPath }
      ])),
      "plugin_info_resolved_path_invalid"
    );
  }
});

test("rejects malformed plugin info shapes", () => {
  assertFailsWith(() => selectAcpxRuntimeModule(null), "plugin_info_invalid");
  assertFailsWith(() => selectAcpxRuntimeModule([]), "plugin_info_invalid");
  assertFailsWith(
    () => selectAcpxRuntimeModule({ dependencies: {} }),
    "plugin_info_dependencies_invalid"
  );
  assertFailsWith(
    () => selectAcpxRuntimeModule({ dependencies: [] }),
    "plugin_info_dependencies_invalid"
  );
  assertFailsWith(
    () => selectAcpxRuntimeModule({ dependencies: [{ resolvedPath: "/private/acpx" }] }),
    "plugin_info_dependencies_invalid"
  );
});

test("validates a real runtime package and binds digests", async () => {
  const root = makeAcpxPackage(makeRoot("acpx-preflight-valid-"));
  const inspection = await validateAcpxRuntimePackage(root);
  assert.equal(inspection.runtimeModule, path.normalize(root));
  assert.equal(inspection.runtimeVersion, ACPX_MINIMUM_RUNTIME_VERSION);
  assert.match(inspection.packageJsonSha256, /^[0-9a-f]{64}$/);
  assert.match(inspection.runtimeEntrySha256, /^[0-9a-f]{64}$/);
});

test("rejects a plugin-root-shaped package even without a derivable root field", async () => {
  // The mistaken selection from the incident: the path resolves to the
  // @openclaw/acpx plugin package, not the acpx runtime package.
  const root = makeAcpxPackage(makeRoot("acpx-preflight-pluginpkg-"), {
    name: "@openclaw/acpx",
    withEntry: false
  });
  await assertRejectsWith(validateAcpxRuntimePackage(root), "runtime_package_name_invalid");
});

test("rejects a package without the dist/runtime.js entry", async () => {
  const root = makeAcpxPackage(makeRoot("acpx-preflight-noentry-"), { withEntry: false });
  await assertRejectsWith(validateAcpxRuntimePackage(root), "runtime_entry_missing");
});

test("rejects a symlinked runtime entry", { skip: process.platform === "win32" }, async () => {
  const root = makeAcpxPackage(makeRoot("acpx-preflight-symlink-"));
  const entry = path.join(root, "dist", "runtime.js");
  const target = path.join(root, "dist", "actual.js");
  fs.renameSync(entry, target);
  fs.symlinkSync(target, entry);
  await assertRejectsWith(validateAcpxRuntimePackage(root), "runtime_entry_symlink");
});

test("rejects package versions below the supported ACPX floor", async () => {
  const root = makeAcpxPackage(makeRoot("acpx-preflight-old-"), { version: "0.5.3" });
  await assertRejectsWith(validateAcpxRuntimePackage(root), "runtime_package_version_unsupported");
});

test("rejects non-release version strings", async () => {
  const root = makeAcpxPackage(makeRoot("acpx-preflight-prerelease-"), {
    version: "0.11.2-beta.1"
  });
  await assertRejectsWith(validateAcpxRuntimePackage(root), "runtime_package_version_invalid");
});

test("capability exports stay authoritative beyond the version gate", async () => {
  const root = makeAcpxPackage(makeRoot("acpx-preflight-caps-"), {
    version: "0.13.0",
    exportNames: ["createAcpRuntime", "createRuntimeStore"]
  });
  await assertRejectsWith(
    validateAcpxRuntimePackage(root),
    "acpx_runtime_capability_missing_createAgentRegistry"
  );
});

test("rejects an unloadable runtime entry", async () => {
  const root = makeAcpxPackage(makeRoot("acpx-preflight-broken-"));
  fs.writeFileSync(path.join(root, "dist", "runtime.js"), "throw new Error('boot failure');\n");
  await assertRejectsWith(validateAcpxRuntimePackage(root), "runtime_entry_unloadable");
});

test("attestation round-trips and re-verifies against the unchanged package", () => {
  const root = makeAcpxPackage(makeRoot("acpx-preflight-attest-"));
  const stateDir = makeRoot("acpx-preflight-state-");
  const attestationFile = path.join(stateDir, "attestation.json");
  const issuedAtMs = 1756500000000;
  const attestation = createRuntimeAttestation(inspectAcpxRuntimePackage(root), issuedAtMs);
  writeRuntimeAttestation(attestationFile, attestation);
  assert.equal(fs.statSync(attestationFile).mode & 0o077, 0);
  const reloaded = readRuntimeAttestation(attestationFile);
  assert.deepEqual(reloaded, {
    schemaVersion: ACPX_RUNTIME_ATTESTATION_SCHEMA_VERSION,
    runtimeModule: path.normalize(root),
    runtimeVersion: ACPX_MINIMUM_RUNTIME_VERSION,
    packageJsonSha256: attestation.packageJsonSha256,
    runtimeEntrySha256: attestation.runtimeEntrySha256,
    issuedAtMs
  });
  const inspection = verifyRuntimeAttestation(reloaded, { nowMs: issuedAtMs + 1000 });
  assert.equal(inspection.runtimeModule, path.normalize(root));
  // The attestation artifact is created exactly once per path.
  assertFailsWith(
    () => writeRuntimeAttestation(attestationFile, attestation),
    "runtime_attestation_exists"
  );
});

test("verification fails closed on stale, future, mismatched, and missing attestations", () => {
  const root = makeAcpxPackage(makeRoot("acpx-preflight-verify-"));
  const issuedAtMs = 1756500000000;
  const attestation = createRuntimeAttestation(inspectAcpxRuntimePackage(root), issuedAtMs);

  assertFailsWith(
    () => verifyRuntimeAttestation(attestation, { nowMs: issuedAtMs + 600001 }),
    "runtime_attestation_stale"
  );
  assertFailsWith(
    () => verifyRuntimeAttestation(attestation, { nowMs: issuedAtMs + 2001, maxAgeMs: 2000 }),
    "runtime_attestation_stale"
  );
  assertFailsWith(
    () => verifyRuntimeAttestation(attestation, { nowMs: issuedAtMs - 2000 }),
    "runtime_attestation_future"
  );
  assertFailsWith(
    () => verifyRuntimeAttestation(attestation, { nowMs: issuedAtMs, maxAgeMs: 999 }),
    "invalid_preflight_max_age"
  );

  // The runtime entry changed after attestation: the digest binding breaks.
  fs.appendFileSync(path.join(root, "dist", "runtime.js"), "// patched\n");
  assertFailsWith(
    () => verifyRuntimeAttestation(attestation, { nowMs: issuedAtMs + 1000 }),
    "runtime_attestation_mismatch"
  );

  assertFailsWith(
    () => readRuntimeAttestation(path.join(makeRoot("acpx-preflight-absent-"), "missing.json")),
    "runtime_attestation_missing"
  );
});

test("rejects attestation artifacts with tampered shapes", () => {
  const stateDir = makeRoot("acpx-preflight-shape-");
  const attestationFile = path.join(stateDir, "attestation.json");
  const valid = {
    schemaVersion: ACPX_RUNTIME_ATTESTATION_SCHEMA_VERSION,
    runtimeModule: "/private/acpx",
    runtimeVersion: "0.11.2",
    packageJsonSha256: "a".repeat(64),
    runtimeEntrySha256: "b".repeat(64),
    issuedAtMs: 1756500000000
  };
  const tampered = [
    { ...valid, schemaVersion: "acpx-runtime-attestation.v0" },
    { ...valid, runtimeModule: "relative/acpx" },
    { ...valid, runtimeVersion: "0.11" },
    { ...valid, packageJsonSha256: "not-a-digest" },
    { ...valid, issuedAtMs: "1756500000000" },
    { ...valid, extra: true }
  ];
  for (const [index, artifact] of tampered.entries()) {
    const file = path.join(stateDir, "tampered-" + index + ".json");
    fs.writeFileSync(file, JSON.stringify(artifact), { mode: 0o600 });
    assertFailsWith(() => readRuntimeAttestation(file), "runtime_attestation_invalid");
  }
  if (process.platform !== "win32") {
    // chmod after write: the requested creation mode is masked by the
    // process umask, and this case needs group-readable bits to exist.
    fs.writeFileSync(attestationFile, JSON.stringify(valid), { mode: 0o600 });
    fs.chmodSync(attestationFile, 0o644);
    assertFailsWith(() => readRuntimeAttestation(attestationFile), "runtime_attestation_invalid");
  }
});

test("assembly supplies the attested runtimeModule and replaces any draft value", () => {
  const attestation = { runtimeModule: "/private/plugins/@openclaw/acpx/node_modules/acpx" };
  const assembled = assembleSupervisorConfig(
    { agent: "codex", runtimeModule: "RUNTIME_MODULE_FROM_PREFLIGHT", timeoutMs: 1000 },
    attestation
  );
  assert.deepEqual(assembled, {
    agent: "codex",
    runtimeModule: attestation.runtimeModule,
    timeoutMs: 1000
  });
  assertFailsWith(() => assembleSupervisorConfig(null, attestation), "invalid_config_draft");
});

test("the shipped supervisor-config template cannot bypass the preflight", () => {
  // The template's runtimeModule sentinel is deliberately not an absolute
  // path: a config prepared from the template without the assemble step
  // fails the supervisor's own loader instead of running a hand-chosen
  // module.
  const template = JSON.parse(fs.readFileSync(
    fileURLToPath(new URL("../templates/supervisor-config.json", import.meta.url)),
    "utf8"
  ));
  assert.equal(template.runtimeModule, "RUNTIME_MODULE_FROM_PREFLIGHT");
  assert.equal(path.isAbsolute(template.runtimeModule), false);
});

test("CLI attest and assemble produce a config bound to the attested module", async () => {
  const root = makeAcpxPackage(makeRoot("acpx-preflight-cli-"));
  const stateDir = makeRoot("acpx-preflight-cli-state-");
  const pluginInfoFile = writePrivateJson(
    path.join(stateDir, "plugin-info.json"),
    makePluginInfo("/private/plugins/@openclaw/acpx", [{ name: "acpx", resolvedPath: root }])
  );
  const attestationFile = path.join(stateDir, "attestation.json");
  const attestInput = writePrivateJson(path.join(stateDir, "attest.json"), {
    schemaVersion: ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION,
    action: "attest",
    pluginInfoFile,
    attestationFile
  });

  const attest = await runCliMain(attestInput);
  assert.equal(attest.exitCode, 0);
  assert.deepEqual(attest.errors, []);
  assert.deepEqual(attest.results, [{
    schemaVersion: ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION,
    type: "runtime_preflight_result",
    action: "attest",
    status: "runtime_attested",
    runtimeVersion: ACPX_MINIMUM_RUNTIME_VERSION
  }]);

  const draftFile = writePrivateJson(path.join(stateDir, "draft.json"), {
    agent: "codex",
    runtimeModule: "RUNTIME_MODULE_FROM_PREFLIGHT",
    timeoutMs: 1000
  });
  const outputFile = path.join(stateDir, "run.json");
  const assembleInput = writePrivateJson(path.join(stateDir, "assemble.json"), {
    schemaVersion: ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION,
    action: "assemble",
    attestationFile,
    configFile: draftFile,
    outputFile
  });

  const assemble = await runCliMain(assembleInput);
  assert.equal(assemble.exitCode, 0);
  assert.deepEqual(assemble.errors, []);
  assert.equal(assemble.results[0].status, "config_assembled");
  assert.equal(fs.statSync(outputFile).mode & 0o077, 0);
  const finalConfig = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  assert.equal(finalConfig.runtimeModule, path.normalize(root));
  assert.equal(finalConfig.agent, "codex");
  assert.equal(finalConfig.timeoutMs, 1000);

  // The output config is created exactly once per path.
  const again = await runCliMain(assembleInput);
  assert.equal(again.exitCode, 64);
  assert.equal(again.errors[0].code, "config_output_exists");
});

test("CLI assembly fails closed without an attestation and never echoes paths", async () => {
  const stateDir = makeRoot("acpx-preflight-cli-noattest-");
  const draftFile = writePrivateJson(path.join(stateDir, "draft.json"), { agent: "codex" });
  const assembleInput = writePrivateJson(path.join(stateDir, "assemble.json"), {
    schemaVersion: ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION,
    action: "assemble",
    attestationFile: path.join(stateDir, "missing-attestation.json"),
    configFile: draftFile,
    outputFile: path.join(stateDir, "run.json")
  });
  const outcome = await runCliMain(assembleInput);
  assert.equal(outcome.exitCode, 64);
  assert.deepEqual(outcome.results, []);
  assert.deepEqual(outcome.errors, [{
    schemaVersion: ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION,
    type: "runtime_preflight_error",
    code: "runtime_attestation_missing"
  }]);
  assert.equal(JSON.stringify(outcome.errors).includes(stateDir), false);
});

test("CLI attest rejection of a mistaken plugin root stays bounded", async () => {
  const pluginRoot = makeAcpxPackage(makeRoot("acpx-preflight-cli-root-"), {
    name: "@openclaw/acpx",
    withEntry: false
  });
  const stateDir = makeRoot("acpx-preflight-cli-root-state-");
  const pluginInfoFile = writePrivateJson(
    path.join(stateDir, "plugin-info.json"),
    makePluginInfo(pluginRoot, [{ name: "acpx", resolvedPath: pluginRoot }])
  );
  const attestInput = writePrivateJson(path.join(stateDir, "attest.json"), {
    schemaVersion: ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION,
    action: "attest",
    pluginInfoFile,
    attestationFile: path.join(stateDir, "attestation.json")
  });
  const outcome = await runCliMain(attestInput);
  assert.equal(outcome.exitCode, 64);
  assert.deepEqual(outcome.errors, [{
    schemaVersion: ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION,
    type: "runtime_preflight_error",
    code: "plugin_info_plugin_root_selected"
  }]);
  assert.equal(JSON.stringify(outcome.errors).includes(pluginRoot), false);
});

test("CLI input gate rejects unknown actions, schemas, and extra keys", async () => {
  const stateDir = makeRoot("acpx-preflight-cli-input-");
  const cases = [
    [{ schemaVersion: "acpx-runtime-preflight.v2", action: "attest" }, "invalid_preflight_schema_version"],
    [{ schemaVersion: ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION, action: "discover" }, "invalid_preflight_action"],
    [{
      schemaVersion: ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION,
      action: "attest",
      pluginInfoFile: "/absolute/a.json",
      attestationFile: "/absolute/b.json",
      runtimeModule: "/absolute/injected"
    }, "invalid_preflight_input"],
    [{
      schemaVersion: ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION,
      action: "attest",
      pluginInfoFile: "relative.json",
      attestationFile: "/absolute/b.json"
    }, "invalid_preflight_plugin_info_file"],
    [{
      schemaVersion: ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION,
      action: "assemble",
      attestationFile: "/absolute/a.json",
      configFile: "/absolute/b.json",
      outputFile: "/absolute/c.json",
      maxAttestationAgeMs: 999
    }, "invalid_preflight_max_age"]
  ];
  for (const [index, [input, code]] of cases.entries()) {
    const inputFile = writePrivateJson(path.join(stateDir, "input-" + index + ".json"), input);
    const outcome = await runCliMain(inputFile);
    assert.equal(outcome.exitCode, 64);
    assert.equal(outcome.errors[0].code, code);
  }
  const usage = await main([], { writeEvent: () => {}, writeResult: () => {} });
  assert.equal(usage, 64);
});

test("CLI entry point runs end to end as a process", () => {
  const root = makeAcpxPackage(makeRoot("acpx-preflight-spawn-"));
  const stateDir = makeRoot("acpx-preflight-spawn-state-");
  const pluginInfoFile = writePrivateJson(
    path.join(stateDir, "plugin-info.json"),
    makePluginInfo("/private/plugins/@openclaw/acpx", [{ name: "acpx", resolvedPath: root }])
  );
  const attestInput = writePrivateJson(path.join(stateDir, "attest.json"), {
    schemaVersion: ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION,
    action: "attest",
    pluginInfoFile,
    attestationFile: path.join(stateDir, "attestation.json")
  });
  const cliFile = fileURLToPath(new URL("./acpx-runtime-preflight-cli.mjs", import.meta.url));

  const success = spawnSync(process.execPath, [cliFile, "--input", attestInput], {
    encoding: "utf8"
  });
  assert.equal(success.status, 0);
  assert.equal(JSON.parse(success.stdout).status, "runtime_attested");
  assert.equal(success.stderr, "");

  const failure = spawnSync(process.execPath, [cliFile, "--input", attestInput], {
    encoding: "utf8"
  });
  assert.equal(failure.status, 64);
  assert.equal(JSON.parse(failure.stderr).code, "runtime_attestation_exists");
  assert.equal(failure.stderr.includes(stateDir), false);
});
