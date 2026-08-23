# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
node --test acp-discord-orchestrator/scripts/test-acpx-foreground-supervisor.mjs
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

A single ESM file, `scripts/acpx-foreground-supervisor.mjs`, that runs one ACPX turn in the foreground on behalf of an agent and emits newline-delimited JSON events, plus `scripts/claude-acp-launcher.mjs`, the canonical launcher that validates Claude setup-token auth and re-execs into the supervisor via `process.execve`. `references/runtime-contract.md` is the normative spec (config fields, exit codes `0/20/21/22/64`, permission rejection rules, start-receipt/env/Claude-credential preflight gates, evidence boundary); SKILL.md is the operator-facing summary. Keep all of them (code, contract, SKILL.md) in sync when changing behavior.

- The module exports its internals (`loadSupervisorConfig`, `runSupervisor`, `buildPermissionHandler`, `normalizeRuntimeEvent`, `runStartReceiptPreflight`, `EXIT_CODES`, `main`, …) specifically so the sibling test file can unit-test them with an in-memory mock runtime module. `tests/acp-discord-orchestrator-cli.test.mjs` at the repo root spawns the real CLI against a mock runtime file to assert the process actually exits.
- Everything is fail-closed and evidence-minimal: no raw prompt/model/tool text in events, no env values or conversation IDs leaked, distinct `completed`/`cancelled`/`failed` never collapsed. Preserve these properties when adding features — tests assert them.
- Requires Node ≥ 22.13 and ACPX ≥ 0.11.2 (capability-detected, not version-string gated). The Claude launcher additionally needs `process.execve` — Node 22.15+ in the 22.x line, 23.11+ in the 23.x line, or any later line — and is POSIX-only.

## Repo conventions

- This is a **public** repo. Per `docs/tistory-cdp-architecture.md`, never commit production account names, credential paths, cron identifiers, browser profile locations, or account→blog maps; those belong in private wrappers. Deployment targets (`--blog`, `--category`, `--cdp-port`) are passed in by the caller, not hardcoded (the `mk-review` preset defaults are the one intentional exception).
- Published skills get scanned by OpenClaw/VirusTotal; past flags (CHANGELOG v5.0.x–v5.1.x) were `child_process.execSync`, a base64/`atob` canvas-drop fallback, credential handling inside the publish script, and undeclared `runtime`/`credentials` frontmatter. Keep credential handling confined to `login.sh` and declare new runtimes/credentials in SKILL.md frontmatter.
- Commit style: conventional prefixes scoped by skill, e.g. `fix(tistory-publish): …`, `feat(acp-discord-orchestrator): …`, `docs(...)`, `ci(...)`. Branches are `fix/…`, `feat/…`, `chore/…`, `ci/…` merged to `main` via PR.
