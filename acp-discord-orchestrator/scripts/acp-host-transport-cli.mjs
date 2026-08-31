import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACP_HOST_TRANSPORT_SCHEMA_VERSION,
  acknowledgeHostTransportReport,
  activateHostTransport,
  cancelHostTransport,
  prepareHostTransport,
  probeHostTransport,
  reconcileHostTransport,
  statusHostTransport
} from "./acp-host-transport.mjs";

const INVALID_INPUT_EXIT = 64;
const TRANSPORT_ERROR_EXIT = 22;
const MAX_INPUT_BYTES = 8192;

function cliFail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function safeCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
    ? value
    : "host_transport_failed";
}

function exitCodeFor(code) {
  return code === "usage" ||
    code.startsWith("invalid_") ||
    code.startsWith("host_transport_input_") ||
    code.startsWith("host_transport_config_file") ||
    code === "host_transport_action_invalid" ||
    code === "host_transport_handle_invalid" ||
    code === "host_transport_handle_mismatch" ||
    code === "host_transport_cursor_invalid" ||
    code.startsWith("host_transport_service_cursor_") ||
    code.startsWith("host_transport_report_ack_") ||
    code.startsWith("host_transport_report_receipt_")
    ? INVALID_INPUT_EXIT
    : TRANSPORT_ERROR_EXIT;
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--input" || !path.isAbsolute(argv[1])) {
    cliFail("usage");
  }
  return path.normalize(argv[1]);
}

function readPrivateInput(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    cliFail(error && error.code === "ENOENT"
      ? "host_transport_input_missing"
      : "host_transport_input_unreadable");
  }
  if (stat.isSymbolicLink()) {
    cliFail("host_transport_input_symlink");
  }
  if (!stat.isFile()) {
    cliFail("host_transport_input_not_regular");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    cliFail("host_transport_input_permissions");
  }
  if (stat.size < 1 || stat.size > MAX_INPUT_BYTES) {
    cliFail("host_transport_input_size");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    cliFail("host_transport_input_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    cliFail("host_transport_input_shape");
  }
  if (parsed.schemaVersion !== ACP_HOST_TRANSPORT_SCHEMA_VERSION) {
    cliFail("host_transport_input_schema");
  }
  return parsed;
}

function assertExactKeys(input, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(input);
  if (!required.every((key) => keys.includes(key)) || keys.some((key) => !allowed.has(key))) {
    cliFail("host_transport_input_shape");
  }
}

async function dispatch(input) {
  const base = ["schemaVersion", "action"];
  if (input.action === "probe") {
    assertExactKeys(input, base);
    return probeHostTransport();
  }
  if (input.action === "prepare") {
    assertExactKeys(input, [...base, "configFile"]);
    return prepareHostTransport(input);
  }
  if (input.action === "activate") {
    assertExactKeys(input, [...base, "transportFile", "processHandle"]);
    return activateHostTransport(input);
  }
  if (input.action === "status") {
    assertExactKeys(input, [...base, "transportFile", "processHandle"], ["afterSequence", "serviceCursorAck"]);
    return statusHostTransport(input);
  }
  if (input.action === "ack-report") {
    assertExactKeys(input, [
      ...base,
      "transportFile",
      "processHandle",
      "reportId",
      "reportKind",
      "cadence",
      "receipt"
    ]);
    return acknowledgeHostTransportReport(input);
  }
  if (input.action === "reconcile") {
    assertExactKeys(input, [...base, "transportFile", "processHandle"]);
    return reconcileHostTransport(input);
  }
  if (input.action === "cancel") {
    assertExactKeys(input, [...base, "transportFile", "processHandle"]);
    return cancelHostTransport(input);
  }
  cliFail("host_transport_action_invalid");
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const inputFile = parseArgs(argv);
    const input = readPrivateInput(inputFile);
    const result = await dispatch(input);
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch (error) {
    const code = safeCode(error && error.code);
    process.stderr.write(JSON.stringify({
      schemaVersion: ACP_HOST_TRANSPORT_SCHEMA_VERSION,
      type: "host_transport_error",
      code
    }) + "\n");
    return exitCodeFor(code);
  }
}

function isCliEntry(argvPath, moduleUrl) {
  if (typeof argvPath !== "string" || argvPath.length === 0) {
    return false;
  }
  try {
    return fs.realpathSync(path.resolve(argvPath)) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isCliEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
