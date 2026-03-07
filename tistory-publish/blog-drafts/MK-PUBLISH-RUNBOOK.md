# 매경 리뷰 발행 런북 (Ruth용, agent-browser 버전)

> 이 문서 순서대로만 실행하면 됨.
> 문제 생기면 멈추고 Eli에게 보고.
> **최종 수정**: 2026-03-07

---

## 발행 방식
기존 OpenClaw Playwright 대신 **agent-browser 전용 스크립트** 사용.

- 스크립트: `~/.openclaw/workspace/scripts/agent-browser-mk-publish.sh`
- 프로필: `~/.agent-browser/tistory-profile`
- 대상 블로그: `bongman.tistory.com`

---

## 0단계: 원고 작성 (Ruth 담당)

1. 날짜/요일 먼저 확인
```bash
date "+%Y년 %m월 %d일 (%A)"
```
- 요일 변환: Mon=월 Tue=화 Wed=수 Thu=목 Fri=금 Sat=토 Sun=일

2. 원고 파일 저장
- 경로: `~/.openclaw/workspace-ruth/blog-drafts/mk-review-YYYY-MM-DD.md`
- 형식: `TEMPLATE-mk-review.md`

3. 본문 HTML 파일 준비
- 경로 예시: `~/.openclaw/workspace-ruth/blog-drafts/mk-review-YYYY-MM-DD.html`
- OG 카드 자리표시는 반드시 `<p data-og-placeholder="기사URL">&#8203;</p>` 형태 유지

4. **HTML 포맷 규칙 (필수)**
- **단락 = 여러 문장 묶음**: `<p>` 하나에 2~4문장. 문장마다 `<p>` 분리 금지
- 카테고리는 반드시 **`신문 리뷰`** 확인 (스크립트가 자동 선택하지만, HTML 준비 단계에서도 인지할 것)
- 참고 기준: <https://bongman.tistory.com/1309> 수준으로 작성

---

## 1단계: 배너 생성

```bash
node ~/.openclaw/workspace-ruth/scripts/mk-banner.js
# 결과: /tmp/mk-banner-YYYY-MM-DD.jpg
```

---

## 2단계: 발행 실행

```bash
bash ~/.openclaw/workspace/scripts/agent-browser-mk-publish.sh \
  --title "[매경] YYYY.MM.DD(요일) - 키워드1, 키워드2, 키워드3" \
  --body-file "~/.openclaw/workspace-ruth/blog-drafts/mk-review-YYYY-MM-DD.html" \
  --tags "매경,매일경제,신문리뷰,태그4,태그5,태그6,태그7,태그8,태그9,태그10" \
  --banner "/tmp/mk-banner-YYYY-MM-DD.jpg" \
  --private
```

> 실전 발행 시 `--private` 제거.

이 스크립트가 아래를 자동 처리함:
- 카테고리 `신문 리뷰` 선택
- 제목 입력
- 본문 삽입
- 배너 업로드
- OG 카드 생성
- 대표이미지 설정
- 태그 입력
- 발행 (비공개/공개)

---

## 3단계: 결과 확인

성공 응답 예시:
```json
{"success":true,"url":"https://bongman.tistory.com/manage/posts","elapsed_ms":33500,"private":true}
```

- `success: true` 확인
- 실패 시 에러 메시지 그대로 Eli에게 전달

---

## 4단계: 보고 규칙

### 비공개 테스트 발행일 때
이 채널(`#매경-리뷰-포스트-발행`)에:
```
🧪 [매경] 비공개 테스트 발행 완료 — {URL}
검증: 카테고리/본문/배너/대표이미지/태그 처리 확인
```

### 실전 공개 발행일 때
이 채널에:
```
✅ [매경] 리뷰 발행 완료 — {URL}
```

---

## 실패 시 즉시 중단 조건

아래 중 하나면 더 진행하지 말고 Eli 호출:
- 로그인 페이지로 리다이렉트됨
- 배너 업로드 실패
- OG 카드가 4개 미만
- 발행 버튼 클릭 실패

---

## 참고
- helper JS: `~/.openclaw/workspace-ruth/scripts/tistory-publish.js`
- 배너 스크립트: `~/.openclaw/workspace-ruth/scripts/mk-banner.js`
- 운영 원칙: 런북/스크립트 수정은 Eli만
