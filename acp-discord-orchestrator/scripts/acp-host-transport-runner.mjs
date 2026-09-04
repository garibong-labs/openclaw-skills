import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { loadHostTransportRecord } from "./acp-host-transport.mjs";
import { isCliEntry } from "./acp-private-json-input.mjs";

function runnerFail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--transport" || !path.isAbsolute(argv[1])) {
    runnerFail("host_transport_runner_usage");
  }
  return path.normalize(argv[1]);
}

function readEnvironment(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    runnerFail("host_transport_environment_invalid");
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  ) {
    runnerFail("host_transport_environment_invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    runnerFail("host_transport_environment_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    runnerFail("host_transport_environment_invalid");
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || typeof value !== "string") {
      runnerFail("host_transport_environment_invalid");
    }
  }
  return parsed;
}

function openPrivateOutput(filePath) {
  return fs.openSync(filePath, "wx", 0o600);
}

function writeExitFile(filePath, code) {
  fs.writeFileSync(filePath, `${code}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
}

export async function main(argv = process.argv.slice(2)) {
  let eventsFd;
  let stderrFd;
  let record;
  let exitWritten = false;
  try {
    const transportFile = parseArgs(argv);
    ({ record } = loadHostTransportRecord(transportFile));
    const environment = readEnvironment(record.environmentFile);
    eventsFd = openPrivateOutput(record.eventsFile);
    stderrFd = openPrivateOutput(record.stderrFile);
    const child = spawn(process.execPath, [
      record.entryFile,
      "--config",
      record.configFile
    ], {
      stdio: ["inherit", eventsFd, stderrFd],
      env: environment
    });
    // The PTY sends Ctrl-C to the foreground process group. Keep the runner
    // alive long enough to record the supervisor's mapped cancellation exit;
    // the child receives the same signal and owns cancellation semantics.
    const ignoreSigint = () => {};
    process.on("SIGINT", ignoreSigint);
    try {
      fs.unlinkSync(record.environmentFile);
    } catch {
      // The child already owns a copied environment; residue is private and
      // can be cleaned during normal evidence cleanup.
    }
    const outcome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    process.off("SIGINT", ignoreSigint);
    const code = [0, 20, 21, 22, 64].includes(outcome.code) ? outcome.code : 22;
    writeExitFile(record.exitFile, code);
    exitWritten = true;
    return code;
  } catch {
    if (record && !exitWritten && !fs.existsSync(record.exitFile)) {
      try {
        writeExitFile(record.exitFile, 22);
      } catch {
        // The transport status remains unavailable when even the private exit
        // record cannot be written; never invent terminal evidence.
      }
    }
    return 22;
  } finally {
    if (Number.isInteger(eventsFd)) {
      fs.closeSync(eventsFd);
    }
    if (Number.isInteger(stderrFd)) {
      fs.closeSync(stderrFd);
    }
  }
}

if (isCliEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
