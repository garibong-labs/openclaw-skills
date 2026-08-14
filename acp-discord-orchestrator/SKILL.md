---
name: "acp-discord-orchestrator"
description: "Track agent-started Discord ACP tasks through foreground-only direct ACPX with normalized progress and exact turn completion; use instead of ACP child threads."
---

# ACP Discord Orchestrator

Run each agent-started ACP task through one observable direct ACPX turn. Keep the current Discord conversation as the control and reporting surface.

## Required route

Use `scripts/acpx-foreground-supervisor.mjs` for every ACP task started by the calling agent.

Do not use:

- OpenClaw `sessions_spawn` with `runtime: "acp"`
- `/acp spawn` or another ACP child-thread command
- a new Discord thread created only to host ACP
- an untracked shell, PTY, or native subagent as a substitute for the ACP turn

This policy does not globally disable human-operated OpenClaw ACP commands.

## Prepare the run

1. Confirm Node.js 22.13 or newer, then read [references/runtime-contract.md](references/runtime-contract.md).
2. Read `openclaw plugins info acpx --json` and copy the `acpx` dependency's `resolvedPath` into `runtimeModule`.
3. Copy [templates/supervisor-config.json](templates/supervisor-config.json) to a private temporary file.
4. Create a private prompt file and choose a new response-file path.
5. Set the config file and prompt file to owner-only permissions.
6. Set an explicit working directory, ACP agent, model, unique session key, timeout, progress interval, and allowed tool kinds.
7. Define terminal acceptance checks in the prompt.
8. Resolve this skill's directory and run the supervisor by absolute path in the foreground:

```bash
node /absolute/path/to/acp-discord-orchestrator/scripts/acpx-foreground-supervisor.mjs --config /absolute/private/run.json
```

Do not background the supervisor. Consume its newline-delimited JSON events while its process remains attached.

## Interpret events

Treat `activity` and `progress` as observational evidence only. The progress snapshot includes evidence age; it does not independently prove that ACP is still doing useful work.

Read the private response file locally after the process reaches a terminal event. Do not publish that file automatically.

Treat only the matching `terminal` event as terminal evidence. Preserve `completed`, `cancelled`, and `failed` as distinct states.

Map supervisor exits as documented in the runtime contract. Never turn a failed or cancelled run into a success report.

## Foreground policy

The supervisor rejects known detached execution forms, explicit background flags, permission bypass modes, uninspectable permission input, and tool kinds outside the configured allowlist.

Foreground parallel runners are allowed when their parent process blocks until all children finish. Use test-runner concurrency, `xargs -P`, or an equivalent joining primitive. Shell `&` is rejected because the permission request does not prove that every child will be joined.

The guard is a permission-layer contract, not an operating-system sandbox. Arbitrary foreground code may daemonize internally. Do not claim stronger containment.

## Report to Discord

Route normalized `started`, `activity`, `progress`, `permission_rejected`, and `terminal` events to the current conversation according to the caller's local reporting policy.

Keep personal channel IDs, operator identity, watchdog language and cadence, model fallback policy, and organization-specific Git workflow outside this public skill.

## Fail closed

Stop without fallback when runtime discovery, capability checks, permission inspection, event/result identity, response storage, or terminal mapping is uncertain. Do not recover by creating an official ACP thread or launching untracked ACPX.
