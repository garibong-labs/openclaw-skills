// Operator CLI for the canonical runtime-module preflight.
//
// Reads exactly one absolute owner-private JSON input file:
//
//   node acpx-runtime-preflight-cli.mjs --input /absolute/private/preflight.json
//
// Closed actions under schema acpx-runtime-preflight.v1:
//
// - "attest": consume the owner-private structured output of
//   `openclaw plugins info acpx --json` (pluginInfoFile), uniquely select the
//   dependency named exactly "acpx", validate the resolved package (name,
//   ACPX 0.11.2-or-newer version, dist/runtime.js entry, authoritative
//   capability exports), and write the owner-private attestation
//   (attestationFile, created fresh).
// - "assemble": re-verify the attestation fail-closed (absent, stale,
//   mismatched, or invalid attestations are rejected), then write the final
//   supervisor config (outputFile, created fresh) as the owner-prepared
//   draft (configFile) with `runtimeModule` supplied from the attestation.
//
// Fail-closed and evidence-minimal like the other operator CLIs: success
// writes one bounded runtime_preflight_result event to stdout, every failure
// writes exactly one runtime_preflight_error event with a bounded stable
// code to stderr and exits with the invalid-config code. No path, plugin-info
// payload, or free text is ever echoed.

import fs from "node:fs";
import path from "node:path";

import { EXIT_CODES, fail, isCliEntry, safeDiagnosticCode } from "./acpx-foreground-supervisor.mjs";
import {
  ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION,
  assembleSupervisorConfig,
  createRuntimeAttestation,
  isBoundedAttestationAge,
  readRuntimeAttestation,
  selectAcpxRuntimeModule,
  validateAcpxRuntimePackage,
  verifyRuntimeAttestation,
  writeRuntimeAttestation
} from "./acpx-runtime-preflight.mjs";

export const MAX_RUNTIME_PREFLIGHT_INPUT_BYTES = 8192;
// Structured plugin information and config drafts are operator artifacts;
// both share the supervisor's one-mebibyte private-file ceiling.
export const MAX_PLUGIN_INFO_BYTES = 1024 * 1024;
export const MAX_CONFIG_DRAFT_BYTES = 1024 * 1024;

// Accept exactly one private input-file path behind --input, mirroring the
// other operator CLIs in this skill.
export function parseRuntimePreflightCli(argv) {
  if (argv.length !== 2 || argv[0] !== "--input") {
    fail("usage");
  }
  return argv[1];
}

// Same owner-private file contract as the supervisor's config and prompt
// files: absolute path, no symlink, a regular file with no group or world
// permissions on POSIX, bounded size, valid JSON. Failure codes never carry
// the path.
function readOwnerPrivateJson(filePath, maxBytes, codes) {
  if (typeof filePath !== "string" || filePath.length === 0 || !path.isAbsolute(filePath)) {
    fail(codes.file);
  }
  const normalized = path.normalize(filePath);
  let stat;
  try {
    stat = fs.lstatSync(normalized);
  } catch (error) {
    fail(error && error.code === "ENOENT" ? codes.missing : codes.file);
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0) ||
    stat.size < 1 ||
    stat.size > maxBytes
  ) {
    fail(codes.file);
  }
  let raw;
  try {
    raw = fs.readFileSync(normalized, "utf8");
  } catch {
    fail(codes.file);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(codes.json);
  }
  return parsed;
}

export function readRuntimePreflightInput(inputPath) {
  const parsed = readOwnerPrivateJson(inputPath, MAX_RUNTIME_PREFLIGHT_INPUT_BYTES, {
    file: "invalid_input_file",
    missing: "invalid_input_file_missing",
    json: "invalid_input_json"
  });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("invalid_preflight_input");
  }
  if (parsed.schemaVersion !== ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION) {
    fail("invalid_preflight_schema_version");
  }
  return parsed;
}

function assertExactKeys(input, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(input);
  if (!required.every((key) => keys.includes(key)) || keys.some((key) => !allowed.has(key))) {
    fail("invalid_preflight_input");
  }
}

function requireAbsolutePath(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || !path.isAbsolute(value)) {
    fail(code);
  }
  return path.normalize(value);
}

async function runAttest(input, dependencies) {
  assertExactKeys(input, ["schemaVersion", "action", "pluginInfoFile", "attestationFile"]);
  const pluginInfoFile = requireAbsolutePath(
    input.pluginInfoFile,
    "invalid_preflight_plugin_info_file"
  );
  const attestationFile = requireAbsolutePath(
    input.attestationFile,
    "invalid_preflight_attestation_file"
  );
  const pluginInfo = readOwnerPrivateJson(pluginInfoFile, MAX_PLUGIN_INFO_BYTES, {
    file: "plugin_info_file_invalid",
    missing: "plugin_info_file_invalid",
    json: "plugin_info_file_json"
  });
  const runtimeModule = selectAcpxRuntimeModule(pluginInfo);
  const inspection = await validateAcpxRuntimePackage(runtimeModule, {
    importModule: dependencies.importModule
  });
  const attestation = createRuntimeAttestation(inspection, dependencies.now());
  writeRuntimeAttestation(attestationFile, attestation);
  return {
    schemaVersion: ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION,
    type: "runtime_preflight_result",
    action: "attest",
    status: "runtime_attested",
    runtimeVersion: attestation.runtimeVersion
  };
}

function runAssemble(input, dependencies) {
  assertExactKeys(
    input,
    ["schemaVersion", "action", "attestationFile", "configFile", "outputFile"],
    ["maxAttestationAgeMs"]
  );
  const attestationFile = requireAbsolutePath(
    input.attestationFile,
    "invalid_preflight_attestation_file"
  );
  const configFile = requireAbsolutePath(input.configFile, "invalid_preflight_config_file");
  const outputFile = requireAbsolutePath(input.outputFile, "invalid_preflight_output_file");
  if (
    input.maxAttestationAgeMs !== undefined &&
    !isBoundedAttestationAge(input.maxAttestationAgeMs)
  ) {
    fail("invalid_preflight_max_age");
  }

  const attestation = readRuntimeAttestation(attestationFile);
  verifyRuntimeAttestation(attestation, {
    nowMs: dependencies.now(),
    maxAgeMs: input.maxAttestationAgeMs
  });
  const draftConfig = readOwnerPrivateJson(configFile, MAX_CONFIG_DRAFT_BYTES, {
    file: "config_draft_file_invalid",
    missing: "config_draft_file_invalid",
    json: "config_draft_file_json"
  });
  const assembled = assembleSupervisorConfig(draftConfig, attestation);
  try {
    fs.writeFileSync(outputFile, JSON.stringify(assembled, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
  } catch (error) {
    fail(
      error && error.code === "EEXIST"
        ? "config_output_exists"
        : "config_output_write_failed"
    );
  }
  return {
    schemaVersion: ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION,
    type: "runtime_preflight_result",
    action: "assemble",
    status: "config_assembled",
    runtimeVersion: attestation.runtimeVersion
  };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const now = dependencies.now || Date.now;
  const writeResult = dependencies.writeResult || ((event) => {
    process.stdout.write(JSON.stringify(event) + "\n");
  });
  const writeEvent = dependencies.writeEvent || ((event) => {
    process.stderr.write(JSON.stringify(event) + "\n");
  });
  try {
    const input = readRuntimePreflightInput(parseRuntimePreflightCli(argv));
    let result;
    if (input.action === "attest") {
      result = await runAttest(input, { now, importModule: dependencies.importModule });
    } else if (input.action === "assemble") {
      result = runAssemble(input, { now });
    } else {
      fail("invalid_preflight_action");
    }
    writeResult(result);
    return EXIT_CODES.completed;
  } catch (error) {
    // Bounded stable code only; anything without a safe code collapses to
    // the generic fallback.
    writeEvent({
      schemaVersion: ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION,
      type: "runtime_preflight_error",
      code: safeDiagnosticCode(error && error.code, "runtime_preflight_failure")
    });
    return EXIT_CODES.invalidConfig;
  }
}

if (isCliEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
