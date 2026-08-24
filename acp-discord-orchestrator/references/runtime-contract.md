# Runtime contract

This reference defines the compatibility and evidence boundary for the direct ACPX supervisor.

## Contents

- [Required capabilities](#required-capabilities)
- [Compatibility targets](#compatibility-targets)
- [Private input and output](#private-input-and-output)
- [Config fields](#config-fields)
- [Start-receipt gate](#start-receipt-gate)
- [Reporting contract](#reporting-contract)
- [Environment preflight](#environment-preflight)
- [Claude credential injection](#claude-credential-injection)
- [Permission decisions](#permission-decisions)
- [Event identity](#event-identity)
- [Evidence boundary](#evidence-boundary)
- [Stable exits](#stable-exits)
- [Process liveness](#process-liveness)
- [Host wait boundaries](#host-wait-boundaries)
- [Cancellation](#cancellation)
- [Non-goals](#non-goals)

## Required capabilities

Run on Node.js 22.13 or newer. The Claude canonical launcher `claude-acp-launcher.mjs` additionally requires a runtime with POSIX `process.execve`: Node.js 22.15 or newer within the 22.x line, 23.11 or newer within the 23.x line, or any later release line (24+). Node.js 23.0–23.10 is newer than 22.15 but lacks `process.execve`. The launcher is POSIX-only — `process.execve` does not exist on Windows. Support is capability-detected: any runtime or platform without a `process.execve` function fails closed with `execve_unsupported`.

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

- `agent`: ACP agent name. ACPX normalizes agent names with trim/lowercase, so a spelling such as `Claude` would still resolve to the Claude adapter while bypassing every exact-match gate; any spelling that normalizes to `claude` other than the canonical lowercase value is rejected as `invalid_agent_not_canonical`
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
- `reporting`: mandatory `acp-reporting-v1` public reporting bundle bound to the control conversation and the lifecycle receipt; see [Reporting contract](#reporting-contract)
- `auth` (required exactly when `agent` is `claude`): Claude credential declaration
  - `auth.kind`: must be `claude-setup-token-env-file`
  - `auth.envFile`: absolute path to the private setup-token env file

Declaring `auth` on a non-Claude agent is invalid config (`invalid_auth_agent`): the profile would never be enforced there, so it is rejected rather than silently ignored. A Claude config whose `requiredEnv` or `forbiddenEnv` contradicts the automatic Claude credential contract fails with `invalid_env_contract_overlap`. Shape violations map to `invalid_auth`, `invalid_auth_kind`, `invalid_auth_env_file`, and `invalid_auth_env_file_not_absolute` with the invalid-config exit.

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

## Reporting contract

`reporting` is required. It is the generic mandatory reporting safety contract, schema `acp-reporting-v1`: before dispatch, the caller must have sent one public round-start boundary message to the control conversation and created exactly one disabled public-only watchdog for the round, and the config must carry a byte-exact snapshot of both. The contract is validated purely and deterministically — no I/O, no clock access, no randomness — implemented in `scripts/acp-reporting-contract.mjs`.

Ordering is pre-runtime: the bundle is validated during config loading, after every structural field it binds to (`model`, `lifecycle`) is already trusted, and before dynamic runtime import, runtime probing, `createAcpRuntime`, or any adapter startup. A missing or malformed bundle is invalid config and maps to a stable bounded `invalid_reporting_*` code with the invalid-config exit: `invalid_reporting_root`, `invalid_reporting_unknown_key`, `invalid_reporting_schema_version`, `invalid_reporting_round_index`, `invalid_reporting_repository`, `invalid_reporting_branch`, `invalid_reporting_start_message`, `invalid_reporting_destination`, `invalid_reporting_start_receipt`, `invalid_reporting_watchdog`, `invalid_reporting_watchdog_round`, `invalid_reporting_watchdog_schedule`, `invalid_reporting_watchdog_delivery`, `invalid_reporting_watchdog_payload`, `invalid_reporting_watchdog_message`, `invalid_reporting_report`, `invalid_reporting_forbidden_content`, and `invalid_reporting_context`. Error messages name at most a config key or a forbidden-pattern label; they never echo the rejected payload, a secret, or free text.

Start-message binding is caller-attested, like the start-receipt gate. `reporting.startReceipt` must byte-match the lifecycle receipt — same `conversationId`, same `messageId`, and the same `deliveredAt` spelling as written in `lifecycle.startReceipt` — and `reporting.startReceipt.message` must equal `reporting.startMessage`, so the attested delivery is bound to exact public content, not just to an identifier. `startDestination`, `watchdogDestination`, and `terminalDestination` must all equal `lifecycle.controlConversationId`: every reporting surface for the run is the one control conversation. The supervisor holds no chat credentials and makes no network call, so it cannot prove the message was actually delivered or that the watchdog actually exists in a scheduler; it proves the caller committed to specific, template-exact public content bound to the same recent control-conversation receipt that gates the run.

The public message formats are fixed, not advisory. `startMessage` must match the 13-line round-start template exactly (round 1 uses the `ACP 작업 시작` title; correction rounds use the `ACP 수정 라운드 N 시작` title), embedding the config's `model`, the declared `repository` basename, and the declared Git `branch` verbatim. The watchdog snapshot must be exactly tool-less and public-only: `enabled: false`, `sessionTarget: "isolated"`, `schedule` exactly `{ "kind": "every", "everyMs": 600000 }`, delivery exactly a Discord announce to the control conversation channel, `deleteAfterRun: false`, `payload.kind: "agentTurn"`, `payload.toolsAllow` present and exactly `[]`, and an integer `payload.timeoutSeconds` of at most 60. The payload message is exactly the minimal verbatim relay instruction, one blank line, and one delimited 19-line public `ACP 중간 보고` report (22 lines with the optional trailing 이슈 section) whose metadata lines repeat the same model, repository, branch, and round. A bounded forbidden-content screen rejects operational or internal material in the watchdog message — filesystem paths, shell and Git commands, process or session inspection, scheduler internals, and any silence/self-decision instruction — with `invalid_reporting_forbidden_content`.

The fixed schema is generic and public: templates, cadence, routing shape, and screening are defined here and in the validator, with Korean public report layouts as the canonical wording. Organization-specific material stays outside the schema: actual channel identifiers, operator identity, and run-specific wording appear only inside the bounded free-text slots (the 범위 and 외부 작업 bullets, the section bullets, the elapsed-time and 실행 상태 lines) or as caller-substituted placeholder values, and none of it is emitted in normalized events.

## Environment preflight

`requiredEnv` and `forbiddenEnv` declare a generic caller-side environment contract. Each list is optional and bounded to 32 portable environment-variable names of at most 64 characters each, matching `[A-Za-z_][A-Za-z0-9_]*`. Contract-name identity is case-insensitive on every platform: Windows `process.env` lookups ignore case, so a case-conditional rule would make the same config mean different things per platform. Names that differ only by case are duplicates within a list, and required/forbidden overlap is judged case-insensitively. The caller's original spelling is preserved for environment lookup and for the sanitized failure codes. Shape violations are invalid config and keep the invalid-config exit mapping.

Before dynamic runtime import, runtime probing, `createAcpRuntime`, or any adapter startup, the supervisor fails closed when a required variable is absent or empty, or when a forbidden variable is non-empty. The stable failure codes name only the caller-declared variable — `required_env_missing:NAME`, `required_env_empty:NAME`, `forbidden_env_present:NAME` — and map to the supervisor error exit. Environment values are never emitted, stored, hashed, or otherwise disclosed.

The gate proves presence or absence only. It does not prove how a variable was injected, validate credential files, or select a credential source. For non-Claude agents this generic contract is the whole environment gate. For `agent: "claude"`, credential-specific policy is canonical and supervisor-enforced; see [Claude credential injection](#claude-credential-injection).

## Claude credential injection

Claude runs authenticate with a setup token whose value is never disclosed: it does not appear in argv, config values, normalized events, error text, or logs, and no hash, prefix, suffix, or exact length of it is ever emitted. The config declares only a pointer: `auth.kind` fixed to `claude-setup-token-env-file` and an absolute `auth.envFile`.

The canonical route is `scripts/claude-acp-launcher.mjs --config <config>`. The launcher checks, in order:

1. CLI and config shape: it accepts exactly the same single private config-path argument as the supervisor and requires the canonical `agent: "claude"` (`launcher_agent_not_claude` for other agents, `invalid_agent_not_canonical` for a non-canonical Claude spelling; invalid-config exit).
2. Runtime support: a runtime or platform without a `process.execve` function fails `execve_unsupported`. This is checked before any environment or file inspection, so Windows and Node lines without execve always fail with this one code.
3. Clean-baseline parent environment; nothing is silently unset, the operator must remove offending variables explicitly:
   - a pre-existing `CLAUDE_CODE_OAUTH_TOKEN` — even empty — fails `claude_oauth_token_preexisting`;
   - any non-empty `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, or `CLAUDE_CODE_USE_FOUNDRY` fails `claude_competing_credential:NAME`;
   - any non-empty injection-capable variable fails `claude_env_injection_capable:NAME`. These are variables that could preload code into, redirect, or reconfigure the token-bearing supervisor image without appearing in its exec-argv proof: `NODE_OPTIONS` (`--require`/`--import` preloads), `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`, the dynamic-linker preloads `LD_PRELOAD`, `LD_AUDIT`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `DYLD_FRAMEWORK_PATH`, the Anthropic endpoint/header/config selectors `ANTHROPIC_BASE_URL`, `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_SKIP_BEDROCK_AUTH`, `CLAUDE_CODE_SKIP_VERTEX_AUTH`, `CLAUDE_CONFIG_DIR`, and the proxy selectors `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` in both upper- and lowercase spellings.
4. Env-file validation (below).
5. Exec-target pre-checks: a missing or non-executable Node binary fails `launcher_exec_target_missing`; a missing or unreadable supervisor file fails `launcher_supervisor_missing`.
6. The re-exec itself: the launcher replaces its own process image with POSIX `process.execve`, running `node --env-file=<auth.envFile> acpx-foreground-supervisor.mjs --config <config>` under the same PID, so no child wrapper or second tracked process ever exists.

Launcher failure contract: a failing `process.execve` raises a catchable system error in-process (it does not abort), which the launcher maps to the bounded code `execve_failed:<ERRNO>`. `execve_returned` is reachable only if an injected execve dependency returns instead of replacing the image or throwing. If the env file disappears between validation and the exec, the re-exec still succeeds and the replaced Node process fails its own `--env-file` startup parsing, exiting nonzero under the same PID before any supervisor code runs — fail-closed, with no launcher event, because the launcher image no longer exists at that point.

Launcher events: on failure the launcher emits exactly one `launcher_error` event — `{ schemaVersion, type: "launcher_error", code }` — and then exits. Unlike supervisor events it carries no run ID, request ID, sequence, timestamp, or elapsed time: no run identity exists before the supervisor starts, and the launcher never emits more than one event. CLI-usage and config-shape codes (`usage`, `invalid_*`, `launcher_agent_not_claude`) map to exit `64`; every later failure (`execve_unsupported`, `claude_oauth_token_preexisting`, `claude_competing_credential:NAME`, `claude_env_injection_capable:NAME`, `claude_env_file_*`, `launcher_exec_target_missing`, `launcher_supervisor_missing`, `execve_failed:<ERRNO>`, `execve_returned`) maps to exit `22`. On success the launcher emits nothing; the supervisor's `started` event is the first output of the same PID.

Env-file validation is shared by the launcher and the supervisor and fails closed on: a parent directory that is a symlink, not owner-owned, or not mode `0700`; a path that is a symlink (`claude_env_file_symlink`) or any non-regular file such as a FIFO or device (`claude_env_file_not_regular`, checked with `lstat` before open so a FIFO cannot block the validator); a file not owner-owned, not mode `0600`, empty, or oversized; and content that is not exactly one `CLAUDE_CODE_OAUTH_TOKEN=<value>` assignment with an optional final newline — no comments, quotes, interpolation, whitespace, extra variables, or multiline values. Filesystem errors on the env-file path map to distinct bounded codes: `claude_env_file_open_denied` (EACCES/EPERM), `claude_env_file_parent_not_directory` (ENOTDIR), `claude_env_file_symlink` (ELOOP/EMLINK), `claude_env_file_missing` (ENOENT), and otherwise the generic `claude_env_file_open_failed`. Failure codes (`claude_env_file_*`) never include the path, the file content, the token, a token hash, prefix, suffix, or the exact token length.

The supervisor independently re-asserts the same route before dynamic runtime import, probing, or adapter startup, so bypassing the launcher fails closed with the supervisor policy exit:

- any spelling that ACPX would normalize to `claude` other than the canonical value fails `claude_agent_not_canonical` even for configs assembled in memory; canonical `agent: "claude"` requires the auth profile (`claude_auth_missing`); an auth profile on another agent fails (`claude_auth_not_applicable`);
- `process.execArgv` must contain exactly one Node option, the exact spelling `--env-file=<auth.envFile>`; an absent or empty exec argv is a bare launch and fails `claude_env_file_option_missing`; every other shape — a split `--env-file <path>` pair, an `-if-exists` variant, a relative or different path, a duplicate, or any extra Node option — fails `claude_env_file_option_mismatch`;
- the Claude credential contract — `CLAUDE_CODE_OAUTH_TOKEN` required; the competing credential selectors and every injection-capable variable listed above forbidden — is enforced automatically even when `requiredEnv` and `forbiddenEnv` are empty, with the same `required_env_missing`/`required_env_empty`/`forbidden_env_present` codes. A Claude config whose `requiredEnv` names any of these automatically forbidden variables is rejected at load time with `invalid_env_contract_overlap`;
- the env file is validated again and the loaded environment value is compared against the file assignment through fixed-size digests computed in memory and never emitted; a difference fails `claude_env_token_source_mismatch` without disclosing either value.

The digest comparison binds the loaded token value to the declared env file; it does not prove that the canonical launcher performed the injection, only that this process was started with the exact `--env-file` argv shape and that its token matches the declared file. What makes the route canonical is that every direct launch without that exact shape fails closed before runtime loading.

These are supervisor policy failures with exit `22`, evaluated before runtime loading. Invalid config shape remains exit `64`. Non-Claude agents are unaffected: they keep the generic environment contract and need no exec-argv proof.

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
- leave the watchdog interval, destination routing, or public message templates caller-defined — the [Reporting contract](#reporting-contract) fixes them generically, and only the bounded free-text slots plus the actual (organization-private) channel identifiers vary per run;
- prove that the attested start message or watchdog snapshot exists outside the config;
- define host-specific stale-session detection or recovery;
- make an official ACP child thread observable by the direct supervisor.
