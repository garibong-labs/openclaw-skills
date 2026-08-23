// Canonical Claude launcher for the direct ACPX foreground supervisor.
//
// Validates the private config's Claude auth declaration, the parent
// environment, and the private setup-token env file, then replaces itself
// with the supervisor process via POSIX process.execve so exactly one
// tracked foreground process exists for the whole run:
//
//   node --env-file=<auth.envFile> acpx-foreground-supervisor.mjs --config <config>
//
// Requires Node.js 22.15 or newer for process.execve and fails closed on
// runtimes or platforms without it. The token value is never read into argv,
// events, error text, or logs; only Node's own --env-file startup parsing
// loads it into the replaced process's environment.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CLAUDE_AGENT,
  CLAUDE_FORBIDDEN_ENV,
  CLAUDE_OAUTH_TOKEN_ENV,
  EXIT_CODES,
  SCHEMA_VERSION,
  loadSupervisorConfig,
  safeDiagnosticCode,
  validateClaudeAuthEnvFile
} from "./acpx-foreground-supervisor.mjs";

const SUPERVISOR_PATH = fileURLToPath(
  new URL("./acpx-foreground-supervisor.mjs", import.meta.url)
);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parseLauncherCli(argv) {
  if (argv.length !== 2 || argv[0] !== "--config") {
    fail("usage");
  }
  return argv[1];
}

// The launcher refuses to run in an environment that already carries Claude
// credential state. Nothing is silently unset: a pre-existing setup token —
// even an empty one — or a non-empty competing credential selector proves the
// parent environment is not the clean baseline this launcher certifies.
export function runLauncherEnvironmentPreflight(env) {
  if (Object.prototype.hasOwnProperty.call(env, CLAUDE_OAUTH_TOKEN_ENV)) {
    fail("claude_oauth_token_preexisting");
  }
  for (const name of CLAUDE_FORBIDDEN_ENV) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      fail("claude_competing_credential:" + name);
    }
  }
}

// Deterministic execve argv contract: same Node binary, exactly one Node
// option injecting the declared env file, then the supervisor and its single
// --config value. The token value never appears in argv.
export function buildSupervisorExecution(configPath, envFilePath, options = {}) {
  const execPath = options.execPath || process.execPath;
  const supervisorPath = options.supervisorPath || SUPERVISOR_PATH;
  return {
    file: execPath,
    args: [
      execPath,
      "--env-file=" + envFilePath,
      supervisorPath,
      "--config",
      configPath
    ]
  };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const env = dependencies.env || process.env;
  const writeEvent = dependencies.writeEvent || ((event) => {
    process.stdout.write(JSON.stringify(event) + "\n");
  });
  const emitError = (code) => {
    writeEvent({ schemaVersion: SCHEMA_VERSION, type: "launcher_error", code });
  };

  let configPath;
  let config;
  try {
    configPath = path.normalize(parseLauncherCli(argv));
    config = loadSupervisorConfig(configPath);
    if (config.agent !== CLAUDE_AGENT) {
      fail("launcher_agent_not_claude");
    }
  } catch (error) {
    emitError(safeDiagnosticCode(error && error.code, "invalid_config"));
    return EXIT_CODES.invalidConfig;
  }

  try {
    runLauncherEnvironmentPreflight(env);
    validateClaudeAuthEnvFile(config.auth.envFile);

    const execve = "execve" in dependencies
      ? dependencies.execve
      : typeof process.execve === "function"
        ? process.execve.bind(process)
        : undefined;
    if (typeof execve !== "function") {
      fail("execve_unsupported");
    }

    const execution = buildSupervisorExecution(
      configPath,
      config.auth.envFile,
      dependencies
    );
    execve(execution.file, execution.args, env);
    // A successful execve never returns: the supervisor has replaced this
    // process image under the same PID. Reaching this line is a failure.
    fail("execve_returned");
  } catch (error) {
    emitError(safeDiagnosticCode(error && error.code, "launcher_failure"));
    return EXIT_CODES.supervisorError;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
