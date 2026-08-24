---
name: "acp-discord-orchestrator"
description: "Track foreground ACPX turns with bounded CLI exit and exact completion."
runtime:
  - node (22.13+; the Claude launcher additionally needs process.execve — 22.15+ in the 22.x line, 23.11+ in the 23.x line, or any later line — on a POSIX platform)
credentials:
  - purpose: Claude Code setup token for ACP runs with agent "claude", injected only via node --env-file by scripts/claude-acp-launcher.mjs
    required: false
    format: private env file with exactly one line, CLAUDE_CODE_OAUTH_TOKEN=<token>, mode 0600 inside a 0700 owner-only directory
    note: Required exactly when agent is "claude". The config carries only the auth.envFile path; the token value never appears in config, argv, events, or logs and is never committed.
---

# ACP Discord Orchestrator

Run each agent-started ACP task through one observable direct ACPX turn. Keep the current Discord conversation as the control and reporting surface.

The skill is agent-neutral within a closed supported set: ACP agent `claude` (publicly presented as `Claude Code`) and ACP agent `codex` (publicly presented as `Codex`). The public label on every reporting template is bound to the canonical config agent through that closed mapping — a caller can never choose, spell, or spoof the harness label. The closed set is enforced as the first agent check on every path: an agent outside the set fails `invalid_agent_unsupported` and a non-canonical spelling of a supported agent fails `invalid_agent_not_canonical`, before any unrelated file access or runtime loading.

## Required route

Use `scripts/acpx-foreground-supervisor.mjs` for every ACP task started by the calling agent.

For `agent: "claude"`, start the supervisor only through the canonical launcher `scripts/claude-acp-launcher.mjs`. It validates the config's `auth` declaration, the parent environment, and the private setup-token env file, then replaces its own process with the supervisor via POSIX `process.execve` so the run still owns exactly one foreground PID and the supervisor starts as `node --env-file=<auth.envFile> acpx-foreground-supervisor.mjs --config <config>`. The launcher requires a POSIX platform and a Node.js runtime with `process.execve` — 22.15 or newer in the 22.x line, 23.11 or newer in the 23.x line, or any later release line (23.0–23.10 lack it) — and fails closed with `execve_unsupported` everywhere else. A bare direct Claude supervisor launch is a bypass and fails closed with the supervisor policy exit before any runtime loading. The agent name must be the canonical lowercase `claude`: ACPX normalizes agent names, so other spellings would reach the same adapter and are rejected as invalid config.

Do not use:

- OpenClaw `sessions_spawn` with `runtime: "acp"`
- `/acp spawn` or another ACP child-thread command
- a new Discord thread created only to host ACP
- an untracked shell, PTY, or native subagent as a substitute for the ACP turn

This policy does not globally disable human-operated OpenClaw ACP commands.

## Prepare the run

1. Confirm Node.js 22.13 or newer, then read [references/runtime-contract.md](references/runtime-contract.md).
2. Read `openclaw plugins info acpx --json`, require the ACPX 0.11.2-or-newer capability contract, and copy the `acpx` dependency's `resolvedPath` into `runtimeModule`.
3. Copy [templates/supervisor-config.json](templates/supervisor-config.json) to a private temporary file. The template is agent-neutral: substitute `AGENT_NAME` with the canonical agent (`claude` or `codex`) and `AGENT_DISPLAY_NAME` with that agent's mapped public label (`Claude Code` or `Codex`) exactly — the supervisor rejects any other pairing. `AGENT_NAME` appears exactly twice (the config `agent` and the reporting bundle's `agent` attestation) and `AGENT_DISPLAY_NAME` appears exactly three times (the start message, its byte-identical receipt copy, and the watchdog report identity line); substitute `AGENT_DISPLAY_NAME` before `AGENT_NAME` so the longer placeholder is never corrupted by the shorter one, and verify every occurrence is bound.
4. Create a private prompt file and choose a new response-file path.
5. Set the config file and prompt file to owner-only permissions.
6. Set an explicit working directory, ACP agent, model, unique session key, timeout, progress interval, and allowed tool kinds. The template's two-hour `timeoutMs` is an emergency ceiling independent of reporting cadence; set it per run. `model` is the adapter-advertised ACP model ID and is passed to the runtime verbatim; ACPX bracketed reasoning-selection IDs such as `gpt-5.2[high]` or `gpt-5.6-sol[low]` are valid complete model IDs (at most one non-empty alphanumeric bracket suffix at the end — there is no separate thinking field), and malformed bracket forms fail closed as `invalid_model`.
7. Announce the run in the current control conversation first, then record that delivery in the required `lifecycle` block: `controlConversationId`, the same conversation ID and the delivered `messageId` under `startReceipt`, and the observed `deliveredAt` instant. The supervisor fails closed before runtime loading, probing, or adapter startup when the receipt is missing, malformed, bound to another conversation, dated ahead of its own clock, or older than `maxStartReceiptAgeMs`. It validates caller-attested receipt metadata only; it holds no chat credentials and makes no network call, so it does not prove the message exists or that its text matches.
8. Prepare the round's public reporting bundle and record it in the required `reporting` block (schema `acp-reporting-v2`; its top-level `agent` must equal the config's canonical agent, and every template identity line must carry that agent's mapped public label — `Claude Code` or `Codex`. The legacy `acp-reporting-v1` shape is accepted only for canonical `claude` during the bounded migration and is rejected for `codex`), in this order, before any launch:
   - Create exactly one disabled public-only watchdog for this round: tool-less (`toolsAllow: []`), isolated session, `{ "kind": "every", "everyMs": 600000 }` schedule, Discord announce to the control conversation channel, `deleteAfterRun: false`, and a timeout of at most 60 seconds. Its payload is only the minimal verbatim relay instruction plus one exact 19-line public `ACP 중간 보고` report between the delimiters. Free text lives only in the bounded template slots, where a bounded known-pattern screen rejects recognized operational content (paths, shell/Git commands, process or session inspection, scheduler internals, known silence/self-decision phrasings); the screen is a tripwire for known patterns, not a semantic filter, and the exact-template layout is the primary control. Repository/branch/model metadata is bound by its own validators, not by the screen, so names like `fix/routing` stay legal.
   - Send the exact round-start boundary message to the control conversation — the same delivery already recorded in `lifecycle.startReceipt` — matching the fixed 13-line start template for this round and the mapped agent label/model/repository/branch.
   - Store the watchdog snapshot and the start message with its receipt in `reporting`, keeping `startDestination`, `watchdogDestination`, and `terminalDestination` all equal to `lifecycle.controlConversationId` and `reporting.startReceipt` byte-identical to the lifecycle receipt.
   - Only then launch. A missing or malformed `reporting` bundle is invalid config: the supervisor fails closed with a stable `invalid_reporting_*` code before runtime import, probing, or adapter startup. The template ships a complete placeholder bundle; the exact schema and message templates are defined in [references/runtime-contract.md](references/runtime-contract.md).
9. Optionally declare the run's environment contract with `requiredEnv` and `forbiddenEnv`. The supervisor fails closed before runtime loading, probing, or adapter startup when a required variable is absent or empty or a forbidden variable is non-empty, and it never discloses environment values. Independent of these arrays, an agent-neutral process-integrity baseline is enforced automatically for every supported agent — `codex` exactly like `claude`: `NODE_OPTIONS` and the other Node module/preload selectors, the dynamic-linker preload/library selectors, and the proxy selectors in both letter cases must be absent or empty, and a config that lists one of them in `requiredEnv` (under any letter case) is rejected as `invalid_env_contract_overlap`. This gate does not prove how a variable was injected or validate credential sources; for non-Claude agents the generic contract plus the baseline is the whole environment contract.
10. For `agent: "claude"`, declare the required auth profile and keep the token in a private env file the config only points to:

   ```json
   "auth": { "kind": "claude-setup-token-env-file", "envFile": "/absolute/private/claude-acp-oauth.env" }
   ```

   The env file holds exactly one line, `CLAUDE_CODE_OAUTH_TOKEN=<token>`, with no quotes, comments, or extra variables. Its parent directory must be a real owner-only (0700) directory and the file a real owner-only (0600) regular file, both owned by the launching user. The Claude credential contract — `CLAUDE_CODE_OAUTH_TOKEN` required; competing `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and `CLAUDE_CODE_USE_FOUNDRY` forbidden; and every injection-capable variable forbidden, meaning the agent-neutral process-integrity baseline (`NODE_OPTIONS` and the other Node module/preload selectors, dynamic-linker preloads, proxy selectors) plus the Anthropic-specific endpoint/header/config selectors layered on top for Claude — is enforced automatically even when `requiredEnv` and `forbiddenEnv` are empty. Never place the token value in the config, argv, or any argument.

   The main template is agent-neutral and ships no `auth` block. The Claude-specific `agent`/`auth` pairing lives in the provider-specific profile [templates/claude-auth-profile.json](templates/claude-auth-profile.json); for `agent: "claude"`, merge that profile's `auth` block into your run config. For every other agent, declare no `auth` at all: an `auth` profile on a non-Claude agent is invalid config (`invalid_auth_agent`), and non-Claude runs — including `codex` — declare their whole environment contract through `requiredEnv`/`forbiddenEnv` instead. (A dedicated provider-auth skill, `acp-agent-auth`, is planned separately; until it exists, the generic environment contract is the only supported non-Claude credential gate.)

   The launcher certifies a clean parent environment and unsets nothing silently. If the launching shell already exports `CLAUDE_CODE_OAUTH_TOKEN` (even empty), a competing credential selector, or an injection-capable variable such as `NODE_OPTIONS`, the launch fails closed with a code naming the variable. Remediate by removing the variable explicitly in the launching shell — for example `env -u NODE_OPTIONS -u CLAUDE_CODE_OAUTH_TOKEN node …` — rather than expecting the launcher to strip it.
11. Define terminal acceptance checks in the prompt.
12. Resolve this skill's directory and run the run's canonical entry point by absolute path in the foreground. For Claude (POSIX, Node.js 22.15+/23.11+ or any later line):

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

The watchdog cadence, control-conversation routing, and public message templates are fixed by the generic `acp-reporting-v2` reporting contract in [references/runtime-contract.md](references/runtime-contract.md) (with a bounded `acp-reporting-v1` compatibility path for canonical `claude` only); only the bounded free-text slots inside those templates vary per run. Keep personal channel IDs, operator identity, model fallback policy, and organization-specific Git workflow outside this public skill.

## Fail closed

Stop without fallback when the start-receipt gate, reporting contract, environment preflight, runtime discovery, capability checks, permission inspection, event/result identity, response storage, or terminal mapping is uncertain. Do not recover by creating an official ACP thread or launching untracked ACPX.
