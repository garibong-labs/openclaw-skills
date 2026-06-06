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

### 🔍 [brave-api-setup](./brave-api-setup)

Automates Brave Search API key setup for OpenClaw's `web_search` tool.

Extracts the API key via browser JavaScript (no LLM transcription errors) and applies it directly to the OpenClaw config.

**Use when:** You need to enable web search, configure the Brave API, or fix a `missing_brave_api_key` error.

---

### 📈 [ipo-alert](./ipo-alert)

Monitors Korean IPO (공모주) subscription and listing schedules from [38.co.kr](https://www.38.co.kr).

Sends alerts on D-1 and day-of for both subscription opens and new listings. Supports daily checks and weekly summaries. Zero external dependencies — pure Python standard library.

**Use when:** You want to be notified about upcoming Korean IPO subscriptions or new stock listings.

---

### 🏅 [olympic-alert](./olympic-alert)

Sends alerts 15 minutes before Olympic events. Ships with a default schedule for Team Korea at the 2026 Milano Winter Olympics, but works for any country or sporting event.

Supports adding/removing events via CLI, and tracks sent alerts to prevent duplicates.

**Use when:** You want timely reminders before live sports events.

---

## Installation

Each skill lives in its own directory. To install, copy the skill directory into your OpenClaw workspace skills folder and add it to your agent's skill list.

Refer to each skill's `SKILL.md` for detailed setup instructions and usage examples.

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) (latest)
- Python 3.6+ (for `ipo-alert` and `olympic-alert`)
- Node.js (for `brave-api-setup`)

## Contact

Bug reports, feature requests, and feedback welcome.

- Email: contact@garibong.dev
- Developer: [Garibong Labs](https://github.com/garibong-labs)

## License

MIT
