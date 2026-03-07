# anthropic.tistory.com 데일리 발행 런북

> 매일 23:00 KST에 1포스트 발행.
> 주제: 세금/사업자 실무/개발 팁 (짧은 실무 메모 형태)
> 분량: 600~1,200자
> 문제 생기면 멈추고 Eli에게 보고.

---

## 발행 방식: agent-browser (2026-03-07~)

기존 OpenClaw Playwright 대신 **agent-browser CLI** 사용.
- 속도: ~33초/글 (Playwright 대비 2배 빠름)
- 토큰: 거의 0 (eval 직접 조작, LLM 왕복 없음)
- 안정성: POC 10/10 (100%)

### 사전 조건
- `agent-browser` 설치됨 (`/opt/homebrew/bin/agent-browser`)
- Tistory 프로필 로그인 완료 (`~/.agent-browser/tistory-profile`)
  - 세션 만료 시: `bash ~/workspace/scripts/agent-browser-kakao-login.sh` 실행
  - 간편로그인 우선 → Keychain fallback
- **OpenClaw browser와 독립** — CDP 충돌 없음

---

## 이미지 규칙 (필수)

- **무료 스톡 이미지만 사용** (Unsplash / Pexels / Pixabay / Wikimedia)
- **⛔ Nano Banana 등 AI 이미지 생성 도구 사용 금지** (과금 발생)
- 이미지 2장 고정:
  - 이미지 1: 체크리스트/정리 느낌 (노트, 체크박스, 서류 정돈)
  - 이미지 2: 상황 연상 (카드 결제, 영수증, 노트북+책상)
- 피할 것: 로고 노출, 특정 브랜드, 얼굴 클로즈업, "해외 세무서" 느낌
- 원고에 `<img src="외부URL">` 형태로 삽입
- 이미지 라이선스: 상업 이용 가능한 것만
- **출처 표기**: Wikimedia Commons 이미지 사용 시 글 하단에 "이미지 출처: Wikimedia Commons" 표기
- Unsplash/Pixabay 봇차단(403) 시 **Wikimedia Commons URL 우선**

---

## Step 0: 원고 작성

1. 주제 선정 (세금/사업자/개발 실무)
2. 템플릿 사용: `~/.openclaw/workspace-ruth/blog-drafts/anthropic-daily/TEMPLATE.md`
3. 포맷: 중간제목(H2) + 구분선 + 예시 + 이미지 2장 + 결론
4. 품질 기준: anthropic.tistory.com/14 수준 이상
5. 파일 저장: `~/.openclaw/workspace-ruth/blog-drafts/anthropic-daily/YYYY-MM-DD-*.md`

---

## Step 1: 로그인 확인

```bash
bash ~/workspace/scripts/agent-browser-kakao-login.sh
```

---

## Step 2: 발행

```bash
bash ~/workspace/scripts/agent-browser-tistory-publish.sh \
  --title "제목" \
  --body "<h2>섹션</h2><p>본문...</p>" \
  --tags "태그1,태그2,태그3" \
  --blog "anthropic"
```

- `--private`: 비공개 발행 (테스트용)
- 본문은 HTML 형태 (md → HTML 변환 필요)

---

## Step 3: 확인 및 보고

1. 스크립트 반환값 확인 (success:true)
2. 발행된 URL 확인
3. #c-level 채널에 링크 보고

---

## 주의사항

- **agent-browser 프로필**: 항상 `~/.agent-browser/tistory-profile` 사용
- **connect 절대 금지**: `agent-browser connect`로 OpenClaw 브라우저에 붙지 말 것 (CDP 충돌)
- **세션 만료**: 로그인 페이지 리다이렉트 시 kakao-login 스크립트 실행
- **UTF-8**: 스크립트에 TextDecoder 적용됨 — 직접 eval 할 때도 동일 방식 사용
- **배너/OG 카드/대표이미지**: 이 블로그에선 생략 (짧은 실무 메모 형태)

---

## 역할
- **Eli**: 런북/스크립트 개발·유지보수
- **Ruth**: 원고 작성 + agent-browser 스크립트로 직접 발행
