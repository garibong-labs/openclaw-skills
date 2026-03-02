#!/usr/bin/env python3
"""
KU Portal 일일 공지사항 알림 스크립트
매일 오전 9시 KST 실행 — 최근 3일 이내 공지사항을 Telegram으로 전송
"""
import subprocess
import json
import sys
import re
import os
from datetime import datetime, timedelta, timezone

# 설정
KST = timezone(timedelta(hours=9))
TELEGRAM_BOT_TOKEN = "8419654998:AAEUZFRlJcNhRmLmLtGxGjPuJunAfr7iN9Q"
TELEGRAM_CHAT_ID = "2023630636"
SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
KU_QUERY = os.path.join(SKILL_DIR, "ku_query.py")
PYTHON = os.path.join(SKILL_DIR, ".venv/bin/python3")

def get_notices():
    result = subprocess.run(
        [PYTHON, KU_QUERY, "notices", "--limit", "50"],
        capture_output=True, text=True
    )
    return result.stdout

def parse_date_from_id(notice_id):
    """ID에서 날짜 파싱: 202603011650210438 → 2026-03-01"""
    m = re.match(r"(\d{4})(\d{2})(\d{2})", notice_id)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=KST)
        except ValueError:
            return None
    return None

def filter_recent(notices_text, days=3):
    """최근 N일 이내 공지사항만 필터링"""
    cutoff = datetime.now(KST) - timedelta(days=days)
    lines = notices_text.strip().splitlines()
    result = []
    for line in lines:
        m = re.search(r"\[(\d{18})\](.+?)- (.+?) \[ID:", line)
        if m:
            notice_id = m.group(1)
            title = m.group(2).strip()
            author = m.group(3).strip()
            date = parse_date_from_id(notice_id)
            if date and date >= cutoff:
                date_str = date.strftime("%m/%d")
                result.append(f"• [{date_str}] {title} ({author})")
    return result

def send_telegram(message):
    import urllib.request
    import urllib.parse
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    data = urllib.parse.urlencode({
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "HTML"
    }).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def main():
    now = datetime.now(KST)
    raw = get_notices()
    recent = filter_recent(raw, days=3)

    if not recent:
        message = f"📋 <b>고려대학교 포털 공지 ({now.strftime('%m/%d')})</b>\n\n최근 3일간 새 공지사항이 없어요."
    else:
        items = "\n".join(recent)
        message = f"📋 <b>고려대학교 포털 공지 ({now.strftime('%m/%d')})</b>\n최근 3일 이내 공지사항이에요 ✨\n\n{items}\n\n🔗 <a href='https://portal.korea.ac.kr'>KUPID 포털 바로가기</a>"

    result = send_telegram(message)
    if result.get("ok"):
        print(f"[{now.strftime('%Y-%m-%d %H:%M')}] 전송 완료 ({len(recent)}건)")
    else:
        print(f"[ERROR] Telegram 전송 실패: {result}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
