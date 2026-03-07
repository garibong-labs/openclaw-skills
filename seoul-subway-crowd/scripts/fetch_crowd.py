#!/usr/bin/env python3
import argparse
import json
import os
import sys
from statistics import mean
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE = "https://apis.openapi.sk.com"
ENDPOINTS = {
    "train": "/transit/puzzle/subway/congestion/stat/train",
    "car": "/transit/puzzle/subway/congestion/stat/car",
}

LINE_MAP = {
    "1": "1호선", "1호선": "1호선", "line1": "1호선", "line 1": "1호선",
    "2": "2호선", "2호선": "2호선", "line2": "2호선", "line 2": "2호선",
    "3": "3호선", "3호선": "3호선", "line3": "3호선", "line 3": "3호선",
    "4": "4호선", "4호선": "4호선", "line4": "4호선", "line 4": "4호선",
    "5": "5호선", "5호선": "5호선", "line5": "5호선", "line 5": "5호선",
    "6": "6호선", "6호선": "6호선", "line6": "6호선", "line 6": "6호선",
    "7": "7호선", "7호선": "7호선", "line7": "7호선", "line 7": "7호선",
    "8": "8호선", "8호선": "8호선", "line8": "8호선", "line 8": "8호선",
    "9": "9호선", "9호선": "9호선", "line9": "9호선", "line 9": "9호선",
    "신분당": "신분당선", "신분당선": "신분당선",
}


def norm_line(v: str) -> str:
    k = v.strip().lower().replace("\u3000", " ")
    return LINE_MAP.get(k, v.strip())


def level_from_score(score):
    if score is None:
        return "알 수 없음"
    if score < 40:
        return "여유"
    if score < 70:
        return "보통"
    if score < 85:
        return "혼잡"
    return "매우 혼잡"


def fetch_json(url: str, appkey: str, timeout: int = 12):
    req = Request(url, headers={
        "Accept": "application/json",
        "appKey": appkey,
    })
    with urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8", errors="replace"))


def flatten_train_values(stat_list):
    vals = []
    for stat in stat_list or []:
        for d in stat.get("data", []) or []:
            v = d.get("congestionTrain")
            if isinstance(v, (int, float)):
                vals.append(float(v))
    return vals


def flatten_car_values(stat_list):
    vals = []
    for stat in stat_list or []:
        for d in stat.get("data", []) or []:
            arr = d.get("congestionCar")
            if isinstance(arr, list):
                nums = [float(x) for x in arr if isinstance(x, (int, float))]
                vals.extend(nums)
    return vals


def main():
    ap = argparse.ArgumentParser(description="SK Open API subway congestion fetcher")
    ap.add_argument("--station", required=True, help="역명 (예: 서울역)")
    ap.add_argument("--line", required=True, help="노선 (예: 1호선, 2)")
    ap.add_argument("--mode", choices=["train", "car"], default="train")
    ap.add_argument("--dow", default="", help="MON|TUE|WED|THU|FRI|SAT|SUN")
    ap.add_argument("--hh", default="", help="05~23")
    ap.add_argument("--appkey", default=os.getenv("SK_OPENAPI_KEY", ""))
    ap.add_argument("--save-json", default="")
    args = ap.parse_args()

    if not args.appkey:
        print("ERROR: SK_OPENAPI_KEY missing", file=sys.stderr)
        sys.exit(2)

    route = norm_line(args.line)
    qs = {
        "routeNm": route,
        "stationNm": args.station,
    }
    if args.dow:
        qs["dow"] = args.dow
    if args.hh:
        qs["hh"] = args.hh.zfill(2)

    url = f"{BASE}{ENDPOINTS[args.mode]}?{urlencode(qs)}"

    try:
        payload = fetch_json(url, args.appkey)
    except Exception as e:
        print(f"ERROR: request failed: {e}", file=sys.stderr)
        sys.exit(1)

    if args.save_json:
        with open(args.save_json, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)

    status = payload.get("status", {})
    if status.get("code") != "00":
        print(json.dumps({
            "ok": False,
            "code": status.get("code"),
            "message": status.get("message", "unknown_error"),
            "url": url,
        }, ensure_ascii=False, indent=2))
        sys.exit(0)

    contents = payload.get("contents", {})
    stat = contents.get("stat", [])

    if args.mode == "train":
        vals = flatten_train_values(stat)
        avg = round(mean(vals), 1) if vals else None
        out = {
            "ok": True,
            "mode": "train",
            "line": contents.get("subwayLine", route),
            "station": contents.get("stationName", args.station),
            "stationCode": contents.get("stationCode"),
            "avgCongestion": avg,
            "level": level_from_score(avg) if avg is not None else "알 수 없음",
            "samples": len(vals),
            "statPeriod": {
                "start": contents.get("statStartDate"),
                "end": contents.get("statEndDate"),
            },
            "url": url,
        }
    else:
        vals = flatten_car_values(stat)
        avg = round(mean(vals), 1) if vals else None
        out = {
            "ok": True,
            "mode": "car",
            "line": contents.get("subwayLine", route),
            "station": contents.get("stationName", args.station),
            "stationCode": contents.get("stationCode"),
            "avgCarCongestion": avg,
            "level": level_from_score(avg) if avg is not None else "알 수 없음",
            "samples": len(vals),
            "statPeriod": {
                "start": contents.get("statStartDate"),
                "end": contents.get("statEndDate"),
            },
            "url": url,
        }

    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
