// Canonical Claude launcher for the direct ACPX foreground supervisor.
//
// Validates the private config's Claude auth declaration, the parent
// environment, and the private setup-token env file, then replaces itself
// with the supervisor process via POSIX process.execve so exactly one
// tracked foreground process exists for the whole run:
//
//   node --env-file=<auth.envFile> acpx-foreground-supervisor.mjs --config <config>
//
// Requires a Node.js runtime with process.execve (22.15+ in the 22.x line,
// 23.11+ in the 23.x line, or any later release line) on a POSIX platform,
// and fails closed with execve_unsupported everywhere else. The token value
// is never read into argv, events, error text, or logs; only Node's own
// --env-file startup parsing loads it into the replaced process's
// environment.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_AGENT,
  CLAUDE_FORBIDDEN_ENV,
  CLAUDE_INJECTION_ENV,
  CLAUDE_OAUTH_TOKEN_ENV,
  EXIT_CODES,
  SCHEMA_VERSION,
  fail,
  isCliEntry,
  loadSupervisorConfig,
  parseConfigCli,
  safeDiagnosticCode,
  validateClaudeAuthEnvFile
} from "./acpx-foreground-supervisor.mjs";

const SUPERVISOR_PATH = fileURLToPath(
  new URL("./acpx-foreground-supervisor.mjs", import.meta.url)
);

// The launcher refuses to run in an environment that already carries Claude
// credential state or can inject code, endpoints, or configuration into the
// token-bearing supervisor it re-execs into. Nothing is silently unset: a
// pre-existing setup token — even an empty one — or any non-empty competing
// or injection-capable variable proves the parent environment is not the
// clean baseline this launcher certifies, so the operator must remove it
// explicitly before launching.
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
  // NODE_OPTIONS --require/--import, dynamic-linker preloads, module-path
  // redirection, Anthropic endpoint/header/config selectors, and proxy
  // selectors never appear in the supervisor's exec-argv proof, so they are
  // rejected here as parent-environment state.
  for (const name of CLAUDE_INJECTION_ENV) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      fail("claude_env_injection_capable:" + name);
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
  const env = "env" in dependencies ? dependencies.env : process.env;
  const writeEvent = dependencies.writeEvent || ((event) => {
    process.stdout.write(JSON.stringify(event) + "\n");
  });
  const emitError = (code) => {
    writeEvent({ schemaVersion: SCHEMA_VERSION, type: "launcher_error", code });
  };

  let configPath;
  let config;
  try {
    configPath = path.normalize(parseConfigCli(argv));
    config = loadSupervisorConfig(configPath);
    if (config.agent !== CLAUDE_AGENT) {
      fail("launcher_agent_not_claude");
    }
  } catch (error) {
    emitError(safeDiagnosticCode(error && error.code, "invalid_config"));
    return EXIT_CODES.invalidConfig;
  }

  try {
    // Runtime/platform support is checked first so an unsupported host fails
    // with one stable code before any environment or file inspection.
    const execve = "execve" in dependencies
      ? dependencies.execve
      : typeof process.execve === "function"
        ? process.execve.bind(process)
        : undefined;
    if (typeof execve !== "function") {
      fail("execve_unsupported");
    }

    runLauncherEnvironmentPreflight(env);
    validateClaudeAuthEnvFile(config.auth.envFile);

    const execution = buildSupervisorExecution(
      configPath,
      config.auth.envFile,
      dependencies
    );
    // Pre-check the exec targets so a missing or unreadable interpreter or
    // supervisor file maps to a stable code instead of a raw execve error.
    try {
      fs.accessSync(execution.file, fs.constants.X_OK);
    } catch {
      fail("launcher_exec_target_missing");
    }
    try {
      fs.accessSync(execution.args[2], fs.constants.R_OK);
    } catch {
      fail("launcher_supervisor_missing");
    }

    try {
      execve(execution.file, execution.args, env);
    } catch (error) {
      // The real process.execve throws a catchable system error when the
      // image replacement fails (verified: ENOENT/EACCES); after the
      // pre-checks above only exotic failures (E2BIG, ENOMEM, ETXTBSY, a
      // target racing away) reach this mapping.
      fail("execve_failed:" + safeDiagnosticCode(error && error.code, "unknown", 32));
    }
    // A successful execve never returns: the supervisor has replaced this
    // process image under the same PID, and a failing one throws above. This
    // line is reachable only when an injected execve dependency returns
    // instead of replacing or throwing, which is itself a contract failure.
    fail("execve_returned");
  } catch (error) {
    emitError(safeDiagnosticCode(error && error.code, "launcher_failure"));
    return EXIT_CODES.supervisorError;
  }
}

if (isCliEntry(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
