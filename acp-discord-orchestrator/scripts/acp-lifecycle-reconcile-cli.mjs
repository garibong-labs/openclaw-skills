import fs from "node:fs";
import path from "node:path";

import {
  ACP_LIFECYCLE_LEDGER_SCHEMA_VERSION,
  reconcileLifecycleLedger
} from "./acp-lifecycle-ledger.mjs";
import { isCliEntry, safeCode } from "./acp-private-json-input.mjs";

const INVALID_CONFIG_EXIT = 64;
const MAX_INPUT_BYTES = 8192;

function cliFail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--input") {
    cliFail("usage");
  }
  const inputFile = argv[1];
  if (typeof inputFile !== "string" || !path.isAbsolute(inputFile)) {
    cliFail("invalid_reconcile_input_file");
  }
  return path.normalize(inputFile);
}

function readPrivateInput(inputFile) {
  let stat;
  try {
    stat = fs.lstatSync(inputFile);
  } catch (error) {
    cliFail(error && error.code === "ENOENT"
      ? "reconcile_input_missing"
      : "reconcile_input_unreadable");
  }
  if (stat.isSymbolicLink()) {
    cliFail("reconcile_input_symlink");
  }
  if (!stat.isFile()) {
    cliFail("reconcile_input_not_regular");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    cliFail("reconcile_input_permissions");
  }
  if (stat.size < 1 || stat.size > MAX_INPUT_BYTES) {
    cliFail("reconcile_input_size");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  } catch {
    cliFail("reconcile_input_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    cliFail("reconcile_input_shape");
  }
  const keys = Object.keys(parsed);
  const required = ["ledgerFile", "processHandle", "outcome"];
  const allowed = new Set([...required, "exitCode"]);
  if (
    !required.every((key) => keys.includes(key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    cliFail("reconcile_input_shape");
  }
  if (parsed.outcome === "exited") {
    if (!keys.includes("exitCode")) {
      cliFail("reconcile_input_shape");
    }
    if (parsed.processHandle !== null && typeof parsed.processHandle !== "string") {
      cliFail("reconcile_input_shape");
    }
  } else if (parsed.outcome === "tracking_lost") {
    if (keys.includes("exitCode")) {
      cliFail("reconcile_input_shape");
    }
    if (typeof parsed.processHandle !== "string") {
      cliFail("reconcile_input_shape");
    }
  } else {
    cliFail("lifecycle_outcome_invalid");
  }
  return parsed;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const inputFile = parseArgs(argv);
    const input = readPrivateInput(inputFile);
    const document = reconcileLifecycleLedger(input);
    process.stdout.write(JSON.stringify({
      schemaVersion: ACP_LIFECYCLE_LEDGER_SCHEMA_VERSION,
      type: "lifecycle_reconciled",
      status: document.state
    }) + "\n");
    return 0;
  } catch (error) {
    process.stderr.write(JSON.stringify({
      schemaVersion: ACP_LIFECYCLE_LEDGER_SCHEMA_VERSION,
      type: "lifecycle_reconcile_error",
      code: safeCode(error && error.code, "lifecycle_reconcile_failed")
    }) + "\n");
    return INVALID_CONFIG_EXIT;
  }
}

if (isCliEntry(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
