# tistory-automation

티스토리 블로그 자동 발행 도구. AI 에이전트(OpenClaw)가 매일 아침 매경 리뷰를 작성하고 발행합니다.

> **Live blog**: [bongman.tistory.com](https://bongman.tistory.com)

## 뭘 하는 건가요?

1. 매일경제 1면에서 기사 4개를 골라 요약 + 코멘트 작성
2. 1150×630 배너 이미지 자동 생성
3. 티스토리 에디터(TinyMCE)를 브라우저 자동화로 조작해 발행
4. OG 카드, 태그, 카테고리, 대표이미지까지 전부 자동

## 왜 브라우저 자동화?

티스토리 Open API가 2024년 2월에 종료됐습니다. 공식 API 없이 발행하려면 브라우저를 직접 제어하는 수밖에 없습니다.

## 구조

```
scripts/
├── tistory-publish.js   # 핵심 — 에디터 조작 함수 모음
├── mk-banner.js         # 매경 1면 배너 이미지 생성 (1150×630)
└── tistory-news-deep-dive.js  # 심층 분석 포스트용

blog-drafts/
├── MK-PUBLISH-RUNBOOK.md    # 발행 순서 런북 (0~9단계)
├── TEMPLATE-mk-review.md   # 원고 템플릿
└── IMAGE-MAP.md             # 이미지 매핑 가이드
```

## 주요 함수 (`tistory-publish.js`)

| 함수 | 설명 |
|------|------|
| `buildBlogHTML({intro, articles})` | 원고 → 티스토리 HTML 변환 |
| `insertContent(html)` | TinyMCE 에디터에 HTML 삽입 |
| `setCategory(name)` | 카테고리 선택 |
| `setTitle(title)` | 제목 입력 |
| `setTags(tags[])` | 태그 등록 (nativeSetter + InputEvent) |
| `clearTags()` | 기존 태그 전체 삭제 |
| `getOGPlaceholders()` | OG 카드 placeholder URL 추출 |
| `prepareOGPlaceholder(url)` | OG placeholder → URL 텍스트 교체 |
| `verifyOGCard(url)` | OG 카드 렌더링 확인 |
| `cleanupOGResiduals()` | OG 잔여물 정리 |
| `openBannerUploadInput()` | 배너 업로드 입력 활성화 (커서 상단 이동 포함) |
| `verifyBannerUpload()` | 배너 서버 업로드 확인 |
| `setRepresentImageFromEditor()` | 에디터 내 이미지로 대표이미지 설정 |
| `clickPublish()` | 발행 버튼 클릭 |

## 기술 스택

- **브라우저 자동화**: [OpenClaw](https://github.com/openclaw/openclaw) + Playwright
- **에디터 조작**: TinyMCE DOM API, `execCommand`, nativeSetter 패턴
- **배너 생성**: Node.js Canvas (`@napi-rs/canvas`)
- **OG 카드**: `isTrusted=true` 이벤트 필요 → JS(placeholder 준비) + Playwright(Enter 키) 조합
- **태그 입력**: `nativeSetter` + `InputEvent` + `KeyboardEvent`로 Tistory `isTrusted` 필터링 우회

## 삽질 기록 (aka 왜 이렇게 복잡한가)

티스토리 에디터는 `isTrusted=false` 이벤트를 무시합니다. 일반적인 `dispatchEvent()`로는 OG 카드 생성이나 태그 입력이 안 됩니다.

- **OG 카드**: JS로 URL 텍스트를 삽입한 뒤, Playwright가 진짜 Enter 키를 보내야 OG 파서가 트리거됨
- **태그**: `HTMLInputElement.prototype`의 nativeSetter로 value를 강제 설정한 뒤, `InputEvent` + `KeyboardEvent(Enter)`를 순차 발송
- **배너**: 파일 다이얼로그를 코드로 제어할 수 없어서 Playwright `upload` 액션으로 우회
- **대표이미지**: 설정 다이얼로그의 셀렉터가 10가지 이상 변형 — 전부 탐색하는 v2 로직

## 설치

### ClawHub (추천)
```bash
openclaw skill install tistory-publish
```

### GitHub에서 직접
```bash
openclaw skill install garibong-labs/tistory-automation
```
## 사용 방법

### 전제 조건

- [OpenClaw](https://github.com/openclaw/openclaw) 설치 + Playwright 브라우저 프로필
- 티스토리 블로그 (Kakao 계정 로그인)
- Node.js 18+

### 실행

이 저장소는 OpenClaw 에이전트의 워크스페이스로 설계되었습니다. 에이전트가 `MK-PUBLISH-RUNBOOK.md`를 따라 순서대로 실행합니다.

수동 실행도 가능하지만, 브라우저 자동화 환경(Playwright)이 필요합니다:

```bash
# 1. 배너 생성
node scripts/mk-banner.js

# 2. 브라우저에서 tistory-publish.js 로드 후 함수 호출
#    (Playwright evaluate 또는 브라우저 콘솔에서)
const html = buildBlogHTML({ intro, articles });
insertContent(html);
setCategory('신문 리뷰');
setTitle('[매경] 2026.03.02(월) - ...');
setTags(['매경', '매일경제', ...]);
```

자세한 순서는 [MK-PUBLISH-RUNBOOK.md](blog-drafts/MK-PUBLISH-RUNBOOK.md)를 참조하세요.

## 라이선스

MIT

## 만든 곳

[가리봉랩스](https://github.com/garibong-labs) — Solo developer with three AI agents
