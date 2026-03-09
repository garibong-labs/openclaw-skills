---
name: music-preference-reco
description: Track a user's favorite artists/songs over time and recommend songs from the stored taste profile. Use when the user says they like an artist or track, asks to remember music taste, wants cumulative music preference history, or asks for recommendations based on previously saved favorites.
---

# Music Preference Reco

Store music taste in a persistent JSON profile and generate recommendations from that profile.

## Quick Start

Run from this skill folder:

```bash
python3 scripts/music_reco.py set-platform youtube
python3 scripts/music_reco.py add-artist "아티스트명"
python3 scripts/music_reco.py add-track "곡명" --artist "아티스트명"
python3 scripts/music_reco.py ingest "이 노래 넘 좋아 ROSSYPP - FALLING IN LOVE" --recommend
python3 scripts/music_reco.py show
python3 scripts/music_reco.py recommend --limit 10
python3 scripts/music_reco.py recommend --platform spotify --limit 10
```

지원 플랫폼: `youtube` | `spotify` | `apple`
- 기본값은 `set-platform`으로 고정
- `recommend --platform ...` 으로 1회성 override 가능

## Workflow

1. Save preference whenever the user says they like a singer or song.
2. Avoid duplicates (script handles this).
3. On recommendation requests, run `recommend` and return top picks.
4. Keep output concise with clickable links.

## Data File

Default profile path:

`~/.openclaw/workspace-dani/data/music-preferences.json`

Override when needed:

```bash
python3 scripts/music_reco.py --data /custom/path/preferences.json show
```

## Notes

- Recommendations use Apple iTunes Search API (no key required).
- If results are weak, add more favorite artists/songs first.
- Keep recommendations as suggestions; user preference always wins.
