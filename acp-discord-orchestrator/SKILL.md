---
name: "acp-discord-orchestrator"
description: "Track host-owned ACPX turns with bounded CLI control and exact completion."
runtime:
  - node (22.13+; the Claude launcher additionally needs process.execve — 22.15+ in the 22.x line, 23.11+ in the 23.x line, or any later line — on a POSIX platform)
  - tmux and executable `/usr/bin/env` (production host transport on POSIX)
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

Use `scripts/acp-host-transport-cli.mjs` for every production ACP task started by the calling agent. The transport starts `scripts/acpx-foreground-supervisor.mjs` inside one owner-only tmux session and returns the exact non-empty session handle before a separate activation call can begin ACP mutation.

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
6. Set an explicit working directory, ACP agent, model, unique session key, timeout, progress interval, and allowed tool kinds. The template's two-hour `timeoutMs` is an emergency ceiling independent of reporting cadence; set it per run. `model` is the adapter-advertised ACP model ID and is passed to the runtime verbatim; ACPX bracketed reasoning-selection IDs such as `gpt-5.2[high]` or `gpt-5.6-sol[low]` are valid complete model IDs (at most one non-empty alphanumeric bracket suffix at the end — there is no separate thinking field), and malformed bracket forms fail closed as `invalid_model`. The `model` namespace is the ACP adapter's, never OpenClaw's: for `agent: "claude"` write the ID the Claude ACP adapter advertises — `claude-fable-5`, not the OpenClaw provider/catalog key `anthropic/claude-fable-5` — because the supervisor rejects any `anthropic/`-prefixed Claude model with the stable code `invalid_model_openclaw_provider_key` before runtime loading, probing, or adapter startup, on both the config-file and in-memory paths. Model omission is agent-specific: for `agent: "codex"`, write `"model": "gpt-5.6-sol[medium]"` explicitly in run configs — that is the supervisor's authoritative Codex default, and a config that omits `model` is normalized to exactly that ID by the supervisor (before reporting validation and before the runtime receives `sessionOptions.model`), never left to inherit the adapter/backend preset; the reporting templates of such a run must therefore name `gpt-5.6-sol[medium]`, and a Codex bundle claiming `runtime-default` is rejected. For `agent: "claude"`, an omitted `model` remains genuine omission and keeps the public `runtime-default` label.
7. Announce the run in the current control conversation first, then record that delivery in the required `lifecycle` block: `controlConversationId`, the same conversation ID and the delivered `messageId` under `startReceipt`, and the observed `deliveredAt` instant. The supervisor fails closed before runtime loading, probing, or adapter startup when the receipt is missing, malformed, bound to another conversation, dated ahead of its own clock, or older than `maxStartReceiptAgeMs`. It validates caller-attested receipt metadata only; it holds no chat credentials and makes no network call, so it does not prove the message exists or that its text matches.
8. Prepare the round's public reporting bundle and record it in the required `reporting` block (schema `acp-reporting-v2`; its top-level `agent` must equal the config's canonical agent, and every template identity line must carry that agent's mapped public label — `Claude Code` or `Codex`. The legacy `acp-reporting-v1` shape is accepted only for canonical `claude` during the bounded migration and is rejected for `codex`), in this order, before any launch:
   - Create exactly one disabled public-only watchdog for this round: tool-less (`toolsAllow: []`), isolated session, `{ "kind": "every", "everyMs": 600000 }` schedule, Discord announce to the control conversation channel, `deleteAfterRun: false`, and a timeout of at most 60 seconds. Its payload is only the minimal verbatim relay instruction plus one exact 19-line public `ACP 중간 보고` report between the delimiters. Free text lives only in the bounded template slots, where a bounded known-pattern screen rejects recognized operational content (paths, shell/Git commands, process or session inspection, scheduler internals, known silence/self-decision phrasings); the screen is a tripwire for known patterns, not a semantic filter, and the exact-template layout is the primary control. Repository/branch/model metadata is bound by its own validators, not by the screen, so names like `fix/routing` stay legal.
   - Generate the round-start message with the production builder instead of hand-assembling the template: write the structured fields (`agent`, the run's effective `model` — omit only for a claude run without a pinned model — `roundIndex`, `repository`, `branch`, `timeKst`, `scope`, `externalAction`) to a private owner-only JSON file and run

     ```bash
     node /absolute/path/to/acp-discord-orchestrator/scripts/acp-start-message-cli.mjs --input /absolute/private/start-message.json
     ```

     The CLI writes only the rendered 13-line message to stdout. The round title (`🚀 ACP 작업 시작` for round 1, `🔁 ACP 수정 라운드 N 시작` for every correction round) and the public harness label are derived from `roundIndex` and the closed agent mapping — an input that tries to supply them is rejected — so a correction round can never reuse the round-1 title. Do not hand-write the title, the label, or the template lines; already-assembled supervisor configs stay valid because the builder's output is byte-identical to the fixed template.
   - Send the exact generated round-start boundary message to the control conversation — the same delivery already recorded in `lifecycle.startReceipt` — matching the fixed 13-line start template for this round and the mapped agent label/model/repository/branch.
   - Store the watchdog snapshot and the start message with its receipt in `reporting`, keeping `startDestination`, `watchdogDestination`, and `terminalDestination` all equal to `lifecycle.controlConversationId` and `reporting.startReceipt` byte-identical to the lifecycle receipt.
   - Only then launch. A missing or malformed `reporting` bundle is invalid config: the supervisor fails closed with a stable `invalid_reporting_*` code before runtime import, probing, or adapter startup. The template ships a complete placeholder bundle; the exact schema and message templates are defined in [references/runtime-contract.md](references/runtime-contract.md).
9. Optionally declare the run's environment contract with `requiredEnv` and `forbiddenEnv`. The supervisor fails closed before runtime loading, probing, or adapter startup when a required variable is absent or empty or a forbidden variable is non-empty, and it never discloses environment values. Independent of these arrays, an agent-neutral process-integrity baseline is enforced automatically for every supported agent — `codex` exactly like `claude`: `NODE_OPTIONS` and the other Node module/preload selectors, the dynamic-linker preload/library selectors, and the proxy selectors in both letter cases must be absent or empty, and a config that lists one of them in `requiredEnv` (under any letter case) is rejected as `invalid_env_contract_overlap`. For `agent: "codex"`, an implicit Codex executable-path contract is layered on that baseline automatically, even when both arrays are empty: the operator must inject `CODEX_PATH` as an explicit environment assignment on the launch command, naming the absolute path of the real Codex executable, and the supervisor validates — still before runtime loading, probing, or adapter startup — that the value is an absolute path resolving to an existing regular executable file (a symlinked entrypoint is valid; resolution follows the link). A missing or empty value fails with the sanitized `required_env_missing:CODEX_PATH` / `required_env_empty:CODEX_PATH` codes; an invalid value fails with the stable bounded codes `codex_path_not_absolute`, `codex_path_missing`, `codex_path_unreadable`, `codex_path_not_regular`, or `codex_path_not_executable`, and the path value itself is never echoed, hashed, or length-disclosed. A codex config that lists `CODEX_PATH` (under any letter case) in `forbiddenEnv` is rejected as `invalid_env_contract_overlap`. This keeps a Codex run from silently falling back to an implicitly resolved (for example transient npx-bundled) Codex installation. The gate does not prove how a variable was injected or validate credential sources; for `codex` the generic contract, the baseline, and the executable-path contract are the whole environment contract.
10. For `agent: "claude"`, declare the required auth profile and keep the token in a private env file the config only points to:

   ```json
   "auth": { "kind": "claude-setup-token-env-file", "envFile": "/absolute/private/claude-acp-oauth.env" }
   ```

   The env file holds exactly one line, `CLAUDE_CODE_OAUTH_TOKEN=<token>`, with no quotes, comments, or extra variables. Its parent directory must be a real owner-only (0700) directory and the file a real owner-only (0600) regular file, both owned by the launching user. The Claude credential contract — `CLAUDE_CODE_OAUTH_TOKEN` required; competing `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and `CLAUDE_CODE_USE_FOUNDRY` forbidden; and every injection-capable variable forbidden, meaning the agent-neutral process-integrity baseline (`NODE_OPTIONS` and the other Node module/preload selectors, dynamic-linker preloads, proxy selectors) plus the Anthropic-specific endpoint/header/config selectors layered on top for Claude — is enforced automatically even when `requiredEnv` and `forbiddenEnv` are empty. Never place the token value in the config, argv, or any argument.

   The main template is agent-neutral and ships no `auth` block. The Claude-specific `agent`/`auth` pairing lives in the provider-specific profile [templates/claude-auth-profile.json](templates/claude-auth-profile.json); for `agent: "claude"`, merge that profile's `auth` block into your run config. For every other agent, declare no `auth` at all: an `auth` profile on a non-Claude agent is invalid config (`invalid_auth_agent`), and non-Claude runs — including `codex` — declare their whole environment contract through `requiredEnv`/`forbiddenEnv` instead. (A dedicated provider-auth skill, `acp-agent-auth`, is planned separately; until it exists, the generic environment contract is the only supported non-Claude credential gate.)

   The launcher certifies a clean parent environment and unsets nothing silently. If the launching shell already exports `CLAUDE_CODE_OAUTH_TOKEN` (even empty), a competing credential selector, or an injection-capable variable such as `NODE_OPTIONS`, the launch fails closed with a code naming the variable. Remediate by removing the variable explicitly in the launching shell — for example `env -u NODE_OPTIONS -u CLAUDE_CODE_OAUTH_TOKEN node …` — rather than expecting the launcher to strip it.
11. Define terminal acceptance checks in the prompt.
12. Resolve this skill's directory and use `scripts/acp-host-transport-cli.mjs` by absolute path. Before publishing the ACP start boundary, run the harmless `probe` action from a private input file and require `host_transport_ready`. After the boundary and config receipt exist, run `prepare` with the private config path. For Codex, inject the host-specific executable path on the `prepare` command, for example `CODEX_PATH=/opt/homebrew/bin/codex`; the transport copies only the bounded operational environment plus caller-declared required variables into the tmux-owned child.

Every CLI action reads one owner-only JSON file:

```json
{"schemaVersion":"acp-host-transport.v1","action":"prepare","configFile":"/absolute/private/run.json"}
```

```bash
CODEX_PATH=/absolute/path/to/codex node /absolute/path/to/acp-discord-orchestrator/scripts/acp-host-transport-cli.mjs --input /absolute/private/prepare.json
```

`prepare` returns `host_transport_prepared` with one exact `processHandle` and private `transportFile`. It does not activate ACP. Persist both values privately, then make a second CLI call whose input has `action: "activate"`, the exact returned `transportFile`, and the exact returned `processHandle`. The transport verifies that tmux still owns that session, waits for `activation_required`, and writes exactly one line into that same PTY:

```json
{"schemaVersion":"acp-host-activation.v1","processHandle":"<exact-host-handle>"}
```

Only the matching `host_transport_activated` result and supervisor `activation_confirmed` event permit runtime import, probe, `ensureSession`, and `startTurn`. EOF, timeout, malformed activation, a missing/invalid handle, or loss of the owner between the two calls fails closed before ACP mutation. The activation deadline is 60 seconds. The handle and transport file stay owner-private and must never enter Discord output or a watchdog payload.

## Own the process without blocking the conversation

Process ownership belongs to the transport's exact tmux session. It is detached from any one shell tool call but remains explicitly addressable by the returned handle and private transport record until the supervisor exits. The ACP supervisor and adapter remain foreground children inside that owned PTY; they are not shell-backgrounded within it.

Conversation blocking belongs to the caller. Use separate bounded `status` calls with the same `transportFile` and `processHandle`, carrying the previous `lastSequence` as `afterSequence`. Poll at 1, 2, 4, and then 5 seconds, capped at five seconds. Do not read the event, stderr, or exit files directly; the transport validates and bounds them.

Do not substitute:

- a PID search or broad process monitoring
- transcript or direct log-file polling
- a long shell sleep
- a long blocking exec or write wait
- a second transport, wrapper, or nested runner around the same run

A returned poll is a host-tool boundary. It is not activity evidence and never terminal evidence.

Keep the owner turn alive while the handle is active. Do not final, yield, or abandon ownership between polls. If `status` reports `unavailable` without a mapped exit and the private ledger has no terminal intent, classify the run as `tracking_lost`, stop active-reporting publication, and never infer success or relaunch automatically.

## Stay responsive at each poll boundary

Treat every returned poll as a servicing point. Before the next poll, read newly steered input from the current conversation and answer it there.

Continue the same ACP round with the retained handle unless the message explicitly cancels or replaces it. Steered input that asks a question, adds context, or requests a status update does not end the turn.

When the message does explicitly cancel or replace the turn, follow the documented cancellation path for the retained handle instead of abandoning it.

## Interpret events

Treat `activity` and `progress` as observational evidence only. The progress snapshot includes evidence age; it does not independently prove that ACP is still doing useful work.

Read the private response file locally after the process reaches a terminal event. Do not publish that file automatically.

Treat only the matching `terminal` event as terminal evidence. Preserve `completed`, `cancelled`, and `failed` as distinct states.

Map supervisor exits as documented in the runtime contract. Never turn a failed or cancelled run into a success report. Treat process exit as the final delivery of that mapping; the CLI bounds output flushing before forcing termination so leaked runtime handles cannot hold the caller open.

After `status` returns `exited` with a mapped exit code, call the host transport CLI with `action: "reconcile"`, the same private transport file, and the same handle. It derives the exact lifecycle ledger and confirms terminal intent plus mapped exit. A supervisor error before activation is reconciled with the ledger's explicit null handle; an invented handle is never bound to that run. If an activated transport disappears without terminal intent, use `scripts/acp-lifecycle-reconcile-cli.mjs` with the `tracking_lost` outcome. Handle mismatch, missing terminal evidence, exit mismatch, and attempts to overwrite an already reconciled ledger fail closed.

Report completion only after both the matching normalized terminal event and the mapped supervisor process exit have been observed and the private-ledger reconciliation succeeds. A returned poll, a quiet event stream, or a serviced conversation reply replaces none of them.

## Foreground policy

The supervisor rejects detached execution forms, explicit background flags, permission bypass modes, nested agent routes, uninspectable or over-limit permission input, unclassified tool kinds, and tool kinds outside the configured allowlist.

Foreground parallel runners are allowed when their parent process blocks until all children finish. Use test-runner concurrency, `xargs -P`, or an equivalent joining primitive. Shell `&` is rejected because the permission request does not prove that every child will be joined.

The guard is a permission-layer contract, not an operating-system sandbox. It rejects only the inspected request shape; approved foreground code may still daemonize internally. Do not claim stronger containment.

## Report to Discord

Route normalized `started`, `activity`, `progress`, `permission_rejected`, and `terminal` events to the current conversation according to the caller's local reporting policy. Normalized events never carry the control conversation ID or the start message ID; the caller already holds both.

The watchdog cadence, control-conversation routing, and public message templates are fixed by the generic `acp-reporting-v2` reporting contract in [references/runtime-contract.md](references/runtime-contract.md) (with a bounded `acp-reporting-v1` compatibility path for canonical `claude` only); only the bounded free-text slots inside those templates vary per run. Keep personal channel IDs, operator identity, model fallback policy, and organization-specific Git workflow outside this public skill.

## Fail closed

Stop without fallback when the start-receipt gate, reporting contract, host activation, private lifecycle ledger, exact-handle tracking, environment preflight, runtime discovery, capability checks, permission inspection, event/result identity, response storage, exit reconciliation, or terminal mapping is uncertain. Do not recover by creating an official ACP thread, launching untracked ACPX, reconstructing ownership from PIDs/transcripts, or automatically retrying `tracking_lost`.
