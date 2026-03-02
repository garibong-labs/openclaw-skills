#!/usr/bin/env python3
"""
KU 수업 알림 스크립트
월/화/목 오후 4시에 당일 수업 정보를 Telegram으로 전송
"""
import json
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))
TELEGRAM_BOT_TOKEN = "8419654998:AAEUZFRlJcNhRmLmLtGxGjPuJunAfr7iN9Q"
TELEGRAM_CHAT_ID = "2023630636"

SCHEDULE = {
    0: {"name": "운영체제", "prof": "유헌창", "time": "7-8교시", "room": "애기능생활관 302호", "type": "기초공통"},   # 월
    1: {"name": "선형대수", "prof": "박성우", "time": "9-10교시", "room": "정보통신관 202호", "type": "전공선택"},  # 화
    3: {"name": "텍스트마이닝", "prof": "장부루", "time": "7-8교시", "room": "정보통신관 604호", "type": "전공선택"},  # 목
}

DAYS_KR = {0: "월", 1: "화", 2: "수", 3: "목", 4: "금", 5: "토", 6: "일"}

def send_telegram(message):
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
    weekday = now.weekday()  # 0=월, 1=화, ..., 6=일

    course = SCHEDULE.get(weekday)
    if not course:
        print(f"[{now.strftime('%Y-%m-%d')}] 오늘({DAYS_KR[weekday]})은 수업 없음. 스킵.")
        return

    message = (
        f"📚 <b>오늘 수업 알림</b> ({now.strftime('%m/%d')} {DAYS_KR[weekday]}요일)\n\n"
        f"📖 <b>{course['name']}</b> ({course['type']})\n"
        f"👨‍🏫 {course['prof']} 교수님\n"
        f"⏰ {DAYS_KR[weekday]} {course['time']}\n"
        f"📍 {course['room']}\n\n"
        f"파이팅이에요 Gary님! 🎓✨"
    )

    result = send_telegram(message)
    if result.get("ok"):
        print(f"[{now.strftime('%Y-%m-%d %H:%M')}] 알림 전송 완료: {course['name']}")
    else:
        print(f"[ERROR] 전송 실패: {result}")

if __name__ == "__main__":
    main()
