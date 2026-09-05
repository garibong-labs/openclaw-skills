---
name: tistory-publish
description: Automate Tistory blog publishing via OpenClaw Playwright CDP. Supports any post format — handles TinyMCE editor manipulation, OG card insertion, banner upload, tag registration, category setting, and representative image selection. Includes template presets (mk-review, daum-trends, simple-post). Works around Tistory's isTrusted event filtering.
runtime:
  - python3
  - playwright
  - node (optional, for banner generation)
credentials:
  - purpose: Kakao login for Tistory session recovery (used only by scripts/login.sh --cred-file)
    required: false
    format: '{"email": "...", "password": "..."}  or  email: ...\npassword: ...'
    note: Path is user-specified via --cred-file or TISTORY_CRED_FILE env var
---

# Tistory Publish

티스토리 블로그 범용 자동 발행 스킬. 어떤 형식의 글이든 자동 발행할 수 있습니다.

Tistory Open API 종료(2024.02) 이후 유일한 자동화 경로인 브라우저 자동화를 제공합니다.

## 전제 조건

- OpenClaw 브라우저 서비스 (Chrome CDP, 기본 port 18800)
- 티스토리 카카오 로그인 완료 (OpenClaw Chrome에서)
- Python 3 + Playwright (`pip install playwright`)
- Node.js 18+ (배너 생성 시, 선택)
- (선택) 카카오 자격증명 파일 — 로그인 세션 만료 시 복구용 (`scripts/login.sh --cred-file <경로>`)
  - JSON 형식: `{"email": "...", "password": "..."}`
  - 또는 key-value 형식: `email: ...\npassword: ...`
  - `publish.sh`는 자격증명을 읽지 않음 (로그인은 `login.sh`에서만 처리)
  - `publish-post.sh` 자동 복구는 현재 `--blog`와 `--cdp-port`를 `login.sh`로 전달함

## 구조

```
tistory-publish/
├── SKILL.md                     # 이 파일
├── scripts/
│   ├── tistory-publish.js       # 코어 — 에디터 조작 함수 모음
│   ├── publish.sh               # 범용 발행 스크립트
│   ├── seo_check.py             # 발행 전 SEO 정적 검사
│   └── login.sh                 # 카카오 로그인 세션 복구
└── templates/
    └── simple-post/             # 예시: 단순 글 발행
        └── RUNBOOK.md
```

## 빠른 시작

```bash
# 가장 단순한 발행
bash scripts/publish.sh \
  --title "글 제목" \
  --body-file body.html \
  --category "카테고리명" \
  --blog "your-blog.tistory.com"

# 매경 리뷰 (템플릿 사용)
bash scripts/publish.sh \
  --template mk-review \
  --article-title "기사 제목" \
  --body-file body.html \
  --banner /tmp/banner.jpg \
  --tags "매경,경제뉴스" \
  --blog "anthropic.tistory.com" \
  --category "재테크 이야기/경제신문 리뷰" \
  --cdp-port 18800

# 배너 + 태그 + 비공개
bash scripts/publish.sh \
  --title "글 제목" \
  --body-file body.html \
  --category "카테고리명" \
  --banner /tmp/banner.jpg \
  --tags "태그1,태그2,태그3" \
  --private
```

## 발행 스크립트 옵션 (`publish.sh`)

| 옵션 | 필수 | 설명 |
|------|------|------|
| `--title` | ✅ | 글 제목 |
| `--body-file` | ✅ | 본문 HTML 파일 경로 |
| `--category` | ✅ | 카테고리 이름 (에디터에 표시되는 이름 그대로) |
| `--template` | | 템플릿 preset (mk-review, daum-trends, simple-post) |
| `--article-title` | | mk-review용 기사 제목 (자동 날짜 접두사) |
| `--tags` | | 쉼표 구분 태그 목록 |
| `--banner` | | 배너 이미지 파일 경로 |
| `--banner-alt` | | 배너 이미지 alt 텍스트 (기본: 제목 — 빈 alt로 업로드되지 않도록) |
| `--blog` | | 블로그 도메인 (기본: tistory.com 첫 번째 블로그) |
| `--cdp-port` | | OpenClaw Chrome CDP 포트 (기본: `TISTORY_CDP_PORT` 또는 스크립트 기본값) |
| `--helper` | | tistory-publish.js 경로 (기본: scripts/ 내) |
| `--private` | | 비공개 발행 |
| `--seo-check` | | 발행 전 SEO 검사 모드: `off`(기본)/`warn`/`strict`. `strict`는 error 발견 시 발행 중단 |
| `--seo-keyword` | | SEO 핵심 키워드 (기본: 제목 첫 단어). 제목/도입부/소제목 내 키워드 배치 검사에 사용 |
| `--seo-min-body-chars` | `1000` | SEO 본문 최소 노출 글자수. `strict`에서는 미달 시 발행 중단 |

### 템플릿 preset

| 이름 | 카테고리 | 블로그 | 제목 형식 | 배너 |
|------|---------|--------|----------|------|
| `mk-review` | 재테크 이야기/경제신문 리뷰 | anthropic.tistory.com | `[매경] YYYY.MM.DD(요일) - 기사 제목` | 필수 |
| `simple-post` | (직접 지정) | (직접 지정) | (직접 지정) | 선택 |

> 자신만의 preset을 추가하려면 `templates/` 아래에 폴더를 만들고 `publish.sh --template <이름>` 으로 사용하세요.

### Daum Trends preset

Use `--template daum-trends` for Daum 실시간 트렌드 posts. This preset supplies content defaults such as tags only. The caller must still pass `--blog` and `--category` explicitly.

```bash
ALLOW_DIRECT_TISTORY_PUBLISH=1 bash scripts/publish-post.sh \
  --template daum-trends \
  --title "Daum 실시간 트렌드 ..." \
  --body-file body.html \
  --blog "$DAUM_TRENDS_TISTORY_BLOG" \
  --category "$DAUM_TRENDS_TISTORY_CATEGORY" \
  --cdp-port "$TISTORY_CDP_PORT"
```

세션 복구를 직접 실행할 때도 같은 포트를 명시한다:

```bash
bash scripts/login.sh \
  --cred-file "$TISTORY_LOGIN_CRED_FILE" \
  --blog "$DAUM_TRENDS_TISTORY_BLOG" \
  --cdp-port "$TISTORY_CDP_PORT"
```

## 자동 처리 항목

스크립트가 순서대로 처리:

0. SEO 검사 (`--seo-check warn|strict` 지정 시, 발행 전 정적 검사)
1. 새 글 페이지 열기
2. JS 헬퍼 함수 주입
3. 카테고리 선택 (ARIA combobox → Playwright click)
4. 제목 입력 (base64 디코딩으로 한글 처리)
5. 본문 HTML 삽입
6. inline/배너 이미지 업로드 (첨부→사진 메뉴 → file chooser 포착, 동적 file input fallback·제한 재시도) + alt 텍스트 설정
7. OG 카드 생성 (placeholder URL → Enter 키 → 카드 렌더링)
8. 대표이미지 설정 (`daum-trends`는 첫 non-comic 본문 첨부를 결정적으로 선택 — 대상 미발견 시 발행 중단, 다른 템플릿은 첫 이미지)
9. 태그 등록
10. 발행 (공개/비공개)
11. `daum-trends` 실행은 종료 상태와 무관하게 같은 블로그의 중복 글 관리/통계 탭만 정리 (종류별 1개 유지, 현재 실행 페이지·editor·login·다른 사이트 제외)

## 본문 HTML 작성 규칙

- `<p data-ke-size="size16">` 태그 사용
- 단락 = 여러 문장 묶음 (`<p>` 하나에 2~4문장)
- OG 카드 위치: `<p data-og-placeholder="URL">&#8203;</p>`
- 뉴스 OG 카드 폴백 후보(선택): `<p data-og-placeholder="URL" data-og-fallback-urls="URL1 URL2">&#8203;</p>` — 같은 항목의 v.daum.net 기사 후보를 공백 구분으로 나열. scrap이 두 시도 모두 HTTP 500 + `code=40009`로 확정될 때만 첫 적격 후보를 정확히 1회 시도. 커뮤니티 카드에는 사용 금지
- 구분선: `<hr contenteditable="false" data-ke-type="horizontalRule" data-ke-style="style1">`

### SEO 규칙 (검색 노출용 — `--seo-check`가 검사하는 항목)

Tistory는 본문 시작부를 meta description / og:description으로 사용하므로 본문 구조가 곧 검색 스니펫이다.

- **도입부 필수**: 첫 `<h2>` 이전에 80~150자 요약 문단 1개. 핵심 키워드를 첫 150자 안에 배치 (검색 결과 요약문으로 노출됨)
- **제목**: 핵심 키워드를 앞쪽(20자 이내)에 배치, 전체 60자 이하 (SERP에서 한글 30~35자만 노출)
- **소제목**: h2 2개 이상, 최소 1개 h2/h3에 핵심 키워드 포함
- **이미지 alt**: 본문 내 모든 `<img>`에 alt 필수, 배너는 `--banner-alt`로 지정
- **내부 링크**: 같은 블로그의 관련 글 2~3개 링크 (크롤링 경로 + 체류시간)
- **외부 출처**: 원문 링크 또는 OG 카드 1개 이상
- **본문 분량**: 노출 텍스트 1,000자 이상 (단순 발췌는 저품질 콘텐츠로 분류될 수 있음)
- **태그**: 5~10개, 중복 금지, 범용 키워드 + 롱테일 키워드 혼합

단독 실행:

```bash
python3 scripts/seo_check.py \
  --title "글 제목" --body-file body.html \
  --tags "태그1,태그2" --keyword "핵심키워드" \
  --blog "your-blog.tistory.com" --mode strict --min-body-chars 1000
```

## 템플릿 추가하기

`templates/` 디렉토리에 새 폴더를 만들어 자신만의 워크플로우를 추가할 수 있습니다:

```
templates/my-template/
├── RUNBOOK.md       # 발행 순서
├── TEMPLATE.md      # 원고 작성 템플릿
└── banner.js        # 배너 생성 스크립트 (선택)
```

## 주요 JS 함수 (`tistory-publish.js`)

### 콘텐츠
- `insertContent(html)` — TinyMCE에 HTML 삽입
- `buildBlogHTML({intro, articles})` — 구조화된 데이터 → HTML 변환

### OG 카드
- `getOGPlaceholders()` — placeholder URL 목록
- `getOGPlaceholderEntries()` — placeholder별 URL + ordered Daum 다음 기사 폴백 후보 목록 (`data-og-fallback-urls`, 없거나 파싱 불가 시 빈 후보로 fail-closed)
- `prepareOGPlaceholder(url)` — placeholder → URL 텍스트 교체
- `prepareOGRetry(fromUrl, toUrl)` — 실패한 시도의 pending 문단 재사용 (같은 URL 재시도 / 확정 40002 시 DCInside 짝 폴백 / 확정 500·40009 시 Daum 다음 기사 폴백)
- `dcinsidePairedOGUrl(url)` — 엄격한 DCInside 모바일↔데스크톱 게시글 짝 계산 (그 외 URL은 null)
- `verifyOGCard(url)` — 카드 렌더링 확인 (엄격한 DCInside 짝은 같은 글로 인정)

### 메타데이터
- `setTags(tags[])` — 태그 등록
- `setRepresentImageFromEditor(options?)` — 대표이미지 설정. `{targetFilename}` 지정 시 `data-filename`/`src` 매칭으로 해당 이미지만 선택하고, 없으면 클릭 없이 실패 반환 (기본: 첫 이미지)
- `setImageAlt(alt, index)` — 에디터 내 이미지 alt 텍스트 설정 (SEO)
- `setImageAltForUploadedImage(alt, filename, previousCount)` — 업로드 직후 새 이미지 alt 텍스트 설정 (기존 이미지 덮어쓰기 방지)

### 배너
- `verifyBannerUpload()` — 업로드 확인

## 알려진 제약

- `isTrusted=false` 이벤트 무시 → OG/태그에 우회 로직 필요
- 사진 업로드는 transient file chooser 이벤트를 먼저 포착하고 동적 DOM input을 fallback으로 사용하며, 3회 지수 백오프 재시도 후에도 둘 다 없으면 DOM/스크린샷을 기록하고 중단
- 카테고리가 ARIA combobox → Playwright click 필요
- 대표이미지 셀렉터가 Tistory 업데이트마다 변경 가능
- `daum-trends` 탭 정리는 같은 블로그의 정확한 `/manage/posts/`, `/manage/statistics/entry/<id>` 페이지만 대상으로 하며 editor/login/다른 블로그 페이지는 보존

## 변경 이력

[CHANGELOG.md](CHANGELOG.md) 참조
