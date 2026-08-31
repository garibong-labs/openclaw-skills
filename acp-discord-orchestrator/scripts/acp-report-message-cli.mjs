// Canonical intermediate/terminal ACP report-message builder CLI.
// It reads one owner-private structured JSON document and writes only the
// validated public message. It has no Discord credentials and performs no
// delivery; publication receipts remain caller attestations at the transport.

import {
  buildAcpIntermediateReport,
  buildAcpTerminalReport
} from "./acp-reporting-contract.mjs";
import {
  parsePrivateJsonInputCli,
  readPrivateJsonInput
} from "./acp-private-json-input.mjs";
import {
  EXIT_CODES,
  SCHEMA_VERSION,
  fail,
  isCliEntry,
  safeDiagnosticCode
} from "./acpx-foreground-supervisor.mjs";

export const MAX_REPORT_MESSAGE_INPUT_BYTES = 65536;

export function readReportMessageInput(inputPath, dependencies = {}) {
  const parsed = readPrivateJsonInput(inputPath, {
    maxBytes: MAX_REPORT_MESSAGE_INPUT_BYTES,
    fail,
    fileSystem: dependencies.fileSystem
  });
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
    const input = readReportMessageInput(parsePrivateJsonInputCli(argv, fail), dependencies);
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
