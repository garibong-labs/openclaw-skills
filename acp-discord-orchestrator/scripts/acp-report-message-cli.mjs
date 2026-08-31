// Canonical intermediate/terminal ACP report-message builder CLI.
// It reads one owner-private structured JSON document and writes only the
// validated public message. It has no Discord credentials and performs no
// delivery; publication receipts remain caller attestations at the transport.

import fs from "node:fs";
import path from "node:path";

import {
  buildAcpIntermediateReport,
  buildAcpTerminalReport
} from "./acp-reporting-contract.mjs";
import {
  EXIT_CODES,
  SCHEMA_VERSION,
  fail,
  isCliEntry,
  safeDiagnosticCode
} from "./acpx-foreground-supervisor.mjs";

export const MAX_REPORT_MESSAGE_INPUT_BYTES = 65536;

function readInput(argv) {
  if (argv.length !== 2 || argv[0] !== "--input") {
    fail("usage");
  }
  const inputPath = argv[1];
  if (typeof inputPath !== "string" || !path.isAbsolute(inputPath)) {
    fail("invalid_input_path_not_absolute");
  }
  let stat;
  try {
    stat = fs.lstatSync(path.normalize(inputPath));
  } catch (error) {
    fail(error && error.code === "ENOENT" ? "invalid_input_file_missing" : "invalid_input_file_unreadable");
  }
  if (stat.isSymbolicLink()) fail("invalid_input_file_symlink");
  if (!stat.isFile()) fail("invalid_input_file_not_regular");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    fail("invalid_input_file_permissions");
  }
  if (stat.size < 1 || stat.size > MAX_REPORT_MESSAGE_INPUT_BYTES) {
    fail("invalid_input_file_too_large");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  } catch {
    fail("invalid_input_json");
  }
  if (
    !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
    Object.keys(parsed).length !== 2 ||
    !Object.hasOwn(parsed, "kind") || !Object.hasOwn(parsed, "report")
  ) {
    fail("invalid_reporting_context");
  }
  return parsed;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const writeMessage = dependencies.writeMessage ?? ((value) => process.stdout.write(value));
  const writeEvent = dependencies.writeEvent ?? ((value) => process.stderr.write(JSON.stringify(value) + "\n"));
  try {
    const input = readInput(argv);
    const message = input.kind === "intermediate"
      ? buildAcpIntermediateReport(input.report)
      : input.kind === "terminal"
        ? buildAcpTerminalReport(input.report)
        : fail("invalid_reporting_context");
    writeMessage(message + "\n");
    return EXIT_CODES.completed;
  } catch (error) {
    writeEvent({
      schemaVersion: SCHEMA_VERSION,
      type: "report_message_builder_error",
      code: safeDiagnosticCode(error && error.code, "report_message_builder_failure")
    });
    return EXIT_CODES.invalidConfig;
  }
}

if (isCliEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
