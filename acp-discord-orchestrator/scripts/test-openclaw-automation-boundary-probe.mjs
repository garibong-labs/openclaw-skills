import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PROBE = fileURLToPath(new URL("./check-openclaw-automation-boundary.mjs", import.meta.url));
const VERSION = "2026.8.1";

function makeInstall({ withDist = true, source, dependencySource } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-boundary-fixture-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw", version: VERSION }));
  if (withDist) {
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    if (source !== undefined) fs.writeFileSync(path.join(dist, "fixture.js"), source);
    if (dependencySource !== undefined) fs.writeFileSync(path.join(dist, "deps.js"), dependencySource);
  }
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [PROBE, root], { encoding: "utf8" });
}

const ALL_SIGNATURES = [
  "openclaw-tools:core-tool-list",
  '"cron.remove": async (',
  "const CronAddParamsSchema = closedObject({",
  "function normalizeCronJobInput(",
  "function cronJobReadView(",
  "function jsonResult(",
].map((value) => `// ${value}`).join("\n");

test("no supported installation is the only exit-zero SKIP", () => {
  const missing = path.join(os.tmpdir(), `acp-no-install-${process.pid}-${Date.now()}`);
  const result = run(missing);
  assert.equal(result.status, 0);
  assert.match(result.stdout,
    /^SKIP installed-boundary probe: no supported OpenClaw installation found\n$/u);
  assert.equal(result.stderr, "");
});

test("an exact supported package with a missing signature fails nonzero", () => {
  const root = makeInstall();
  const result = run(root);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "FAIL installed-boundary probe: bundle_signature_missing\n");
  assert.equal(result.stderr, "");
});

test("an exact supported package with unliftable helpers fails nonzero", () => {
  const root = makeInstall({
    source: `${ALL_SIGNATURES}\nfunction capCronJobToolsAllow() {\n}\n`,
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "FAIL installed-boundary probe: allowlist_helper_lift_failed\n");
  assert.equal(result.stderr, "");
});

test("an exact supported package whose lifted helper cannot import fails nonzero", () => {
  const imported = [
    "isRecord", "expandToolGroups", "normalizeToolPolicyName",
    "createToolPolicyMatcher", "expandPolicyWithPluginGroups", "buildPluginToolGroups",
  ].map((name, index) => `${String.fromCharCode(97 + index)} as ${name}`).join(", ");
  const functions = [
    "normalizeCronToolsAllow", "normalizeCronCreatorToolsAllow",
    "hasCronTriggerScript", "capCronJobToolsAllow",
  ].map((name) => `function ${name}() {\n  return undefined;\n}\n`).join("\n");
  const root = makeInstall({
    source: `import { ${imported} } from "./deps.js";\n${ALL_SIGNATURES}\n${functions}`,
    dependencySource: "this is not valid JavaScript !!!\n",
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "FAIL installed-boundary probe: allowlist_helper_import_failed\n");
  assert.equal(result.stderr, "");
});
