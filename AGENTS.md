# AGENTS.md

This file provides shared guidance to coding agents (Claude Code, Codex, and any other assistant) working with code in this repository. `CLAUDE.md` is a compatibility entrypoint that points here; keep this file as the single source of repository guidance.

## What this repo is

A public collection of independent [OpenClaw](https://github.com/openclaw/openclaw) skills maintained by Garibong Labs. Each top-level directory is one self-contained skill that gets copied into an OpenClaw workspace. There is no root build system, package.json, or shared library — skills share nothing but conventions.

Every skill has a `SKILL.md` with YAML frontmatter (`name`, `description`, optionally `metadata.openclaw.requires/triggers`, `runtime`, `credentials`). The frontmatter is read by OpenClaw and by its security scanner; `runtime`/`credentials` declarations exist because the scanner flagged undeclared credential use (see `tistory-publish/CHANGELOG.md` v5.1.x).

Most skills are a single stdlib-only Python script (`ipo-alert`, `olympic-alert`, `daum-trends`, `music-preference-reco`, `seoul-subway-crowd`, `nano-banana-pro`) or Node script (`brave-api-setup`) with no tests. The two substantial, tested skills are `tistory-publish` and `acp-discord-orchestrator`. Docs in `tistory-publish/` are written in Korean; keep that style when editing them.

## Commands

No install step. Local versions in use: Python 3.13, Node 24. CI (`.github/workflows/tistory-publish-ci.yml`) only covers `tistory-publish`, path-scoped, on **Python 3.9 and 3.13** and Node 24 — keep `tistory-publish` Python compatible with 3.9.

```bash
# tistory-publish — Python unit tests (CI command)
python3 -m unittest discover -s tistory-publish/tests -p "test_*.py" -v
# single file / single test (substring match on test name)
python3 -m unittest tistory-publish/tests/test_publish_post_upload.py
python3 -m unittest tistory-publish/tests/test_publish_post_upload.py -k file_chooser

# tistory-publish — JS helper tests (plain assert script, no runner)
node tistory-publish/tests/test_tistory_editor_helpers.js

# tistory-publish — syntax checks run in CI
python3 -m py_compile tistory-publish/scripts/*.py
node --check tistory-publish/scripts/tistory-editor-helpers.js
node --check tistory-publish/scripts/tistory-publish.js
bash -n tistory-publish/scripts/login.sh tistory-publish/scripts/publish-post.sh tistory-publish/scripts/publish.sh

# acp-discord-orchestrator — node:test suites (not in CI; run manually)
node --test acp-discord-orchestrator/scripts/test-acp-reporting-contract.mjs
node --test acp-discord-orchestrator/scripts/test-acp-host-transport.mjs
node --test acp-discord-orchestrator/scripts/test-acp-report-pump.mjs
node --test acp-discord-orchestrator/scripts/test-acpx-foreground-supervisor.mjs
node --test acp-discord-orchestrator/scripts/test-acpx-runtime-preflight.mjs
node --test acp-discord-orchestrator/scripts/test-claude-acp-launcher.mjs
node --test tests/acp-discord-orchestrator-cli.test.mjs
node --test --test-name-pattern="distinct exit codes" acp-discord-orchestrator/scripts/test-acpx-foreground-supervisor.mjs
```

The launcher suite's execve end-to-end tests self-skip on runtimes without `process.execve` (needs 22.15+/23.11+ or any later line; POSIX only) — run it on a runtime that has it for full coverage.

## tistory-publish architecture

Browser automation of the Tistory editor via Playwright attached to an existing Chrome over CDP (Tistory's Open API is dead). The pieces:

- `scripts/publish-post.sh` — the **current** orchestrator (~2300 lines). It is a bash wrapper that parses args / applies template presets (`mk-review`, `daum-trends`, `simple-post`), then runs one large Python Playwright program embedded in a `<< 'PYTHON_SCRIPT'` heredoc. The Python program opens `/manage/newpost`, injects the JS helper with `page.add_script_tag(path=HELPER_JS)`, and drives the editor step by step (category/title → body → inline images → banner → OG cards → representative image → tags → duplicate preflight → publish → post-publish verification). Last stdout line is a JSON result (`{"success":..., "postUrl":...}`); non-zero exit on failure.
- `scripts/tistory-editor-helpers.js` — the **current** in-page helper (TinyMCE insertion, OG placeholder handling, tags, image alt/representative image). Functions are called from Python via `page.evaluate`.
- `scripts/publish.sh` + `scripts/tistory-publish.js` — **legacy** pipeline kept for compatibility. Helper changes have historically been mirrored into both JS files (see CHANGELOG); when adding a helper function, check whether the legacy file needs the same change.
- `scripts/login.sh` — the only script allowed to touch Kakao credentials (`--cred-file` / `TISTORY_CRED_FILE`). `publish-post.sh` never reads credentials; it shells out to `login.sh` (forwarding `--blog` and `--cdp-port`) when it lands on a login redirect.
- `scripts/seo_check.py` — standalone pre-publish static SEO check, wired in via `--seo-check off|warn|strict`.

Behavioral invariants worth knowing before changing it:

- `ALLOW_DIRECT_TISTORY_PUBLISH=1` must be set or `publish-post.sh` refuses to run — it is meant to be invoked from a private wrapper, not directly.
- The code is deliberately **fail-closed**: OG-card retries/fallbacks only trigger on exactly-classified `/manage/scrap` responses (confirmed `40002` → DCInside mobile/desktop pair; confirmed `500`+`40009` → Daum next-article candidate from `data-og-fallback-urls`); unknown/unparsed responses abort. `daum-trends` representative image must be the first non-comic inline image or the publish aborts. Don't loosen these into "try something else" fallbacks.
- A per-blog (or per-CDP-port) `fcntl.flock` lock at `/tmp/tistory-publish-{key}.lock` serializes concurrent publishes; duplicate-title preflight queries RSS + manage list before clicking publish.
- Body HTML contract: `<p data-ke-size="size16">`, OG placeholders `<p data-og-placeholder="URL">&#8203;</p>`, image markers `<p data-image-marker="...">`, Tistory `<hr data-ke-type="horizontalRule">`.

**How the tests work (this shapes how you write code):**

- Python tests do not run the shell script. They regex the embedded heredoc out of `publish-post.sh` (`<< 'PYTHON_SCRIPT' ... PYTHON_SCRIPT`), `ast.parse` it, pick named top-level `def`s, and `exec` them into a namespace seeded with fakes (`FakePage`, `FakeTime`, etc.). So embedded helpers must be **module-level functions** whose collaborators (`page`, `time`, `log`, `fail`, `re`, …) are resolvable by name from the namespace — no hidden closures or module-import side effects.
- JS tests load `tistory-editor-helpers.js` into a `node:vm` sandbox with a minimal fake `window`/`document` and then append `this.__helpers = { ... }` to export specific functions. A new helper is only testable if you add it to that export list in `tests/test_tistory_editor_helpers.js`.
- `tistory-publish/CHANGELOG.md` has an `## Unreleased` section — add an entry for any behavior change.

## acp-discord-orchestrator architecture

Core ESM modules under `scripts/`:

- `acpx-foreground-supervisor.mjs` — runs one ACPX turn in the foreground on behalf of an agent and emits newline-delimited JSON events. It owns the centralized closed-set agent gate (`assertCanonicalSupportedAgent`: `invalid_agent_unsupported` / `invalid_agent_not_canonical`, enforced first both in the config loader — before any unrelated filesystem I/O — and in the in-memory `runSupervisor` path, symmetric between claude and codex), the agent-neutral process-integrity env baseline (`ACP_INJECTION_ENV`: Node module/preload, dynamic-linker, and proxy selectors) that every supported agent gets automatically before runtime import, and the local-commit-only permission boundary that rejects opaque execute requests plus direct remote Git/repository-hosting actions before approval; `CLAUDE_INJECTION_ENV` layers the Anthropic-specific selectors (`CLAUDE_PROVIDER_INJECTION_ENV`) on top for Claude only.
- `acp-reporting-contract.mjs` — the pure reporting-contract validator and canonical start/intermediate/terminal message builder. Current schema `acp-reporting-v3`, whose enabled `reportPump` attestation (id/round/cadence/routing only, deliberately no payload) supersedes the disabled static-snapshot watchdog; `acp-reporting-v2` (watchdog shape) stays accepted for already-prepared configs, and the legacy `acp-reporting-v1` shape is accepted only for canonical agent `claude` during a bounded migration and is rejected for every other agent. It owns the closed, fail-closed agent presentation mapping (`claude` → `Claude Code`, `codex` → `Codex`): the public harness label on reporting templates is derived from the canonical config `agent`, never from caller data, and `invalid_reporting_agent` remains its own boundary code when the validator is invoked directly or a v2 bundle's `agent` attestation mismatches. All three builders allow omitted model only for Claude (`runtime-default`); non-Claude reports require the explicit effective model and cannot claim that label.
- `acpx-runtime-preflight.mjs` and `acpx-runtime-preflight-cli.mjs` — the canonical machine-enforced runtime-module preflight. The `attest` action consumes the raw stdout JSON of `openclaw plugins info acpx --json` directly (saved unmodified to an owner-private file, never reshaped by the caller), uniquely selects the `plugin.dependencyStatus.dependencies` entry named exactly `acpx` (rejecting missing/duplicate exact matches, relative or malformed paths, the active plugin package root bound from the raw `plugin.rootDir` — plus `install.installPath` when present — and any raw-schema drift including the legacy synthetic top-level `dependencies` shape; the `@openclaw/acpx` manifest-name gate stays as defense in depth), validates the package (name, ACPX ≥ 0.11.2 release version, real `dist/runtime.js`, and the authoritative `createAcpRuntime`/`createRuntimeStore`/`createAgentRegistry` capability exports), and writes an owner-private digest-bound attestation (`acpx-runtime-attestation.v1`). The `assemble` action re-verifies that attestation fail-closed (absent/stale/mismatched/invalid) and writes the final supervisor config with the attested `runtimeModule`, replacing the template sentinel `RUNTIME_MODULE_FROM_PREFLIGHT` — callers never hand-copy or choose `runtimeModule`; already-prepared configs with a validated absolute path stay valid. Bounded stable codes only; no path or plugin-info payload is ever echoed.
- `acp-private-json-input.mjs`, `acp-start-message-cli.mjs`, and `acp-report-message-cli.mjs` — the shared owner-private JSON reader plus operator message builders. The reader stats and reads one normalized path, distinguishes missing/unreadable/empty/oversized/invalid JSON, and the CLIs emit only canonical public content or one bounded error event.
- `acp-host-transport.mjs`, `acp-host-transport-cli.mjs`, and `acp-host-transport-runner.mjs` — the POSIX/tmux production host transport (schema `acp-host-transport.v2`; v1 records/inputs fail closed). A private `prepare` call creates one detached-but-owned tmux session and returns its exact handle before activation; a separate `activate` call writes the activation record into that exact PTY. `status`, `claim-report`, `begin-delivery`, `ack-report`, `cancel`, and `reconcile` use only the retained transport record and handle. Every record mutation runs under an exclusive sibling lease file with bounded wait and stale-only takeover (atomic sibling-temp rename prevents torn files but is never the serialization), and a monotonic publication fence orders claims across calls. `status` is observation-only; `claim-report` is the single obligation-minting path (bound to the exact pump job identity and destination, with bounded attempts, explicit claim_acquired/delivery_pending/acknowledged/uncertain/missing delivery states, and a permanent `tracking_lost` publication halt for a dead session without evidence); acknowledgements require the exact fenced attempt identity, re-derive canonical report content from stored reporting identity, and verify its SHA-256 attestation before publication can close.
- `acp-lifecycle-ledger.mjs` — the host-activation and owner-private lifecycle ledger contract. It parses the one exact-handle stdin activation record, keeps ACP runtime mutation behind that gate, stores bounded last-event/terminal-intent evidence, and reconciles either a mapped process exit or stable `tracking_lost` without exposing the handle. Repeated reconciliation re-verifies the current handle/outcome/exit evidence. End-to-end completion requires normalized terminal evidence, mapped exit, canonical terminal receipt acknowledgement, and private-ledger reconciliation; the transport never closes the ledger before that acknowledgement.
- `acp-report-pump.mjs` — the coreless report-pump entry an enabled every-600000-ms OpenClaw automation runs per exact ACP handle. Each invocation binds one opaque run token plus the exact transport file/handle/destination/job identity, performs one `claim-report` → canonical fresh message derivation (live claim data plus an optional bounded owner snapshot; never a replayed static report) → `begin-delivery` cycle, and prints one bounded result (message, digest, attempt identity) for the delivery layer to send and `ack-report`. `none_due`/`terminal_acked`/`tracking_lost` pass through so the automation idles, self-deletes, or stops permanently without relaunching ACP.
- `acp-lifecycle-reconcile-cli.mjs` — the operator CLI that reads one private JSON reconciliation input and updates the private lifecycle ledger after the exact tracked host handle exits or is confirmed lost. It emits only a bounded reconciliation result/error and never echoes paths or handles.
- `claude-acp-launcher.mjs` — the canonical **Claude-specific** launcher that validates Claude setup-token auth and re-execs into the supervisor via `process.execve`. Codex (and any future non-Claude agent) runs the supervisor directly and declares credentials through the generic `requiredEnv`/`forbiddenEnv` contract; genuinely Claude-provider-specific names (setup-token launcher, `CLAUDE_CODE_OAUTH_TOKEN`, the `claude-setup-token-env-file` auth profile, `claude_*` failure codes) stay Claude-named on purpose.

`references/runtime-contract.md` is the normative spec (config fields, exit codes `0/20/21/22/64`, permission rejection rules, start-receipt/reporting/env/Claude-credential preflight gates, evidence boundary); SKILL.md is the operator-facing summary; `templates/supervisor-config.json` is the agent-neutral config template and `templates/claude-auth-profile.json` the provider-specific Claude auth profile. Keep all of them (code, contract, SKILL.md, templates) in sync when changing behavior.

- The supervisor module exports its internals (`loadSupervisorConfig`, `runSupervisor`, `buildPermissionHandler`, `normalizeRuntimeEvent`, `runStartReceiptPreflight`, `runReportingPreflight`, `EXIT_CODES`, `main`, …) specifically so the sibling test file can unit-test them with an in-memory mock runtime module. `tests/acp-discord-orchestrator-cli.test.mjs` at the repo root spawns the real CLI against a mock runtime file to assert the process actually exits. `scripts/acp-reporting-test-fixture.mjs` is the shared integration fixture (parameterized by agent and schema version); the standalone contract suite deliberately keeps its templates literal instead.
- Everything is fail-closed and evidence-minimal: no raw prompt/model/tool text in events, no env values or conversation IDs leaked, distinct `completed`/`cancelled`/`failed` never collapsed, and the public agent label never caller-chosen. Preserve these properties when adding features — tests assert them.
- Requires Node ≥ 22.13 and ACPX ≥ 0.11.2 (capability-detected, not version-string gated). The production host transport is POSIX-only and requires tmux plus the executable system `/usr/bin/env` used to clear tmux-server environment residue. The Claude launcher additionally needs `process.execve` — Node 22.15+ in the 22.x line, 23.11+ in the 23.x line, or any later line.
- A separate local Skill Workshop proposal named `acp-agent-auth` is planned for provider-specific auth of additional agents (e.g. Codex); until it lands, do not add non-Claude auth profiles to this skill.

## Repo conventions

- This is a **public** repo. Per `docs/tistory-cdp-architecture.md`, never commit production account names, credential paths, cron identifiers, browser profile locations, or account→blog maps; those belong in private wrappers. Deployment targets (`--blog`, `--category`, `--cdp-port`) are passed in by the caller, not hardcoded (the `mk-review` preset defaults are the one intentional exception).
- Published skills get scanned by OpenClaw/VirusTotal; past flags (CHANGELOG v5.0.x–v5.1.x) were `child_process.execSync`, a base64/`atob` canvas-drop fallback, credential handling inside the publish script, and undeclared `runtime`/`credentials` frontmatter. Keep credential handling confined to `login.sh` and declare new runtimes/credentials in SKILL.md frontmatter.
- Commit style: conventional prefixes scoped by skill, e.g. `fix(tistory-publish): …`, `feat(acp-discord-orchestrator): …`, `docs(...)`, `ci(...)`. Branches are `fix/…`, `feat/…`, `chore/…`, `ci/…` merged to `main` via PR.
