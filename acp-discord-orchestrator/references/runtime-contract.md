# Runtime contract

This reference defines the compatibility and evidence boundary for the direct ACPX supervisor.

## Contents

- [Required capabilities](#required-capabilities)
- [Compatibility targets](#compatibility-targets)
- [Private input and output](#private-input-and-output)
- [Config fields](#config-fields)
- [Permission decisions](#permission-decisions)
- [Event identity](#event-identity)
- [Evidence boundary](#evidence-boundary)
- [Stable exits](#stable-exits)
- [Process liveness](#process-liveness)
- [Cancellation](#cancellation)
- [Non-goals](#non-goals)

## Required capabilities

Run on Node.js 22.13 or newer.

Resolve ACPX from the explicit package root recorded in `runtimeModule`. Obtain that path from the active OpenClaw plugin's read-only dependency information before launch. The supervisor does not execute discovery commands. Require public equivalents of:

- `createAcpRuntime`
- `createRuntimeStore`
- `createAgentRegistry`
- runtime `ensureSession`, `startTurn`, and `close`
- a turn with matching `requestId`, async `events`, Promise `result`, `cancel`, and `closeStream`
- distinct `completed`, `cancelled`, and `failed` results

Use capability detection. Do not select behavior from a version string alone.

## Compatibility targets

Require the ACPX 0.11.2-or-newer turn capability contract. Older releases such as ACPX 0.5.3 do not expose `startTurn`, `turn.result`, `closeStream`, or `onPermissionRequest` and must fail closed. OpenClaw releases pin different ACPX versions, so inspect the active plugin instead of assuming compatibility from the OpenClaw version. The initial tested matrix covers ACPX 0.11.2 and the standalone forward target ACPX 0.13.0.

A target passes only when the same behavior tests confirm runtime discovery, permission inspection, foreground rejection, normalized event consumption, response capture, exact result mapping, cancellation, cleanup, and process exit.

Fail closed on incompatible capability changes. Never fall back to another ACP route.

## Private input and output

Pass only one command-line value: an absolute private config-file path.

The config points to a separate private prompt file and a response-file path that must not exist yet. Reject config or prompt symlinks. On POSIX systems, config and prompt files must have no group or world permissions. Require an existing state directory to be a real directory with owner-only permissions; do not repair broad permissions by changing them.

The supervisor writes the model response to the response file with owner-only permissions. Raw response text is not included in normalized progress events.

## Config fields

Required:

- `agent`: ACP agent name
- `cwd`: absolute working directory
- `sessionKey`: unique task identity
- `promptFile`: absolute existing private file
- `responseFile`: absolute new private file
- `stateDir`: absolute private runtime state directory
- `runtimeModule`: absolute ACPX package root or runtime module file
- `allowKinds`: non-empty tool-kind allowlist that excludes the unclassified `other` kind
- `timeoutMs`: positive turn deadline independent of watchdog cadence

Optional:

- `model`: explicit ACP model
- `progressMs`: progress snapshot interval; zero disables snapshots
- `maxResponseBytes`: bounded response capture size

## Permission decisions

Return only `allow_once`, `reject_once`, or `cancel`.

Reject:

- missing or unknown tool kind;
- tool kind outside `allowKinds`;
- missing, non-object, over-depth, over-width, oversized, or otherwise uninspectable structured raw input;
- the unclassified `other` tool kind;
- explicit background or daemon flags;
- permission bypass settings or command-line flags;
- nested ACP or background-agent routes;
- `nohup`, `disown`, `setsid`, or standalone shell `&`.

The shell rule is intentionally conservative. Use foreground parallel runners whose own process blocks until every child finishes.

## Event identity

Assign one supervisor run ID and one request ID. Bind them to one ACP turn.

Every normalized event includes:

- schema version;
- supervisor run ID;
- request ID;
- monotonic sequence;
- timestamp;
- elapsed milliseconds;
- event type.

Never merge multiple turns under one run ID.

## Evidence boundary

The event stream provides activity evidence, not terminal evidence.

Normalize event payloads. Allow only bounded protocol-token forms for tags, tool kinds, tool status, runtime versions, stop reasons, and error codes. Drop or replace everything else. Do not emit raw prompt text, raw model text, raw tool input, raw tool output, content blocks, tool titles, secrets, tokens, or unrestricted command output.

A timer-driven progress event is a snapshot. `evidenceAgeMs` exposes the age of the last actual ACP event so consumers do not mislabel an old snapshot as fresh activity.

Only the matching turn `result` determines terminal state. A successfully emitted `terminal` or `supervisor_error` event closes normalized output; no later ACP activity is delivered. Terminal events omit the working-directory name and response fingerprint.

## Stable exits

- `0`: completed
- `20`: cancelled
- `21`: failed
- `22`: supervisor policy, compatibility, deadline, runtime, storage, stream, cleanup, or delivery error

When the ACP result is exact but response storage, event draining, cleanup, or response completeness is degraded, preserve the exact ACP status in the terminal event, set `supervisorStatus: "degraded"`, and exit 22.
- `64`: invalid CLI or config

Do not collapse cancellation or failure into success.

## Process liveness

Session existence, adapter process existence, supervisor process existence, child-shell existence, and Discord typing state do not prove that the ACP turn is still active.

Their disappearance also does not replace the exact turn result.

## Cancellation

Bind SIGINT and SIGTERM before runtime probing, carry a pending request into the exact turn once it exists, and release handlers only after normalized terminal output and cleanup. Continue waiting for the exact result until the required deadline and bounded cancellation grace expire. Do not report `cancelled` merely because a signal handler ran.

## Non-goals

This contract does not:

- globally disable OpenClaw ACP commands;
- provide an operating-system sandbox;
- guarantee containment of arbitrary foreground code that daemonizes internally;
- define a personal watchdog interval, language, destination, or message template;
- make an official ACP child thread observable by the direct supervisor.
