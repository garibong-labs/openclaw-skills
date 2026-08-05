# tistory-publish

티스토리 블로그 자동 발행 스킬입니다. Tistory Open API 종료 이후 브라우저 자동화로 글쓰기 화면을 조작합니다. TinyMCE 본문 삽입, 카테고리 선택, 태그 등록, OG 카드 생성, 배너 업로드, 대표이미지 설정, 공개/비공개 발행을 처리합니다.

## 핵심 스크립트

```
scripts/
├── publish-post.sh           # 현재 권장 발행 오케스트레이터
├── login.sh                  # 카카오/Tistory 로그인 세션 복구
├── tistory-editor-helpers.js # TinyMCE/OG/태그/이미지 helper
├── publish.sh                # legacy 발행 스크립트
└── tistory-publish.js        # legacy JS helper
```

새 워크플로우는 `publish-post.sh`를 기준으로 작성합니다. `publish.sh`와 `tistory-publish.js`는 오래된 파이프라인 호환용입니다.

## 빠른 시작

`publish-post.sh`는 안전장치로 직접 실행을 막습니다. 승인된 wrapper나 오케스트레이터에서 아래 환경변수를 명시해야 합니다.

```bash
export ALLOW_DIRECT_TISTORY_PUBLISH=1

bash scripts/publish-post.sh \
  --title "글 제목" \
  --body-file body.html \
  --category "카테고리명" \
  --blog "your-blog.tistory.com" \
  --cdp-port 18800
```

비공개 저장:

```bash
ALLOW_DIRECT_TISTORY_PUBLISH=1 \
bash scripts/publish-post.sh \
  --title "글 제목" \
  --body-file body.html \
  --category "카테고리명" \
  --blog "your-blog.tistory.com" \
  --cdp-port 18800 \
  --private
```

매경 리뷰 preset 예시:

```bash
ALLOW_DIRECT_TISTORY_PUBLISH=1 \
bash scripts/publish-post.sh \
  --template mk-review \
  --article-title "기사 제목" \
  --body-file body.html \
  --banner /tmp/banner.jpg \
  --tags "매경,경제뉴스" \
  --blog "anthropic.tistory.com" \
  --category "재테크 이야기/경제신문 리뷰" \
  --cdp-port 18800
```

## 발행 옵션 (`publish-post.sh`)

| 옵션 | 필수 | 설명 |
|------|------|------|
| `--title` | ✅ | 최종 글 제목 |
| `--body-file` | ✅ | 본문 HTML 파일 |
| `--category` | ✅ | 티스토리 에디터에 표시되는 카테고리 이름 |
| `--template` | | preset 이름 (`mk-review`, `daum-trends`, `simple-post`) |
| `--article-title` | | `mk-review`용 기사 제목. 날짜 접두사 자동 생성 |
| `--tags` | | 쉼표 구분 태그 목록 |
| `--banner` | | 배너 이미지 파일. 업로드 후 대표이미지 후보가 됨 |
| `--blog` | | 블로그 도메인 |
| `--cdp-port` | | Chrome CDP 포트. 운영 파이프라인에서는 명시 권장 |
| `--helper` | | `tistory-editor-helpers.js` 경로 |
| `--private` | | 비공개 저장 |
| `--require-public-image-figures` | | 공개 페이지 image figure 최소 개수 요구. 기본 0 |

## Daum Trends preset

`daum-trends` preset is intentionally target-agnostic. It only supplies Daum Trends content defaults such as tags. The caller or wrapper must pass `--blog` and `--category` explicitly.

```bash
ALLOW_DIRECT_TISTORY_PUBLISH=1 bash scripts/publish-post.sh \
  --template daum-trends \
  --title "Daum 실시간 트렌드 ..." \
  --body-file body.html \
  --blog "$DAUM_TRENDS_TISTORY_BLOG" \
  --category "$DAUM_TRENDS_TISTORY_CATEGORY" \
  --cdp-port "$TISTORY_CDP_PORT"
```

## 주요 환경변수

| 변수 | 설명 |
|------|------|
| `ALLOW_DIRECT_TISTORY_PUBLISH=1` | 필수 안전장치. wrapper/오케스트레이터가 명시해야 실행됨 |
| `TISTORY_CDP_PORT` | `--cdp-port` 기본값으로 사용 |
| `TISTORY_LOGIN_SCRIPT` | 로그인 복구 스크립트 경로. 기본값은 `scripts/login.sh` |
| `TISTORY_LOGIN_CRED_FILE` | 로그인 복구용 자격증명 파일. `login.sh`에서만 사용 |
| `TISTORY_INLINE_IMAGE_FILES` | `:` 구분 이미지 파일 목록. 본문 이미지 marker에 업로드/배치 |
| `REQUIRE_PUBLIC_IMAGE_FIGURES=N` | 공개 페이지 검증 시 image figure 최소 개수를 요구. 기본값 0, 콘텐츠 정책 opt-in |
| `ALLOW_MISSING_IMAGES=1` | legacy 호환용. opt-in 이미지 정책 실패를 hard fail 대신 warning으로 낮춤 |
| `RUN_TOKEN` | 발행 전후 글 목록 비교용 실행 토큰 |
| `PUBLISH_TRACE_FILE` | 발행 trace 로그 저장 경로 |
| `DIRECT_NOTIFY_CHANNEL` / `DIRECT_NOTIFY_ACCOUNT` | wrapper가 직접 결과 알림을 보낼 때 사용 |
| `TISTORY_PUBLISH_LOCK` | 발행 잠금 활성화. 기본값 `1`. `0`으로 비활성화 |
| `TISTORY_PUBLISH_LOCK_TIMEOUT_SECONDS` | 잠금 대기 제한 시간(초). 기본값 `1200` |
| `TISTORY_PUBLISH_LOCK_MODE` | `wait`(대기, 기본) 또는 `fail`(즉시 실패) |

`publish-post.sh`가 로그인 복구를 실행할 때는 현재 발행 대상의 `--blog`와 `--cdp-port`를 그대로 `login.sh`에 전달한다. `login.sh`도 `--cdp-port`를 직접 받으며, 인자가 없으면 `TISTORY_CDP_PORT` 값을 기본값으로 사용한다.

## 중복 발행 방지

자동화 runner에서 `publish-post.sh` 실행이 `Command still running (session <id>, pid <pid>)` 형태로 background 처리되면 실패가 아닙니다. 같은 명령을 다시 실행하지 말고 해당 session의 최종 stdout/stderr를 회수해야 합니다.

- OpenClaw runner: `process poll`로 종료까지 기다린 뒤 `process log` 또는 최종 결과에서 `TISTORY_POST_URL=` / JSON `postUrl` 확인
- URL을 찾지 못한 경우: 재실행 전에 RSS와 관리글 목록에서 같은 제목이 이미 발행됐는지 확인
- `publish-post.sh`는 공개 발행 버튼을 누르기 직전에 RSS와 관리글 목록을 조회해 같은 제목이 있으면 `duplicate preflight failed`로 중단
- `mk-review` preset은 제목이 달라도 같은 `[매경] YYYY.MM.DD(요일)` 날짜 prefix의 기존 글이 있으면 중단

## 동시 발행 잠금

같은 블로그(또는 같은 CDP 포트)에서 두 발행 작업이 동시에 실행되면 뒤에 시작한 작업이 앞 작업의 에디터 탭을 닫아 `TargetClosedError`가 발생할 수 있습니다. 이를 방지하기 위해 `publish-post.sh`는 Playwright CDP attach 전에 `fcntl.flock` 기반 파일 잠금을 획득합니다.

- 잠금 키: 블로그 도메인 우선, 없으면 CDP 포트
- 잠금 파일: `/tmp/tistory-publish-{key}.lock`
- `TISTORY_PUBLISH_LOCK_MODE=wait` — 다른 작업이 끝날 때까지 대기 (기본값)
- `TISTORY_PUBLISH_LOCK_MODE=fail` — 잠금을 즉시 획득할 수 없으면 `publish/lock-busy` 오류로 종료
- 잠금은 브라우저 종료 후 해제되며, 비정상 종료 시에도 `atexit`로 해제됩니다

`TargetClosedError`가 발생하면 `publish/target-closed` 오류 코드와 함께 동시 발행 또는 외부 브라우저 종료 가능성을 안내합니다.

## 이미지 업로드 복구

inline 이미지와 배너는 같은 업로드 helper를 사용합니다. helper는 `첨부 → 사진` 메뉴를 연 뒤 `#openFile` 또는 image accept 속성을 가진 file input이 DOM에 붙을 때까지 기다립니다. Tistory가 input id를 바꾼 경우에도 file input이 하나뿐이면 그 input을 사용합니다.

input 생성이나 파일 주입이 실패하면 메뉴를 다시 열며 2초, 4초 간격으로 최대 3회 시도합니다. 최종 실패 시 `PUBLISH_TRACE_FILE` 경로를 기준으로 현재 DOM HTML과 전체 페이지 스크린샷을 기록한 뒤 발행을 중단합니다.

## 이미지 검증 규칙

`publish-post.sh`는 두 단계에서 이미지를 확인합니다.

1. `TISTORY_INLINE_IMAGE_FILES`가 있으면 업로드된 inline 이미지 수가 입력 파일 수와 맞는지 검사합니다.
2. 공개 발행 후 공개 페이지에서 이미지 figure 수를 확인합니다.

Daum Trends처럼 이미지 3장이 글의 핵심 산출물인 파이프라인은 wrapper 단계에서 이미지 파일 수를 먼저 검증하고, 공개 페이지 figure 검증이 필요할 때만 `REQUIRE_PUBLIC_IMAGE_FIGURES=3`을 명시합니다. 이미지가 선택 사항인 글(OpenClaw 릴리즈 노트, 단순 공지 등)은 기본값 그대로 두면 이미지 개수로 hard fail 하지 않습니다.

## 자동 처리 흐름

1. CDP로 Chrome에 attach
2. 새 글 페이지 열기
3. 로그인 페이지로 redirect되면 같은 blog/CDP 포트로 `login.sh` 세션 복구 시도
4. helper JS 주입
5. 카테고리와 제목 입력
6. 본문 HTML 삽입 및 TinyMCE 저장 동기화
7. inline 이미지 marker 처리
8. 배너 업로드
9. OG 카드 생성과 cleanup
10. 대표이미지 설정
11. 태그 등록
12. 중복 제목 preflight(RSS/관리글)
13. 공개/비공개 발행
14. 최신 글 확인 및 공개 페이지 검증
15. JSON 결과 출력

성공 시 마지막 줄에 JSON을 출력합니다.

```json
{"success":true,"url":"https://.../manage/posts/","postUrl":"https://blog.tistory.com/123","postId":"123"}
```

실패 시 `success:false` JSON을 출력하고 non-zero로 종료합니다.

## 본문 HTML 작성 규칙

- 단락은 `<p data-ke-size="size16">...</p>` 사용
- OG 카드 위치는 `<p data-og-placeholder="https://example.com">&#8203;</p>` 사용
- inline 이미지 위치는 `<p data-image-marker="trend-image-1">&#8203;</p>` 같은 marker 사용
- 구분선은 `<hr contenteditable="false" data-ke-type="horizontalRule" data-ke-style="style1">` 사용
- 외부 이미지 URL 직접 삽입보다 로컬 파일 업로드 후 Tistory CDN URL 사용을 권장

## 전제 조건

- Chrome CDP에 Playwright가 attach 가능한 상태
- 티스토리 로그인 세션 또는 `login.sh`로 복구 가능한 자격증명
- Python 3 + Playwright
- Node.js 18+ (배너 생성 스크립트 사용 시)

CDP attach preflight:

```bash
python3 - <<'PY'
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp('http://127.0.0.1:18800', timeout=15000)
    print('CDP attach OK, contexts=', len(browser.contexts))
    browser.close()
PY
```

## 템플릿 추가

`templates/` 아래에 워크플로우별 폴더를 추가합니다.

```
templates/my-template/
├── RUNBOOK.md
├── TEMPLATE.md
└── banner.js
```

## 라이선스

MIT
