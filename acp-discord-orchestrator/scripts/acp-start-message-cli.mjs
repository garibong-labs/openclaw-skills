// Production CLI for the canonical ACP round-start message builder.
//
// Reads exactly one absolute owner-private JSON input file and writes only
// the rendered 13-line public start message to stdout:
//
//   node acp-start-message-cli.mjs --input /absolute/private/start-message.json
//
// The input carries the structured fields of buildAcpStartMessage (agent,
// optional model, roundIndex, repository, branch, timeKst, scope,
// externalAction). The round title and the public harness label are derived
// by the builder — an input that tries to supply them is rejected — so an
// operator can never hand-assemble a drifted correction-round template.
//
// Fail-closed and evidence-minimal like the supervisor CLI: every failure
// emits exactly one start_message_builder_error event with a bounded stable
// code on stderr and exits with the invalid-config code. Neither the input
// path nor any rejected input text is ever echoed. The CLI holds no chat
// credentials and makes no network call; sending the rendered message stays
// the operator's separate step.

import { buildAcpStartMessage } from "./acp-reporting-contract.mjs";
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

// Generous bound for a file that describes one 1400-character message.
export const MAX_START_MESSAGE_INPUT_BYTES = 65536;

// Accept exactly one private input-file path behind --input, mirroring the
// supervisor's own single --config argument shape.
export function parseStartMessageCli(argv) {
  return parsePrivateJsonInputCli(argv, fail);
}

// Same owner-private file contract as the supervisor's config and prompt
// files: absolute path, no symlink, a regular file with no group or world
// permissions on POSIX, bounded size, valid JSON. Failure codes never carry
// the path.
export function readStartMessageInput(inputPath) {
  return readPrivateJsonInput(inputPath, {
    maxBytes: MAX_START_MESSAGE_INPUT_BYTES,
    fail
  });
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const writeMessage = dependencies.writeMessage || ((text) => {
    process.stdout.write(text);
  });
  const writeEvent = dependencies.writeEvent || ((event) => {
    process.stderr.write(JSON.stringify(event) + "\n");
  });
  try {
    const input = readStartMessageInput(parseStartMessageCli(argv));
    const startMessage = buildAcpStartMessage(input);
    writeMessage(startMessage + "\n");
    return EXIT_CODES.completed;
  } catch (error) {
    // Bounded stable code only — AcpReportingContractError codes pass
    // through unchanged; anything without a safe code collapses to the
    // generic fallback.
    writeEvent({
      schemaVersion: SCHEMA_VERSION,
      type: "start_message_builder_error",
      code: safeDiagnosticCode(error && error.code, "start_message_builder_failure")
    });
    return EXIT_CODES.invalidConfig;
  }
}

if (isCliEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
