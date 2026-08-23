---
name: "acp-discord-orchestrator"
description: "Track foreground ACPX turns with bounded CLI exit and exact completion."
---

# ACP Discord Orchestrator

Run each agent-started ACP task through one observable direct ACPX turn. Keep the current Discord conversation as the control and reporting surface.

## Required route

Use `scripts/acpx-foreground-supervisor.mjs` for every ACP task started by the calling agent.

For `agent: "claude"`, start the supervisor only through the canonical launcher `scripts/claude-acp-launcher.mjs`. It validates the config's `auth` declaration, the parent environment, and the private setup-token env file, then replaces its own process with the supervisor via POSIX `process.execve` so the run still owns exactly one foreground PID and the supervisor starts as `node --env-file=<auth.envFile> acpx-foreground-supervisor.mjs --config <config>`. The launcher requires Node.js 22.15 or newer for `process.execve` and fails closed without it. A bare direct Claude supervisor launch is a bypass and fails closed with the supervisor policy exit before any runtime loading.

Do not use:

- OpenClaw `sessions_spawn` with `runtime: "acp"`
- `/acp spawn` or another ACP child-thread command
- a new Discord thread created only to host ACP
- an untracked shell, PTY, or native subagent as a substitute for the ACP turn

This policy does not globally disable human-operated OpenClaw ACP commands.

## Prepare the run

1. Confirm Node.js 22.13 or newer, then read [references/runtime-contract.md](references/runtime-contract.md).
2. Read `openclaw plugins info acpx --json`, require the ACPX 0.11.2-or-newer capability contract, and copy the `acpx` dependency's `resolvedPath` into `runtimeModule`.
3. Copy [templates/supervisor-config.json](templates/supervisor-config.json) to a private temporary file.
4. Create a private prompt file and choose a new response-file path.
5. Set the config file and prompt file to owner-only permissions.
6. Set an explicit working directory, ACP agent, model, unique session key, timeout, progress interval, and allowed tool kinds. The template's two-hour `timeoutMs` is an emergency ceiling independent of reporting cadence; set it per run.
7. Announce the run in the current control conversation first, then record that delivery in the required `lifecycle` block: `controlConversationId`, the same conversation ID and the delivered `messageId` under `startReceipt`, and the observed `deliveredAt` instant. The supervisor fails closed before runtime loading, probing, or adapter startup when the receipt is missing, malformed, bound to another conversation, dated ahead of its own clock, or older than `maxStartReceiptAgeMs`. It validates caller-attested receipt metadata only; it holds no chat credentials and makes no network call, so it does not prove the message exists or that its text matches.
8. Optionally declare the run's environment contract with `requiredEnv` and `forbiddenEnv`. The supervisor fails closed before runtime loading, probing, or adapter startup when a required variable is absent or empty or a forbidden variable is non-empty, and it never discloses environment values. This generic gate does not prove how a variable was injected or validate credential sources; for non-Claude agents it is the whole environment contract.
9. For `agent: "claude"`, declare the required auth profile and keep the token in a private env file the config only points to:

   ```json
   "auth": { "kind": "claude-setup-token-env-file", "envFile": "/absolute/private/claude-acp-oauth.env" }
   ```

   The env file holds exactly one line, `CLAUDE_CODE_OAUTH_TOKEN=<token>`, with no quotes, comments, or extra variables. Its parent directory must be a real owner-only (0700) directory and the file a real owner-only (0600) regular file, both owned by the launching user. The Claude credential contract — `CLAUDE_CODE_OAUTH_TOKEN` required, competing `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and `CLAUDE_CODE_USE_FOUNDRY` forbidden — is enforced automatically even when `requiredEnv` and `forbiddenEnv` are empty. Never place the token value in the config, argv, or any argument.
10. Define terminal acceptance checks in the prompt.
11. Resolve this skill's directory and run the run's canonical entry point by absolute path in the foreground. For Claude (Node.js 22.15 or newer):

```bash
node /absolute/path/to/acp-discord-orchestrator/scripts/claude-acp-launcher.mjs --config /absolute/private/run.json
```

The launcher re-execs in place via `process.execve`, so the same PID becomes the supervisor with the env file injected through Node's `--env-file` startup option. For every other agent, run the supervisor directly:

```bash
node /absolute/path/to/acp-discord-orchestrator/scripts/acpx-foreground-supervisor.mjs --config /absolute/private/run.json
```

A bare direct supervisor launch with `agent: "claude"` fails closed before runtime loading. Do not background either process. Consume the newline-delimited JSON events while the process remains attached.

## Own the process without blocking the conversation

Process foreground ownership and host conversation blocking are separate properties. Keep the first without assuming it requires the second.

Foreground ownership belongs to the supervisor process. It runs as exactly one tracked host exec process tree, stays attached, is never detached, daemonized, or backgrounded, and stays owned until it exits.

Conversation blocking belongs to the caller. One host tool call does not have to stay open for the whole ACP turn. Return control at short, bounded host-tool boundaries while the same supervisor process keeps running under host process tracking.

Bound the initial host wait to five seconds unless the process is already terminal. Once the host reports a running process, retain its exact non-empty process handle and use only that handle for the rest of the turn.

Poll the retained handle with bounded waits of 1, 2, 4, and then 5 seconds for every later poll. Five seconds is the cap.

Do not substitute:

- a PID search or broad process monitoring
- transcript or log-file polling
- a long shell sleep
- a long blocking exec or write wait
- a second launch, wrapper, or nested runner around the same run

A returned poll is a host-tool boundary. It is not activity evidence and never terminal evidence.

## Stay responsive at each poll boundary

Treat every returned poll as a servicing point. Before the next poll, read newly steered input from the current conversation and answer it there.

Continue the same ACP round with the retained handle unless the message explicitly cancels or replaces it. Steered input that asks a question, adds context, or requests a status update does not end the turn.

When the message does explicitly cancel or replace the turn, follow the documented cancellation path for the retained handle instead of abandoning it.

## Interpret events

Treat `activity` and `progress` as observational evidence only. The progress snapshot includes evidence age; it does not independently prove that ACP is still doing useful work.

Read the private response file locally after the process reaches a terminal event. Do not publish that file automatically.

Treat only the matching `terminal` event as terminal evidence. Preserve `completed`, `cancelled`, and `failed` as distinct states.

Map supervisor exits as documented in the runtime contract. Never turn a failed or cancelled run into a success report. Treat process exit as the final delivery of that mapping; the CLI bounds output flushing before forcing termination so leaked runtime handles cannot hold the caller open.

Report completion only after both the matching normalized terminal event and the mapped supervisor process exit. A returned poll, a quiet event stream, or a serviced conversation reply replaces neither.

## Foreground policy

The supervisor rejects detached execution forms, explicit background flags, permission bypass modes, nested agent routes, uninspectable or over-limit permission input, unclassified tool kinds, and tool kinds outside the configured allowlist.

Foreground parallel runners are allowed when their parent process blocks until all children finish. Use test-runner concurrency, `xargs -P`, or an equivalent joining primitive. Shell `&` is rejected because the permission request does not prove that every child will be joined.

The guard is a permission-layer contract, not an operating-system sandbox. It rejects only the inspected request shape; approved foreground code may still daemonize internally. Do not claim stronger containment.

## Report to Discord

Route normalized `started`, `activity`, `progress`, `permission_rejected`, and `terminal` events to the current conversation according to the caller's local reporting policy. Normalized events never carry the control conversation ID or the start message ID; the caller already holds both.

Keep personal channel IDs, operator identity, watchdog language and cadence, model fallback policy, and organization-specific Git workflow outside this public skill.

## Fail closed

Stop without fallback when the start-receipt gate, environment preflight, runtime discovery, capability checks, permission inspection, event/result identity, response storage, or terminal mapping is uncertain. Do not recover by creating an official ACP thread or launching untracked ACPX.
