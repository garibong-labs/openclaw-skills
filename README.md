# openclaw-skills

A collection of [OpenClaw](https://github.com/openclaw/openclaw) skills built and maintained by [Garibong Labs](https://github.com/garibong-labs).

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
