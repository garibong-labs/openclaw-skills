// Canonical machine-enforced runtime-module preflight for the ACPX
// supervisor. The operator saves the structured output of
// `openclaw plugins info acpx --json` to an owner-private file; this module
// uniquely selects the dependency named exactly "acpx", validates the
// resolved package (name, ACPX 0.11.2-or-newer version, dist/runtime.js
// entry, and the authoritative capability exports), and binds the result
// into an owner-private attestation. Config assembly consumes only that
// attestation, so a caller never hand-copies or chooses `runtimeModule` and
// the active plugin package root (`@openclaw/acpx`) can never be selected.
//
// Fail-closed and evidence-minimal like the supervisor: every failure is one
// bounded stable code; no rejected path, plugin-info payload, or free text is
// ever echoed, hashed into events, or length-disclosed.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fail, validateRuntimeModuleExports } from "./acpx-foreground-supervisor.mjs";

export const ACPX_RUNTIME_PREFLIGHT_SCHEMA_VERSION = "acpx-runtime-preflight.v1";
export const ACPX_RUNTIME_ATTESTATION_SCHEMA_VERSION = "acpx-runtime-attestation.v1";
// The runtime package is the dependency whose name is exactly this value —
// never the active plugin package root (`@openclaw/acpx`), whose manifest
// name differs and is rejected by the package-name gate below even when the
// plugin root cannot be derived from the structured input.
export const ACPX_RUNTIME_DEPENDENCY_NAME = "acpx";
export const ACPX_MINIMUM_RUNTIME_VERSION = "0.11.2";
export const DEFAULT_MAX_ATTESTATION_AGE_MS = 600000;
const MIN_MAX_ATTESTATION_AGE_MS = 1000;
const MAX_MAX_ATTESTATION_AGE_MS = 3600000;
// Attestation issue instants come from the same host clock, so only a small
// forward allowance is tolerated (mirrors the start-receipt future skew).
const ATTESTATION_FUTURE_SKEW_MS = 1000;
const MAX_PLUGIN_DEPENDENCIES = 1024;
const MAX_PATH_LENGTH = 4096;
const MAX_ATTESTATION_BYTES = 8192;
// Top-level plugin-info keys that may carry the active plugin's own package
// root. When one is present, a dependency resolving to that exact root is
// rejected at selection time; the package-name gate stays authoritative when
// none is present.
const PLUGIN_ROOT_KEYS = Object.freeze(["path", "root", "packageRoot"]);
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ATTESTATION_KEYS = Object.freeze([
  "schemaVersion",
  "runtimeModule",
  "runtimeVersion",
  "packageJsonSha256",
  "runtimeEntrySha256",
  "issuedAtMs"
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBoundedAbsolutePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !value.includes("\0") &&
    path.isAbsolute(value)
  );
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function compareReleaseVersions(left, right) {
  const leftParts = RELEASE_VERSION.exec(left).slice(1).map(Number);
  const rightParts = RELEASE_VERSION.exec(right).slice(1).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

export function isBoundedAttestationAge(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_MAX_ATTESTATION_AGE_MS &&
    value <= MAX_MAX_ATTESTATION_AGE_MS
  );
}

// Pure selection over the owner-private structured plugin information. The
// only accepted source of `runtimeModule` is the absolute `resolvedPath` of
// the dependency whose name is exactly "acpx": a missing exact match, more
// than one exact match, a relative or malformed path, and a path equal to a
// derivable active-plugin package root all fail closed.
export function selectAcpxRuntimeModule(pluginInfo) {
  if (!isPlainObject(pluginInfo)) {
    fail("plugin_info_invalid");
  }
  const dependencies = pluginInfo.dependencies;
  if (
    !Array.isArray(dependencies) ||
    dependencies.length === 0 ||
    dependencies.length > MAX_PLUGIN_DEPENDENCIES
  ) {
    fail("plugin_info_dependencies_invalid");
  }
  const matches = [];
  for (const dependency of dependencies) {
    if (!isPlainObject(dependency) || typeof dependency.name !== "string") {
      fail("plugin_info_dependencies_invalid");
    }
    if (dependency.name === ACPX_RUNTIME_DEPENDENCY_NAME) {
      matches.push(dependency);
    }
  }
  if (matches.length === 0) {
    fail("plugin_info_dependency_missing");
  }
  if (matches.length > 1) {
    fail("plugin_info_dependency_duplicate");
  }
  const resolvedPath = matches[0].resolvedPath;
  if (!isBoundedAbsolutePath(resolvedPath)) {
    fail("plugin_info_resolved_path_invalid");
  }
  const normalized = path.normalize(resolvedPath);
  for (const key of PLUGIN_ROOT_KEYS) {
    const candidate = pluginInfo[key];
    if (
      isBoundedAbsolutePath(candidate) &&
      path.normalize(candidate) === normalized
    ) {
      fail("plugin_info_plugin_root_selected");
    }
  }
  return normalized;
}

// Static (import-free) package inspection shared by attestation and
// re-verification: real non-symlink package root, manifest named exactly
// "acpx" with a plain release version of at least the minimum, and a real
// non-symlink dist/runtime.js entry. Returns the content digests that bind
// the attestation to these exact bytes.
export function inspectAcpxRuntimePackage(packageRoot) {
  if (!isBoundedAbsolutePath(packageRoot)) {
    fail("runtime_package_root_missing");
  }
  const normalizedRoot = path.normalize(packageRoot);
  let rootStat;
  try {
    rootStat = fs.lstatSync(normalizedRoot);
  } catch {
    fail("runtime_package_root_missing");
  }
  if (rootStat.isSymbolicLink()) {
    fail("runtime_package_root_symlink");
  }
  if (!rootStat.isDirectory()) {
    fail("runtime_package_root_not_directory");
  }

  let packageJsonBytes;
  try {
    packageJsonBytes = fs.readFileSync(path.join(normalizedRoot, "package.json"));
  } catch {
    fail("runtime_package_json_missing");
  }
  let manifest;
  try {
    manifest = JSON.parse(packageJsonBytes.toString("utf8"));
  } catch {
    fail("runtime_package_json_invalid");
  }
  if (!isPlainObject(manifest)) {
    fail("runtime_package_json_invalid");
  }
  if (manifest.name !== ACPX_RUNTIME_DEPENDENCY_NAME) {
    fail("runtime_package_name_invalid");
  }
  const version = manifest.version;
  if (typeof version !== "string" || !RELEASE_VERSION.test(version)) {
    fail("runtime_package_version_invalid");
  }
  if (compareReleaseVersions(version, ACPX_MINIMUM_RUNTIME_VERSION) < 0) {
    fail("runtime_package_version_unsupported");
  }

  const entryPath = path.join(normalizedRoot, "dist", "runtime.js");
  let entryStat;
  try {
    entryStat = fs.lstatSync(entryPath);
  } catch {
    fail("runtime_entry_missing");
  }
  if (entryStat.isSymbolicLink()) {
    fail("runtime_entry_symlink");
  }
  if (!entryStat.isFile()) {
    fail("runtime_entry_not_regular");
  }
  let entryBytes;
  try {
    entryBytes = fs.readFileSync(entryPath);
  } catch {
    fail("runtime_entry_unreadable");
  }

  return {
    runtimeModule: normalizedRoot,
    entryPath,
    runtimeVersion: version,
    packageJsonSha256: sha256Hex(packageJsonBytes),
    runtimeEntrySha256: sha256Hex(entryBytes)
  };
}

// Full pre-start validation of the selected package. The version gate is
// necessary but never sufficient: the dist/runtime.js entry is imported and
// the supervisor's own capability check (createAcpRuntime,
// createRuntimeStore, createAgentRegistry) remains authoritative, so a
// package that names a new-enough version without the turn capabilities
// still fails closed before any ACP start boundary.
export async function validateAcpxRuntimePackage(packageRoot, options = {}) {
  const importModule = options.importModule || ((href) => import(href));
  const inspection = inspectAcpxRuntimePackage(packageRoot);
  let imported;
  try {
    imported = await importModule(pathToFileURL(inspection.entryPath).href);
  } catch {
    fail("runtime_entry_unloadable");
  }
  validateRuntimeModuleExports(imported);
  return inspection;
}

export function createRuntimeAttestation(inspection, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    fail("runtime_attestation_invalid");
  }
  return {
    schemaVersion: ACPX_RUNTIME_ATTESTATION_SCHEMA_VERSION,
    runtimeModule: inspection.runtimeModule,
    runtimeVersion: inspection.runtimeVersion,
    packageJsonSha256: inspection.packageJsonSha256,
    runtimeEntrySha256: inspection.runtimeEntrySha256,
    issuedAtMs: nowMs
  };
}

// The attestation is an owner-private artifact: created exactly once per
// path (no overwrite) with owner-only permissions.
export function writeRuntimeAttestation(attestationFile, attestation) {
  try {
    fs.writeFileSync(attestationFile, JSON.stringify(attestation, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
  } catch (error) {
    fail(
      error && error.code === "EEXIST"
        ? "runtime_attestation_exists"
        : "runtime_attestation_write_failed"
    );
  }
}

// An absent attestation keeps its own code so a preparation path that skipped
// the attest step is distinguishable; every other filesystem, permission,
// JSON, or shape problem is one bounded invalid class.
export function readRuntimeAttestation(attestationFile) {
  if (!isBoundedAbsolutePath(attestationFile)) {
    fail("runtime_attestation_invalid");
  }
  let stat;
  try {
    stat = fs.lstatSync(attestationFile);
  } catch (error) {
    fail(
      error && error.code === "ENOENT"
        ? "runtime_attestation_missing"
        : "runtime_attestation_invalid"
    );
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0) ||
    stat.size < 1 ||
    stat.size > MAX_ATTESTATION_BYTES
  ) {
    fail("runtime_attestation_invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(attestationFile, "utf8"));
  } catch {
    fail("runtime_attestation_invalid");
  }
  if (!isPlainObject(parsed)) {
    fail("runtime_attestation_invalid");
  }
  const keys = Object.keys(parsed);
  if (
    keys.length !== ATTESTATION_KEYS.length ||
    !ATTESTATION_KEYS.every((key) => keys.includes(key)) ||
    parsed.schemaVersion !== ACPX_RUNTIME_ATTESTATION_SCHEMA_VERSION ||
    !isBoundedAbsolutePath(parsed.runtimeModule) ||
    typeof parsed.runtimeVersion !== "string" ||
    !RELEASE_VERSION.test(parsed.runtimeVersion) ||
    typeof parsed.packageJsonSha256 !== "string" ||
    !SHA256_HEX.test(parsed.packageJsonSha256) ||
    typeof parsed.runtimeEntrySha256 !== "string" ||
    !SHA256_HEX.test(parsed.runtimeEntrySha256) ||
    !Number.isSafeInteger(parsed.issuedAtMs) ||
    parsed.issuedAtMs < 0
  ) {
    fail("runtime_attestation_invalid");
  }
  return parsed;
}

// Re-verifies a previously issued attestation at consumption time: bounded
// freshness against the host clock, then a fresh static inspection of the
// attested package whose digests and version must still match byte-for-byte.
// A package that changed, moved, or degraded after attestation therefore
// fails closed instead of reaching the supervisor config.
export function verifyRuntimeAttestation(attestation, options = {}) {
  const nowMs = options.nowMs;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    fail("runtime_attestation_invalid");
  }
  const maxAgeMs = options.maxAgeMs === undefined
    ? DEFAULT_MAX_ATTESTATION_AGE_MS
    : options.maxAgeMs;
  if (!isBoundedAttestationAge(maxAgeMs)) {
    fail("invalid_preflight_max_age");
  }
  const ageMs = nowMs - attestation.issuedAtMs;
  if (ageMs < -ATTESTATION_FUTURE_SKEW_MS) {
    fail("runtime_attestation_future");
  }
  if (ageMs > maxAgeMs) {
    fail("runtime_attestation_stale");
  }
  const inspection = inspectAcpxRuntimePackage(attestation.runtimeModule);
  if (
    inspection.runtimeModule !== attestation.runtimeModule ||
    inspection.runtimeVersion !== attestation.runtimeVersion ||
    inspection.packageJsonSha256 !== attestation.packageJsonSha256 ||
    inspection.runtimeEntrySha256 !== attestation.runtimeEntrySha256
  ) {
    fail("runtime_attestation_mismatch");
  }
  return inspection;
}

// Config assembly is deliberately narrow: it supplies the attested
// `runtimeModule` to an otherwise caller-prepared draft and changes nothing
// else. Any pre-set draft value — including the template sentinel — is
// replaced by the validated path, so the caller never chooses the module.
// The supervisor's own config loader remains the authoritative validator of
// the assembled config.
export function assembleSupervisorConfig(draftConfig, attestation) {
  if (!isPlainObject(draftConfig)) {
    fail("invalid_config_draft");
  }
  return { ...draftConfig, runtimeModule: attestation.runtimeModule };
}
