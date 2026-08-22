# Runtime contract

This reference defines the compatibility and evidence boundary for the direct ACPX supervisor.

## Contents

- [Required capabilities](#required-capabilities)
- [Compatibility targets](#compatibility-targets)
- [Private input and output](#private-input-and-output)
- [Config fields](#config-fields)
- [Start-receipt gate](#start-receipt-gate)
- [Environment preflight](#environment-preflight)
- [Permission decisions](#permission-decisions)
- [Event identity](#event-identity)
- [Evidence boundary](#evidence-boundary)
- [Stable exits](#stable-exits)
- [Process liveness](#process-liveness)
- [Host wait boundaries](#host-wait-boundaries)
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
- `timeoutMs`: positive turn deadline independent of watchdog cadence; the template ships a two-hour emergency ceiling, configurable per run
- `lifecycle`: start-receipt contract binding the run to the control conversation
  - `lifecycle.controlConversationId`: control conversation identifier
  - `lifecycle.startReceipt.conversationId`: conversation the start message was delivered to
  - `lifecycle.startReceipt.messageId`: delivered start-message identifier
  - `lifecycle.startReceipt.deliveredAt`: caller-observed delivery instant

Optional:

- `model`: explicit ACP model
- `lifecycle.maxStartReceiptAgeMs`: receipt freshness window; defaults to `300000` and is bounded to `1000`–`3600000`
- `progressMs`: progress snapshot interval; zero disables snapshots
- `maxResponseBytes`: bounded response capture size
- `requiredEnv`: environment-variable names that must be present and non-empty in the supervisor's own environment
- `forbiddenEnv`: environment-variable names that must be absent or empty in the supervisor's own environment

## Start-receipt gate

`lifecycle` is required. It states that the caller already announced this run in the control conversation and supplies the delivery receipt for that announcement.

Identifiers are bounded decimal chat identifier strings of 1 to 32 digits; a JSON number is not a decimal spelling and is rejected rather than coerced. `deliveredAt` is a bounded ISO-8601 instant carrying at most six fractional-second digits and an explicit `Z` or numeric offset, so Discord's native `2026-08-22T07:47:48.530000+00:00` form is accepted as written; a local time without an offset is ambiguous and rejected, and a longer fraction is out of bounds. `lifecycle.startReceipt.conversationId` must equal `lifecycle.controlConversationId`, so a receipt earned in another conversation cannot start this run.

Shape violations are invalid config and keep the invalid-config exit mapping: `invalid_lifecycle`, `invalid_start_receipt`, `invalid_control_conversation_id`, `invalid_start_receipt_conversation_id`, `invalid_start_receipt_message_id`, `invalid_start_receipt_conversation_mismatch`, `invalid_start_receipt_delivered_at`, and `invalid_max_start_receipt_age_ms`.

Freshness depends on the clock rather than on the config text, so it is evaluated at run time before dynamic runtime import, runtime probing, `createAcpRuntime`, or any adapter startup. A receipt more than one second ahead of the supervisor clock fails with `start_receipt_future`; a receipt older than `lifecycle.maxStartReceiptAgeMs` fails with `start_receipt_stale`. The one-second forward allowance absorbs remote chat-clock skew and does not widen the freshness window. A config object that reaches `runSupervisor` without a bound, parsed receipt fails with `start_receipt_missing` or `start_receipt_conversation_mismatch`. That run-time check is a real backstop for configs assembled in memory instead of loaded from disk: it re-asserts string identifiers and the `1000`–`3600000` freshness bound rather than trusting or coercing them, so a numeric identifier or an out-of-range window fails with `start_receipt_missing`. These codes map to the supervisor error exit.

The gate validates caller-attested receipt metadata only. The supervisor holds no chat credentials and makes no network call, so it cannot prove that the message exists, that its text matches, that the caller authored it, or that the identifiers were not replayed from an earlier run within the freshness window. It proves that the caller committed to a specific, recent, same-conversation start message before the turn began.

The control conversation ID and the start message ID are never emitted in normalized events, stored in the response file, or hashed into any event field.

## Environment preflight

`requiredEnv` and `forbiddenEnv` declare a generic caller-side environment contract. Each list is optional and bounded to 32 portable environment-variable names of at most 64 characters each, matching `[A-Za-z_][A-Za-z0-9_]*`. Contract-name identity is case-insensitive on every platform: Windows `process.env` lookups ignore case, so a case-conditional rule would make the same config mean different things per platform. Names that differ only by case are duplicates within a list, and required/forbidden overlap is judged case-insensitively. The caller's original spelling is preserved for environment lookup and for the sanitized failure codes. Shape violations are invalid config and keep the invalid-config exit mapping.

Before dynamic runtime import, runtime probing, `createAcpRuntime`, or any adapter startup, the supervisor fails closed when a required variable is absent or empty, or when a forbidden variable is non-empty. The stable failure codes name only the caller-declared variable — `required_env_missing:NAME`, `required_env_empty:NAME`, `forbidden_env_present:NAME` — and map to the supervisor error exit. Environment values are never emitted, stored, hashed, or otherwise disclosed.

The gate proves presence or absence only. It does not prove how a variable was injected, validate credential files, or select a credential source. Credential-specific policy — secure file validation, precedence, and exact launch construction such as `node --env-file=...` — remains the responsibility of local caller overlays that complement this generic contract.

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
- `22`: supervisor policy, environment preflight, compatibility, deadline, runtime, storage, stream, cleanup, or delivery error

When the ACP result is exact but response storage, event draining, cleanup, or response completeness is degraded, preserve the exact ACP status in the terminal event, set `supervisorStatus: "degraded"`, and exit 22.
- `64`: invalid CLI or config

After `main()` resolves, the CLI bounds stdout/stderr flushing and then exits with the mapped code. A leaked adapter handle must not keep the foreground caller waiting after terminal evidence has been delivered.

Do not collapse cancellation or failure into success.

## Process liveness

Session existence, adapter process existence, supervisor process existence, child-shell existence, and Discord typing state do not prove that the ACP turn is still active.

Their disappearance also does not replace the exact turn result.

## Host wait boundaries

Foreground ownership is a property of the supervisor process tree, not of the caller's host tool call. A caller may return from a host tool while the supervisor keeps running, provided the same tracked process stays owned until it exits.

The caller contract is:

- start the supervisor through one tracked foreground host exec;
- bound the initial host wait to five seconds unless the process is already terminal;
- retain the exact non-empty process handle the host reports for that run;
- poll only that handle, waiting 1, 2, 4, and then 5 seconds, capped at five seconds;
- service steered control-surface input at each returned poll boundary and continue the same turn unless the message explicitly cancels or replaces it;
- report completion only after both the matching normalized terminal event and the mapped process exit.

One run has one handle. Do not open a second handle, PID search, transcript poll, broad process monitor, long shell sleep, long blocking exec or write wait, or nested wrapper for the same run.

A returned poll is evidence about the host boundary only. It is not activity evidence, and it is never terminal evidence. Bounded host waits change when the caller regains control; they do not change the evidence boundary, the stable exits, or cancellation.

## Cancellation

Bind SIGINT and SIGTERM before runtime probing, carry a pending request into the exact turn once it exists, and release handlers only after normalized terminal output and cleanup. Continue waiting for the exact result until the required deadline and bounded cancellation grace expire. Do not report `cancelled` merely because a signal handler ran.

## Non-goals

This contract does not:

- globally disable OpenClaw ACP commands;
- provide an operating-system sandbox;
- read, authenticate, or otherwise confirm a chat message from the supervisor process;
- guarantee containment of arbitrary foreground code that daemonizes internally;
- define a personal watchdog interval, language, destination, or message template;
- define host-specific stale-session detection or recovery;
- make an official ACP child thread observable by the direct supervisor.
