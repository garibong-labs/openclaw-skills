# tistory-publish

티스토리 블로그 자동 발행 스킬. agent-browser(Playwright CLI)로 TinyMCE 에디터를 조작해 글 작성부터 발행까지 자동화합니다.

## 뭘 하는 건가요?

1. 본문 HTML을 TinyMCE 에디터에 삽입
2. 배너 이미지 업로드 + 대표이미지 설정
3. OG 카드 자동 생성 (URL → 카드 렌더링)
4. 카테고리, 태그, 제목 설정
5. 공개/비공개 발행

## 왜 브라우저 자동화?

티스토리 Open API가 2024년 2월에 종료됐습니다. 공식 API 없이 발행하려면 브라우저를 직접 제어하는 수밖에 없습니다.

## 구조

```
scripts/
├── tistory-publish.js       # 핵심 — 에디터 조작 함수 모음
├── mk-banner.js             # 배너 이미지 생성 (1150×630, 예시)
└── tistory-news-deep-dive.js  # 심층 분석 포스트용 (예시)

blog-drafts/
├── MK-PUBLISH-RUNBOOK.md    # 발행 순서 런북 (예시)
├── TEMPLATE-mk-review.md    # 원고 템플릿 (예시)
└── IMAGE-MAP.md             # 이미지 매핑 가이드
```

## 주요 함수 (`tistory-publish.js`)

| 함수 | 설명 |
|------|------|
| `buildBlogHTML({intro, articles})` | 원고 → 티스토리 HTML 변환 |
| `insertContent(html)` | TinyMCE 에디터에 HTML 삽입 |
| `setCategory(name)` | 카테고리 선택 (⚠️ ARIA combobox 변경으로 agent-browser click 권장) |
| `setTitle(title)` | 제목 입력 |
| `setTags(tags[])` | 태그 등록 (nativeSetter + InputEvent) |
| `clearTags()` | 기존 태그 전체 삭제 |
| `getOGPlaceholders()` | OG 카드 placeholder URL 추출 |
| `prepareOGPlaceholder(url)` | OG placeholder → URL 텍스트 교체 |
| `verifyOGCard(url)` | OG 카드 렌더링 확인 |
| `cleanupOGResiduals()` | OG 잔여물 정리 |
| `openBannerUploadInput()` | 배너 업로드 입력 활성화 |
| `verifyBannerUpload()` | 배너 서버 업로드 확인 |
| `setRepresentImageFromEditor()` | 에디터 내 이미지로 대표이미지 설정 |
| `clickPublish()` | 발행 버튼 클릭 |

## 기술 스택

- **브라우저 자동화**: [agent-browser](https://github.com/anthropics/agent-browser) (Playwright CLI)
- **에디터 조작**: TinyMCE DOM API, `execCommand`, nativeSetter 패턴
- **배너 생성**: Node.js Canvas (`@napi-rs/canvas`)
- **OG 카드**: `isTrusted=true` 이벤트 필요 → JS(placeholder 준비) + Playwright(Enter 키) 조합
- **태그 입력**: `nativeSetter` + `InputEvent` + `KeyboardEvent`로 Tistory `isTrusted` 필터링 우회

## 삽질 기록 (aka 왜 이렇게 복잡한가)

티스토리 에디터는 `isTrusted=false` 이벤트를 무시합니다. 일반적인 `dispatchEvent()`로는 OG 카드 생성이나 태그 입력이 안 됩니다.

- **OG 카드**: JS로 URL 텍스트를 삽입한 뒤, Playwright가 진짜 Enter 키를 보내야 OG 파서가 트리거됨
- **태그**: `HTMLInputElement.prototype`의 nativeSetter로 value를 강제 설정한 뒤, `InputEvent` + `KeyboardEvent(Enter)`를 순차 발송
- **배너**: 파일 다이얼로그를 코드로 제어할 수 없어서 `agent-browser upload` 액션으로 우회
- **카테고리**: 네이티브 `<select>`에서 ARIA combobox로 변경 — JS `setCategory()` 대신 Playwright click 필요
- **대표이미지**: 설정 셀렉터가 여러 변형 존재 — 다수 패턴 탐색 로직

## 설치

### ClawHub (추천)
```bash
clawhub install tistory-publish
```

## 사용 방법

### 전제 조건

- [agent-browser](https://github.com/anthropics/agent-browser) 설치 + 프로필 생성
- 티스토리 블로그 (Kakao 계정 로그인 완료 상태의 프로필)
- Node.js 18+ (배너 생성 시)

### 실행

에이전트가 런북을 따라 순서대로 실행하거나, 셸 스크립트로 한 번에 실행할 수 있습니다:

```bash
# 예시: 배너 생성 → 발행 스크립트 실행
node scripts/mk-banner.js
bash your-publish-script.sh \
  --title "제목" \
  --body-file "body.html" \
  --tags "태그1,태그2" \
  --banner "/tmp/banner.jpg"
```

자세한 순서는 `blog-drafts/MK-PUBLISH-RUNBOOK.md`(예시)를 참조하세요.

## 라이선스

MIT
