# openclaw-skills

A collection of [OpenClaw](https://github.com/openclaw/openclaw) skills built and maintained by [Garibong Labs](https://github.com/garibong-labs).

## What this repo is

This repository contains reusable OpenClaw skills for agent workflows that need documented setup steps, repeatable commands, and clear operational guardrails.

Each skill is designed to be copied into an OpenClaw workspace and used by agents or maintainers as a focused tool for one recurring job, such as API setup, alerts, publishing support, or image generation.

## Who uses it

The skills are intended for OpenClaw users, agent maintainers, and small teams that want to turn repeated manual workflows into shareable, reviewable automation.

Garibong Labs uses this repository to maintain public skills that can be reviewed, improved, and reused outside a single private workspace.

## Why Codex and API credits help

This project benefits from Codex for pull request review, regression checks, documentation updates, and security-oriented review of automation scripts.

Many skills interact with browsers, local configuration, or external services. Codex helps maintainers inspect changes, catch unsafe assumptions, and keep high-risk operational code small and auditable.

## Maintenance cadence

Maintenance is driven by real OpenClaw workflow issues and pull requests. Changes are reviewed as small, focused updates with verification notes in the PR when a skill script or workflow behavior changes.

## Skills

### Publishing & orchestration

#### ✍️ [tistory-publish](./tistory-publish)

Automates Tistory blog publishing through Playwright attached to OpenClaw's Chrome over CDP — the only automation path since the Tistory Open API shut down (Feb 2024).

Handles TinyMCE body insertion, category and tag setting, inline image and banner upload, OG card rendering, representative image selection, duplicate-title preflight, an optional pre-publish SEO check, and a per-blog publish lock. Ships template presets (`mk-review`, `daum-trends`, `simple-post`) and a Kakao login session-recovery script. Fails closed on anything it cannot verify, and refuses to run unless `ALLOW_DIRECT_TISTORY_PUBLISH=1` is set by an approved wrapper.

**Use when:** You want an agent or cron job to publish HTML posts to a Tistory blog end-to-end and get a JSON result with the post URL.

---

#### 🛰️ [acp-discord-orchestrator](./acp-discord-orchestrator)

Runs each agent-started ACP task as a single foreground ACPX turn under a supervisor that emits newline-delimited JSON events (`started`, `activity`, `progress`, `terminal`) back to the current Discord conversation. Agent-neutral within a closed supported set: ACP agent `claude` (presented publicly as `Claude Code`, with a canonical setup-token launcher) and ACP agent `codex` (presented publicly as `Codex`); the public harness label is bound to the canonical config agent and cannot be chosen or spoofed by the caller.

Fails closed on a missing or stale start receipt, an unsupported or non-canonical agent (rejected first, before any unrelated file access), a reporting bundle that does not match the exact public templates, unmet environment contracts — including an implicit agent-neutral process-integrity baseline that forbids `NODE_OPTIONS`-style injection, dynamic-linker preload, and proxy selectors for every supported agent — incompatible ACPX capabilities, detached/background execution, or tool kinds outside the allowlist. Keeps `completed`, `cancelled`, and `failed` as distinct exit codes and never collapses them into success. The normative behavior is spelled out in [references/runtime-contract.md](./acp-discord-orchestrator/references/runtime-contract.md).

**Use when:** An agent needs to delegate work to ACP from Discord with observable, bounded completion instead of an untracked spawn or child thread.

---

### Alerts & monitoring

#### 📈 [ipo-alert](./ipo-alert)

Monitors Korean IPO (공모주) subscription and listing schedules from [38.co.kr](https://www.38.co.kr).

Sends alerts on D-1 and day-of for both subscription opens and new listings. Supports daily checks and weekly summaries. Zero external dependencies — pure Python standard library.

**Use when:** You want to be notified about upcoming Korean IPO subscriptions or new stock listings.

---

#### 🏅 [olympic-alert](./olympic-alert)

Sends alerts 15 minutes before Olympic events. Ships with a default schedule for Team Korea at the 2026 Milano Winter Olympics, but works for any country or sporting event.

Supports adding/removing events via CLI, and tracks sent alerts to prevent duplicates.

**Use when:** You want timely reminders before live sports events.

---

#### 📊 [daum-trends](./daum-trends)

Extracts the Daum real-time trending TOP10 keywords with one representative news headline each, formatted for Telegram/Discord delivery. Pure Python standard library; designed to run hourly from an OpenClaw cron.

**Use when:** You want a Korean real-time search-trend briefing (실시간 검색어) on a schedule or on demand.

---

#### 🚇 [seoul-subway-crowd](./seoul-subway-crowd)

Queries Seoul subway train-level and car-by-car congestion via the SK Open API (TMAP 대중교통) by station, line, direction, day-of-week, and hour, and returns a short Korean summary. Endpoint and parameter mappings live in `references/api-map.md`.

**Use when:** You want congestion checks, time-slot comparisons, or commute alerts for a Seoul subway station.

---

### Setup & integrations

#### 🔍 [brave-api-setup](./brave-api-setup)

Automates Brave Search API key setup for OpenClaw's `web_search` tool.

Extracts the API key via browser JavaScript (no LLM transcription errors) and applies it directly to the OpenClaw config.

**Use when:** You need to enable web search, configure the Brave API, or fix a `missing_brave_api_key` error.

---

#### 🎓 [ku-portal](./ku-portal)

Queries the Korea University KUPID portal — notices, academic calendar, scholarship notices, library seat availability, timetable (with ICS export), enrolled courses, and Canvas LMS data — by wrapping the [`ku-portal-mcp`](https://github.com/SonAIengine/ku-portal-mcp) package as a Python library. Includes `scripts/setup.sh` for venv and dependency setup.

**Use when:** You want an agent to answer KUPID/LMS questions for a Korea University account.

---

#### 🍌 [nano-banana-pro](./nano-banana-pro)

Generates or edits images with Google's Nano Banana Pro (Gemini 3 Pro Image): text-to-image and image-to-image at 1K/2K/4K. Runs via `uv run` with inline script dependencies. This is a paid route — the skill instructs agents to use it only when explicitly requested or approved.

**Use when:** A user explicitly asks for Nano Banana / Gemini image generation or editing.

---

#### 🎵 [music-preference-reco](./music-preference-reco)

Stores a user's favorite artists and tracks in a persistent JSON taste profile and recommends songs from it using the Apple iTunes Search API (no key required), with links for YouTube, Spotify, or Apple Music.

**Use when:** A user mentions music they like, asks you to remember their taste, or wants recommendations based on saved favorites.

## Installation

Each skill lives in its own directory. To install, copy the skill directory into your OpenClaw workspace skills folder and add it to your agent's skill list.

Refer to each skill's `SKILL.md` for detailed setup instructions and usage examples. Skills with non-trivial setup (`tistory-publish`, `acp-discord-orchestrator`, `ku-portal`) also document their runtime inputs and guardrails there.

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) (latest)

| Skill | Runtime | Additional requirements |
|-------|---------|-------------------------|
| `tistory-publish` | Python 3.9+, Playwright; Node.js 18+ (optional, banner generation) | OpenClaw Chrome reachable over CDP, logged-in Tistory session (or Kakao credentials for `login.sh`) |
| `acp-discord-orchestrator` | Node.js 22.13+; the Claude launcher needs `process.execve` (22.15+/23.11+ or any later line, POSIX only) | OpenClaw ACPX plugin 0.11.2+ |
| `ipo-alert` | Python 3.6+ (stdlib only) | `curl` |
| `olympic-alert` | Python 3.6+ (stdlib only) | — |
| `daum-trends` | Python 3.10+ (stdlib only) | — |
| `seoul-subway-crowd` | Python 3 (stdlib only) | `SK_OPENAPI_KEY` environment variable |
| `brave-api-setup` | Node.js | Browser access to the Brave API dashboard |
| `ku-portal` | Python 3 | `pip install ku-portal-mcp`, KUPID credentials in `~/.config/ku-portal/credentials.json` |
| `nano-banana-pro` | Python 3.10+ via `uv` | Gemini API key (paid usage) |
| `music-preference-reco` | Python 3 (stdlib only) | — |

## Development

Tests exist for the two larger skills and run with nothing beyond Python and Node installed:

```bash
# tistory-publish
python3 -m unittest discover -s tistory-publish/tests -p "test_*.py" -v
node tistory-publish/tests/test_tistory_editor_helpers.js

# acp-discord-orchestrator
node --test acp-discord-orchestrator/scripts/test-acp-reporting-contract.mjs
node --test acp-discord-orchestrator/scripts/test-acpx-foreground-supervisor.mjs
node --test acp-discord-orchestrator/scripts/test-claude-acp-launcher.mjs
node --test tests/acp-discord-orchestrator-cli.test.mjs
```

GitHub Actions runs the `tistory-publish` tests and syntax checks (Python 3.9/3.13, Node 24) on pull requests that touch that directory. See [AGENTS.md](./AGENTS.md) for architecture notes and repository conventions ([CLAUDE.md](./CLAUDE.md) is the Claude Code compatibility entrypoint to the same guidance).

This is a public repository: deployment-specific values such as blog domains, CDP ports, credential paths, and account mappings are passed in by the caller and must not be committed here (see [docs/tistory-cdp-architecture.md](./docs/tistory-cdp-architecture.md)).

## Contact

Bug reports, feature requests, and feedback welcome.

- Email: contact@garibong.dev
- Developer: [Garibong Labs](https://github.com/garibong-labs)

## License

MIT
