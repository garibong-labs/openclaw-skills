---
name: seoul-subway-crowd
description: Query and summarize Seoul subway congestion statistics via SK Open API (TMAP 대중교통). Use when the user asks for station/line-based train congestion or car-by-car congestion, time-slot checks (dow/hh), comparisons, or commute alerts.
---

# Seoul Subway Crowd (SK Open API)

## Inputs to collect
- Station name (required)
- Line name/number (optional but recommended)
- Direction (optional): up/down or inbound/outbound
- Time mode (optional): now/forecast

## Workflow
1. Ensure `SK_OPENAPI_KEY` exists in environment.
2. Read endpoint and parameter mapping from `references/api-map.md`.
3. Run `scripts/fetch_crowd.py` with station/line/time arguments.
4. Return a short Korean summary:
   - 혼잡도 등급
   - 핵심 수치(있으면)
   - 한 줄 코멘트(이동 추천/회피 시간)
5. If API fails, return clear fallback with reason and next action.

## CLI usage
```bash
python3 scripts/fetch_crowd.py --station "강남역" --line "2호선" --mode train
python3 scripts/fetch_crowd.py --station "홍대입구역" --line "2호선" --mode car --dow MON --hh 08
```

## Output style
- Keep it short and practical.
- Prefer bullet list over tables on Discord.
- Include raw response path when debugging (`--save-json`).

## Notes
- Do not hardcode API key.
- Normalize common line variants ("2", "2호선", "Line 2").
- If API schema changes, update `references/api-map.md` first.
