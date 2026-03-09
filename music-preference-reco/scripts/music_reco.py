#!/usr/bin/env python3
"""Store music preferences and generate quick recommendations.

Data file defaults to: ~/.openclaw/workspace-dani/data/music-preferences.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

DEFAULT_DATA = os.path.expanduser("~/.openclaw/workspace-dani/data/music-preferences.json")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


@dataclass
class Song:
    title: str
    artist: str
    url: str


def _read_json(url: str, timeout: int = 10) -> dict:
    req = Request(url, headers={"User-Agent": UA})
    with urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8", errors="replace"))


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip()).lower()


def _clean_token(s: str) -> str:
    return s.strip().strip('"“”\'‘’').strip()


def load_profile(path: Path) -> dict:
    if not path.exists():
        return {"artists": [], "tracks": [], "default_platform": "youtube"}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"artists": [], "tracks": [], "default_platform": "youtube"}
    data.setdefault("artists", [])
    data.setdefault("tracks", [])
    data.setdefault("default_platform", "youtube")
    return data


def save_profile(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def get_default_platform(profile: dict) -> str:
    p = (profile.get("default_platform") or "youtube").strip().lower()
    if p not in {"youtube", "spotify", "apple"}:
        return "youtube"
    return p


def set_default_platform(profile: dict, platform: str) -> None:
    profile["default_platform"] = platform.strip().lower()


def add_artist(profile: dict, artist: str) -> bool:
    n = _norm(artist)
    exists = {_norm(a) for a in profile["artists"]}
    if n in exists:
        return False
    profile["artists"].append(artist.strip())
    return True


def add_track(profile: dict, track: str, artist: str = "") -> bool:
    key = _norm(f"{track}::{artist}")
    exists = {_norm(f"{t.get('title','')}::{t.get('artist','')}") for t in profile["tracks"]}
    if key in exists:
        return False
    profile["tracks"].append({"title": track.strip(), "artist": artist.strip()})
    return True


def fetch_songs_by_artist(artist: str, limit: int = 20) -> list[Song]:
    term = quote(artist)
    url = f"https://itunes.apple.com/search?term={term}&entity=song&attribute=artistTerm&limit={limit}&country=KR"
    data = _read_json(url)
    out: list[Song] = []
    for it in data.get("results", []):
        title = it.get("trackName")
        artist_name = it.get("artistName")
        track_url = it.get("trackViewUrl") or it.get("collectionViewUrl") or ""
        if not title or not artist_name or not track_url:
            continue
        out.append(Song(title=title, artist=artist_name, url=track_url))
    return out


def fetch_songs_by_term(term: str, limit: int = 20) -> list[Song]:
    q = quote(term)
    url = f"https://itunes.apple.com/search?term={q}&entity=song&limit={limit}&country=KR"
    data = _read_json(url)
    out: list[Song] = []
    for it in data.get("results", []):
        title = it.get("trackName")
        artist_name = it.get("artistName")
        track_url = it.get("trackViewUrl") or it.get("collectionViewUrl") or ""
        if not title or not artist_name or not track_url:
            continue
        out.append(Song(title=title, artist=artist_name, url=track_url))
    return out


def recommend(profile: dict, limit: int = 10) -> list[Song]:
    """Generate recommendations.

    Strategy:
    - Seed with BOTH saved artists and track artists.
    - Prefer artists that appear in saved tracks (often more specific, e.g., HANRORO).
    - Fallback to a broader term search when artistTerm search is weak.
    - Mix artists round-robin so one artist doesn't dominate the top-N.
    """

    tracks = profile.get("tracks", [])
    saved_artists = [a for a in profile.get("artists", []) if a]

    track_artists: list[str] = []
    for t in tracks:
        a = (t.get("artist") or "").strip()
        if a:
            track_artists.append(a)

    # priority: track artists first (more precise), then saved artists
    seed_artists: list[str] = list(dict.fromkeys(track_artists + saved_artists))

    buckets: list[list[Song]] = []
    for artist in seed_artists:
        by_artist = fetch_songs_by_artist(artist, limit=25)
        if len(by_artist) < 5:
            by_artist = by_artist + fetch_songs_by_term(artist, limit=25)
        # de-dup within bucket
        seen_local: set[str] = set()
        uniq: list[Song] = []
        for s in by_artist:
            k = _norm(f"{s.title}::{s.artist}")
            if k in seen_local:
                continue
            seen_local.add(k)
            uniq.append(s)
        if uniq:
            buckets.append(uniq)

    # Also seed from specific liked tracks (title + artist) as another bucket
    track_seed: list[Song] = []
    for t in tracks:
        title = (t.get("title") or "").strip()
        artist = (t.get("artist") or "").strip()
        query = f"{title} {artist}".strip()
        if query:
            track_seed.extend(fetch_songs_by_term(query, limit=15))
    if track_seed:
        buckets.append(track_seed)

    known = {_norm(f"{t.get('title','')}::{t.get('artist','')}") for t in tracks}
    seen: set[str] = set()
    picks: list[Song] = []

    i = 0
    while len(picks) < limit and buckets:
        progressed = False
        for b in list(buckets):
            if i >= len(b):
                continue
            s = b[i]
            key = _norm(f"{s.title}::{s.artist}")
            if key in known or key in seen:
                continue
            seen.add(key)
            picks.append(s)
            progressed = True
            if len(picks) >= limit:
                break
        i += 1
        # stop if we're no longer adding anything
        if not progressed and i > 30:
            break

    return picks


def build_platform_url(song: Song, platform: str) -> str:
    q = quote(f"{song.artist} {song.title}".strip())
    p = platform.lower()
    if p == "spotify":
        return f"https://open.spotify.com/search/{q}"
    if p == "apple":
        return song.url
    return f"https://music.youtube.com/search?q={q}"


def parse_preference_text(text: str) -> tuple[list[str], list[tuple[str, str]]]:
    """Extract (artists, tracks) from casual utterances.

    Heuristics (Korean/English mixed):
    - "아티스트명 - 곡명 좋아"
    - "가수/아티스트 OOO 좋아"
    - "OOO 노래 좋아"
    - "'곡명' 좋아" (곡명 only)
    """
    artists: list[str] = []
    tracks: list[tuple[str, str]] = []
    t = text.strip()

    # Pattern: ... Artist - Title (use right-most hyphen split)
    if re.search(r"[-—–]", t):
        left, right = re.split(r"[-—–]", t, maxsplit=1) if t.count("-") + t.count("—") + t.count("–") == 1 else t.rsplit("-", 1)
        left = left.strip()
        right = right.strip()
        # pick likely artist from tail of left phrase
        left_tail = re.sub(r"^.*?(?:좋아|좋아요|좋다|love|like)\s*", "", left, flags=re.I).strip()
        m_artist = re.search(r"([A-Za-z0-9가-힣&_. ]{2,40})$", left_tail or left)
        artist_guess = _clean_token(m_artist.group(1)) if m_artist else _clean_token(left_tail or left)
        title_guess = _clean_token(re.sub(r"\s*(좋아|좋아요|좋다)\s*$", "", right, flags=re.I))
        if artist_guess and title_guess:
            artists.append(artist_guess)
            tracks.append((title_guess, artist_guess))
            return artists, tracks

    # Pattern: 가수/아티스트 OOO 좋아
    for m in re.finditer(r"(?:가수|아티스트)\s*[:：]?\s*([^,\.]+?)\s*(좋아|좋아요|팬|love|like)", t, re.I):
        cand = _clean_token(m.group(1))
        if cand:
            artists.append(cand)

    # Pattern: OOO 좋아 (short text => likely artist)
    m = re.search(r"^(.+?)\s*(좋아|좋아요|좋다|love|like)\s*$", t, re.I)
    if m and len(t.split()) <= 4 and "노래" not in t and "곡" not in t:
        cand = _clean_token(m.group(1))
        if cand:
            artists.append(cand)

    # Pattern: OOO 노래/곡 좋아
    m = re.search(r"(.+?)\s*(?:노래|곡)\s*(좋아|좋아요|좋다|love|like)", t, re.I)
    if m:
        cand = _clean_token(m.group(1))
        if cand:
            tracks.append((cand, ""))

    # Pattern: quoted title + 좋아
    for m in re.finditer(r"[\"“”'‘’]([^\"“”'‘’]{2,80})[\"“”'‘’]\s*(좋아|좋아요|좋다|love|like)", t, re.I):
        cand = _clean_token(m.group(1))
        if cand:
            tracks.append((cand, ""))

    # de-dup
    artists = list(dict.fromkeys(a for a in artists if a))
    seen = set()
    uniq_tracks: list[tuple[str, str]] = []
    for title, artist in tracks:
        k = _norm(f"{title}::{artist}")
        if k in seen:
            continue
        seen.add(k)
        uniq_tracks.append((title, artist))
    return artists, uniq_tracks


def cmd_show(profile: dict) -> int:
    print("🎵 저장된 취향")
    print(f"기본 플랫폼: {get_default_platform(profile)}")
    print()
    print("[아티스트]")
    if profile["artists"]:
        for i, a in enumerate(profile["artists"], 1):
            print(f"{i}. {a}")
    else:
        print("- (없음)")

    print()
    print("[좋아하는 곡]")
    if profile["tracks"]:
        for i, t in enumerate(profile["tracks"], 1):
            title = t.get("title", "")
            artist = t.get("artist", "")
            if artist:
                print(f"{i}. {title} — {artist}")
            else:
                print(f"{i}. {title}")
    else:
        print("- (없음)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Music preference tracker + simple recommender")
    ap.add_argument("--data", default=DEFAULT_DATA, help="Path to preferences JSON")

    sub = ap.add_subparsers(dest="cmd", required=True)

    ap_artist = sub.add_parser("add-artist", help="Add favorite artist")
    ap_artist.add_argument("artist")

    ap_track = sub.add_parser("add-track", help="Add favorite track")
    ap_track.add_argument("title")
    ap_track.add_argument("--artist", default="")

    sub.add_parser("show", help="Show stored profile")

    ap_reco = sub.add_parser("recommend", help="Generate recommendations")
    ap_reco.add_argument("--limit", type=int, default=10)
    ap_reco.add_argument("--platform", choices=["youtube", "spotify", "apple"], default=None)

    ap_setp = sub.add_parser("set-platform", help="Set default recommendation platform")
    ap_setp.add_argument("platform", choices=["youtube", "spotify", "apple"])

    ap_ingest = sub.add_parser("ingest", help="Parse casual text, auto-save preference")
    ap_ingest.add_argument("text", help="User utterance, e.g. 'ROSSYPP 노래 좋아'")
    ap_ingest.add_argument("--recommend", action="store_true", help="Also print recommendations")
    ap_ingest.add_argument("--limit", type=int, default=5)
    ap_ingest.add_argument("--platform", choices=["youtube", "spotify", "apple"], default=None)

    args = ap.parse_args()

    path = Path(args.data)
    profile = load_profile(path)

    if args.cmd == "add-artist":
        added = add_artist(profile, args.artist)
        if added:
            save_profile(path, profile)
            print(f"✅ 아티스트 저장: {args.artist}")
        else:
            print(f"ℹ️ 이미 저장됨: {args.artist}")
        return 0

    if args.cmd == "add-track":
        added = add_track(profile, args.title, args.artist)
        if added:
            save_profile(path, profile)
            suffix = f" — {args.artist}" if args.artist else ""
            print(f"✅ 곡 저장: {args.title}{suffix}")
        else:
            print("ℹ️ 이미 저장된 곡입니다")
        return 0

    if args.cmd == "show":
        return cmd_show(profile)

    if args.cmd == "set-platform":
        set_default_platform(profile, args.platform)
        save_profile(path, profile)
        print(f"✅ 기본 플랫폼 저장: {args.platform}")
        return 0

    if args.cmd == "ingest":
        artists, tracks = parse_preference_text(args.text)
        saved = 0

        for a in artists:
            if add_artist(profile, a):
                print(f"✅ 아티스트 저장: {a}")
                saved += 1

        for title, artist in tracks:
            if add_track(profile, title, artist):
                suffix = f" — {artist}" if artist else ""
                print(f"✅ 곡 저장: {title}{suffix}")
                saved += 1

        if saved == 0:
            print("ℹ️ 자동 인식된 항목이 없어요. 명시적으로 add-artist/add-track을 써주세요.")
        else:
            save_profile(path, profile)

        if args.recommend:
            print()
            if not profile.get("artists") and not profile.get("tracks"):
                print("아직 저장된 취향이 없어요. add-artist / add-track부터 해주세요.")
                return 0
            picks = recommend(profile, limit=max(1, min(args.limit, 30)))
            platform = args.platform or get_default_platform(profile)
            print(f"🎧 추천 곡 ({platform})")
            if not picks:
                print("- 추천 결과가 없어요. 좋아하는 아티스트/곡을 더 추가해보세요.")
                return 0
            for i, s in enumerate(picks, 1):
                out_url = build_platform_url(s, platform)
                print(f"{i}. [{s.title}]({out_url}) — {s.artist}")
        return 0

    if args.cmd == "recommend":
        if not profile.get("artists") and not profile.get("tracks"):
            print("아직 저장된 취향이 없어요. add-artist / add-track부터 해주세요.")
            return 0
        try:
            picks = recommend(profile, limit=max(1, min(args.limit, 30)))
        except Exception as e:
            print(f"ERROR: 추천 생성 실패: {e}", file=sys.stderr)
            return 1

        platform = args.platform or get_default_platform(profile)
        print(f"🎧 추천 곡 ({platform})")
        if not picks:
            print("- 추천 결과가 없어요. 좋아하는 아티스트/곡을 더 추가해보세요.")
            return 0
        for i, s in enumerate(picks, 1):
            out_url = build_platform_url(s, platform)
            print(f"{i}. [{s.title}]({out_url}) — {s.artist}")
        return 0

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
