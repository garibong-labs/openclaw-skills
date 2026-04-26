# tistory-publish

티스토리 블로그 범용 자동 발행 스킬. OpenClaw Playwright CDP로 TinyMCE 에디터를 조작해 어떤 형식의 글이든 자동 발행합니다.

## 왜 브라우저 자동화?

티스토리 Open API가 2024년 2월에 종료됐습니다. 공식 API 없이 발행하려면 브라우저를 직접 제어하는 수밖에 없습니다.

## 빠른 시작

```bash
# 설치
clawhub install tistory-publish

# 가장 단순한 발행 (권장 래퍼)
bash scripts/publish.sh \
  --title "글 제목" \
  --body-file body.html \
  --category "카테고리명" \
  --blog "your-blog.tistory.com"

# 저수준 발행 엔진 직접 호출 (자동화/파이프라인용)
ALLOW_DIRECT_TISTORY_PUBLISH=1 bash scripts/publish-post.sh \
  --title "글 제목" \
  --body-file body.html \
  --category "카테고리명" \
  --blog "your-blog.tistory.com" \
  --cdp-port 18800
```

## 기능

- **본문 삽입**: HTML → TinyMCE 에디터 (`data-ke-*` 속성 지원)
- **OG 카드**: URL placeholder → 자동 카드 렌더링 (`isTrusted` 우회)
- **배너/이미지**: 파일 업로드 → 대표이미지 자동 설정
- **카테고리**: ARIA combobox 자동 선택
- **태그**: nativeSetter 패턴으로 `isTrusted` 필터링 우회
- **공개/비공개**: `--private` 플래그로 제어

## 구조

```
scripts/
├── tistory-publish.js       # 코어 — 에디터 조작 함수 모음
├── tistory-editor-helpers.js # TinyMCE/티스토리 에디터 보조 함수
├── publish.sh               # 사용자를 위한 권장 래퍼
├── publish-post.sh          # 파이프라인용 저수준 발행 엔진
└── login.sh                 # 카카오/티스토리 로그인 확인 및 복구

templates/
├── mk-review/            # 예시: 신문 리뷰 (배너+OG 카드)
│   ├── RUNBOOK.md
│   ├── TEMPLATE.md
│   └── banner.js
└── simple-post/           # 예시: 단순 글 발행
    └── RUNBOOK.md
```

## 발행 옵션

| 옵션 | 필수 | 설명 |
|------|------|------|
| `--title` | ✅ | 글 제목 |
| `--body-file` | ✅ | 본문 HTML 파일 경로 |
| `--category` | ✅ | 카테고리 이름 |
| `--tags` | | 쉼표 구분 태그 |
| `--banner` | | 배너 이미지 경로 |
| `--blog` | | 블로그 도메인 |
| `--private` | | 비공개 발행 |
| `--cdp-port` | | 연결할 Chrome CDP 포트 (`TISTORY_CDP_PORT`와 같은 용도) |

## `publish.sh`와 `publish-post.sh`

- `publish.sh`: 사람이 직접 쓰기 좋은 권장 진입점입니다. 템플릿 옵션과 기본값을 정리해서 `publish-post.sh`를 호출합니다.
- `publish-post.sh`: 매경 리뷰, Daum 트렌드, OpenClaw 릴리즈 같은 자동화 파이프라인이 직접 호출하는 저수준 엔진입니다. 안전 가드 때문에 직접 호출할 때는 `ALLOW_DIRECT_TISTORY_PUBLISH=1`을 명시해야 합니다.

`publish-post.sh` 주요 환경변수:

| 환경변수 | 설명 |
|----------|------|
| `ALLOW_DIRECT_TISTORY_PUBLISH=1` | 저수준 엔진 직접 호출 허용 |
| `TISTORY_CDP_PORT` | 기본 CDP 포트. `--cdp-port`가 있으면 해당 인자가 우선 |
| `TISTORY_INLINE_IMAGE_FILES` | `:` 구분 이미지 파일 목록. 본문 inline 이미지 업로드에 사용 |
| `ALLOW_MISSING_IMAGES=1` | 공개 페이지 이미지 figure 3개 미만 검증을 hard fail 대신 warning으로 처리 |
| `PUBLISH_TRACE_FILE` | 발행 trace 로그 파일 경로 |
| `DIRECT_NOTIFY_CHANNEL` / `DIRECT_NOTIFY_ACCOUNT` | 발행 성공 URL을 Discord 등으로 직접 알릴 때 사용 |

주의:

- `publish-post.sh`는 공개 발행 후 본문 길이, OG 카드 gap, 이미지 figure 수 등을 재검증합니다.
- 이미지 3개 이상 검증은 Daum 트렌드처럼 “키워드 3개 → 이미지 3개” 구조의 파이프라인을 보호하려고 들어간 가드입니다.
- 이미지가 필수가 아닌 글(OpenClaw 릴리즈 노트 등)은 `ALLOW_MISSING_IMAGES=1`을 켜거나, 호출 래퍼에서 템플릿별 검증 정책을 분리해야 false negative를 피할 수 있습니다.

## 기술 스택

- **브라우저**: OpenClaw Playwright CDP (`connect_over_cdp`)
- **에디터**: TinyMCE DOM API, `setContent`, `save`, native 이벤트 보조
- **배너 생성**: Node.js Canvas (`@napi-rs/canvas`, 선택)
- **OG 카드**: JS(URL 준비) + Playwright(Enter 키) 조합
- **태그**: helper 함수 + 이벤트 디스패치

## 나만의 템플릿 만들기

`templates/` 안에 폴더를 추가하면 됩니다:

```
templates/my-template/
├── RUNBOOK.md       # 발행 순서
├── TEMPLATE.md      # 원고 작성 가이드
└── banner.js        # 배너 생성 (선택)
```

## 전제 조건

- OpenClaw 브라우저 서비스(CDP) 실행 가능 환경
- 티스토리 카카오 로그인 완료(OpenClaw Chrome)
- Python 3 + Playwright
- Node.js 18+ (배너 생성 시)

## 라이선스

MIT
