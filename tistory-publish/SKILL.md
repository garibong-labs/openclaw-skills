---
name: tistory-publish
description: Automate Tistory blog publishing via OpenClaw Playwright CDP. Supports any post format — handles TinyMCE editor manipulation, OG card insertion, banner upload, tag registration, category setting, and representative image selection. Includes template presets (mk-review, daum-trends, simple-post). Works around Tistory's isTrusted event filtering.
runtime:
  - python3
  - playwright
  - node (optional, for banner generation)
  - explicit Python interpreter with Pillow (optional, required for MK Stage3 external validator)
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
| `--cdp-connect-timeout-ms` | | 실제 Playwright attach 제한: 기본 15000ms (`TISTORY_CDP_CONNECT_TIMEOUT_MS`), 허용 1000~60000ms. 성공 연결 재사용 |
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

### MK 기사 이미지 Stage3 opt-in (`publish-post.sh` 전용)

공개 `--template mk-review`에서 `--mk-article-images`와 다음 여섯 옵션을 **모두** 지정합니다: `--image-input FILE`, `--image-run-dir DIR`, `--image-validator FILE`, `--image-validator-python EXECUTABLE`, `--source-evidence-file FILE`, `--image-evidence-dir NEW_DIR`. 기존 `--body-file`은 변경하지 않은 Stage1 본문, `--banner`는 기사 네 장과 별도인 필수 배너입니다. `--private`와 legacy `TISTORY_INLINE_IMAGE_FILES`는 함께 사용할 수 없습니다. 선택 `--image-content-selector`는 공개 본문의 유일한 scope를 지정합니다.

명시적 validator는 Stage2 `validate-og.py`이며 siblings `mk_image_validation.py`/`mk_article_images.py`가 필요합니다. interpreter는 외부 코드와 Pillow를 실행할 수 있어야 하며 publisher Python 3.9와 자동으로 같다고 가정하지 않습니다. 출처 증거는 신뢰하는 수집자가 관찰한 정확한 URL → `{title, canonical}` JSON이어야 합니다. 생성/수집은 수행하지 않습니다.

필수 순서는 **CDP 전 draft → 고정 순서 네 파일의 작업별 업로드 src/SHA receipt + 별도 배너 → 발행 전 editor snapshot gate → 확인된 글 URL의 public snapshot gate**입니다. 각 gate는 현재 입력·run·원본 본문·출처 증거를 다시 검사하고 editor/public에는 receipt/snapshot을 전달합니다. 파일명/개수 추정이 아닌 작업 중 관찰한 유일한 새 첨부 노드를 사용하며, alt·figure 내부 AI figcaption과 실제 관찰한 OG `data-og-image`를 보존합니다. 기사 순서·출처 OG·이미지·요약·코멘트 대응과 배너 분리를 모두 검증합니다. gate off/SEO off/`ALLOW_MISSING_IMAGES`로 우회할 수 없습니다.

MK 대표이미지는 별도 배너 업로드에서 실제 관찰한 전체 src의 유일한 정확 일치 대상으로 선택합니다. `TISTORY_SKIP_REPRESENT_IMAGE=1|true|yes`를 거부하고, src 누락·대상 미발견/중복·버튼 미발견·helper 실패·반환 src 불일치이면 제출 전 중단합니다. 버튼 클릭/helper 성공만으로 플랫폼에 저장된 대표 상태를 입증하지 않습니다.

이 이미지 모드의 배너 alt에서만 ASCII 큰따옴표를 전각 큰따옴표(`＂`)로 바꿔 공개 저장 시 이중 escape를 피합니다. 글 제목과 legacy 모드는 바뀌지 않습니다. 공개 배너 검증은 Stage2의 공개 본문 범위에서만 수행하며, 네이티브 `imageblock` 배너도 정확한 업로드 출처·alt·가시성 및 첨부 구조를 확인해야 합니다.

Draft/editor 실패는 발행 전 중단하고 public 실패는 `success:false`, non-zero와 `postUrl`/`postId`, `automaticRetryAllowed:false`를 보존합니다. 새 private 증거 디렉터리(0700, 파일 0600)에 receipt·snapshot·gate 결과·제출 상태를 남기고 실패한 실행 탭을 보존합니다. MK 이미지 모드의 자동 사후 재저장/재발행은 없습니다. 제출 뒤 URL 미확인은 기존 글부터 수동 확인합니다. 증거 디렉터리를 재사용하거나 새 디렉터리로 자동 우회 재시도하지 않습니다.

발행 URL/ID를 확보해도 실제 공개 검증 전 실패의 phase는 바꾸지 않습니다. Step6는 `representative` phase이며 실패 JSON과 state의 `detail`에는 호출자 코드/원인을 credential 마스킹·500자 제한(절단 표시 별도)으로 동일 보존합니다. draft 사전검사 오류도 제한된 원인/validator stdout·stderr를 보고하며 증거 디렉터리를 만들지 않습니다. 기사 파일은 Stage1/2와 같은 JPEG 계약(확장자·바이트 서명 확인)만 허용합니다. 첨부는 250ms 숫자 polling으로 최대 30초 대기합니다. 임시/최종 노드의 겹침은 관찰 시작부터 최대 1000ms pending이고 유일한 노드가 된 뒤 새 500ms 안정화가 필요합니다(같은 src의 교체도 초기화). 지속된 복수 첨부·body 교체·기존 이미지 변조/src 재사용은 영구 실패입니다. 오류 정리는 해당 observer만 해제하고 실패 작업을 유지하여 재전달/다른 첨부 신뢰를 허용하지 않습니다.

최종 JSON의 이미지 증명은 `articleImageValidation`에 담습니다. `TISTORY_OG_VALIDATOR`와 기존 OG match gate가 켜져 있으면 추가 OG draft/public 검증도 명시한 이미지 interpreter·전체 이미지 context로 실행하며, public은 이미 수집한 snapshot을 사용합니다. Stage2 CLI 계약/structured success가 필요하고 거절 시 중단합니다. 꺼져 있으면 OG 성공 필드는 생략하며 필수 이미지 gate는 계속 실행합니다. 기존 속성 없는 `trend-image-N` marker는 기본/simple-post/Daum 및 legacy 경로에서 허용하지만 Stage1 전용 속성/알 수 없는 marker는 계속 차단합니다.

추가 OG validator는 진행 로그 뒤 마지막 비어 있지 않은 stdout 줄을 JSON 객체로 해석하며 정확한 `success:true`와 종료 코드 0을 요구합니다. 필수 Stage2 이미지 validator의 전체 stdout JSON 계약은 별도 유지합니다. legacy guard는 금지 marker(`legacy-guard/forbidden-markers`), 의존성/실행 장애(`infrastructure-failed`), 본문 읽기/UTF-8 오류(`input-unreadable`)를 구분하고 모두 브라우저 접근 전에 중단합니다. 의존성 import 실패에도 원시 예외/경로/credential을 내보내지 않습니다.

실제 Tistory 속성 보존/업로드/CDN 바이트/렌더링에 대한 live 호환성 증거는 없습니다. Stage2 PR285 P2 후속(OG 비이미지 embed, legacy public fallback scope)은 외부 코드를 수정/완화하지 않으며 이미지 경로는 비이미지 embed를 거부하고 scoped snapshot을 사용합니다. 생성·cron(Stage4)은 범위 밖입니다. `publish.sh`에는 우회 방지 guard만 추가하고 Stage3 기능은 legacy JS에 미러링하지 않습니다. **정확한 호출 예시·receipt 필드·실패 처리·오프라인 테스트는 [README의 Stage3 계약](README.md#mk-기사-이미지-stage3-명시적-opt-in)을 따릅니다.**

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
8. 대표이미지 설정 (MK 이미지 opt-in은 관찰한 별도 배너 src 필수, `daum-trends`는 첫 non-comic 본문 첨부를 결정적으로 선택 — 대상 미발견 시 발행 중단, 그 외는 첫 이미지)
9. 태그 등록
10. 발행 (공개/비공개)
11. `mk-review`/`daum-trends`는 발행 및 적용되는 post-publish 검증 후 해당 실행이 만든 정확한 page target만 정리. `mk-review`는 글 ID·URL 확인 및 경고·불확실성 없는 검증 완료가 필수이며, 실패·미확인·사후 재저장/검증 불확실성에서는 실행 탭 보존. Daum의 기존 성공 경로 조건(경고 허용 포함)과 다른 템플릿의 비정리 동작은 유지
12. 정리는 `cdp_owned_tab_cleanup.py` 독립 프로세스 전체 최대 5초. 캡처한 ID의 유일한 page 일치를 확인하고 1회 닫기 요청 후 유효한 target 목록에서 실제 소멸을 확인해야만 종료 로그 기록. ID 누락·종류 불일치·응답만 수신·시간 초과는 종료 미확인으로 기록하며, 성공 JSON·종료 코드 변경이나 재발행 없음. URL/제목 기반 선택·기존 사용자 탭/브라우저/context 종료 없음

## 본문 HTML 작성 규칙

- `<p data-ke-size="size16">` 태그 사용
- 단락 = 여러 문장 묶음 (`<p>` 하나에 2~4문장)
- OG 카드 위치: `<p data-og-placeholder="URL">&#8203;</p>`
- 뉴스 OG 카드 폴백 후보(선택): `<p data-og-placeholder="URL" data-og-fallback-urls="URL1 URL2">&#8203;</p>` — 같은 항목의 v.daum.net 기사 후보를 공백 구분으로 나열. 원본과 같은 URL 재시도가 모두 HTTP 500 + `code=40009`로 확정되면 첫 적격 후보를 정확히 1회 시도. 커뮤니티 카드에는 사용 금지
- **`daum-trends` 뉴스 리다이렉트의 40002 다음 기사 폴백** — 원본이 정확히 `https://cp.news.search.daum.net/p/12345` 형태(예시 ID, ASCII 숫자만)이고 원본과 같은 URL 재시도에서 각각 안전하게 연관·파싱된 HTTP 500 + `code=40002`가 확인되면, 해당 placeholder의 첫 적격 v.daum.net 후보를 정확히 1회 시도. 후보 URL 일치와 카드 수를 검증하며, 후보가 없거나 렌더가 실패·미완료이면 일반 링크 변환 없이 발행 전 중단
- **`daum-trends` 한정 plain-link 폴백**: 두 원본 시도가 모두 HTTP 500 + `code=40009`로 확정되고 적격 v.daum.net 후보가 전혀 없을 때만, 실패한 placeholder를 카드 대신 일반 출처 하이퍼링크(`data-og-plain-link` 마킹, `href`=원본 URL, `_blank`, `noopener noreferrer`)로 유지하고 최종 결과 JSON의 `ogPlainLinkFallbacks`에 URL/사유/phase를 보고. **깨진 OG는 절대 카드로 계산하지 않는다** — 카드 수 게이트는 `placeholder 수 − plain link 수`와 비교하고 마킹된 plain link 수도 별도 검증. 후보가 있으면 기존대로 후보 1회 시도 후 실패 시 fail-closed. **strict custom OG validator(`TISTORY_OG_VALIDATOR` 설정 시)가 켜져 있으면 이 폴백은 비활성화**되어 기존 엄격한 카드 의미론이 유지되며, 다른 템플릿(mk-review 등)에는 어떤 영향도 없다
- **`daum-trends` 한정 짝 소진(exhausted-pair) 40002 plain-link 폴백**: 엄격한 DCInside 짝이 계산되는 게시글 URL에서 제한된 3회 시퀀스(원본, 원본 재시도, 계산된 짝으로의 짝 폴백 정확히 1회)가 **전부 안전 연관된 HTTP 500 + `code=40002`로 확정** 실패한 경우에만 (마이너 갤러리 모바일 URL은 짝 helper가 regular `/board/view` 경로를 계산하지만 실제 canonical은 `/mgallery/board/view`라 짝도 같은 40002로 죽는 부류), 원본 URL(계산된 짝이 아님)을 위와 같은 일반 출처 하이퍼링크로 유지하고 `ogPlainLinkFallbacks`에 보고 (짝 시도가 짝 URL로 키잉해 둔 pending 문단은 변환 전에 `prepareOGRetry`로 원본 URL에 재바인딩 — 추가 Enter/scrap 시도 없음). **깨진 OG나 실패한 짝은 절대 카드로 계산하지 않는다**. 짝 시도 성공은 기존대로 카드로 유지·계산되고, 짝이 없거나 짝 시도에 도달하지 못한 40002 실패, 시퀀스 종류/순서/횟수 불일치, 짝 URL 불일치, 미관측/미파싱/타 상태/타 코드는 전부 기존 fail-closed abort. 40009 케이스와 같은 opt-in 게이트를 공유하므로 **custom OG validator가 켜져 있으면 이 폴백도 비활성화**되며, 다른 템플릿에는 영향 없다
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
- `prepareOGRetry(fromUrl, toUrl)` — 실패한 시도의 pending 문단 재사용 (같은 URL 재시도 / DCInside 짝 폴백 / Daum 다음 기사 폴백)
- `dcinsidePairedOGUrl(url)` — 엄격한 DCInside 모바일↔데스크톱 게시글 짝 계산 (그 외 URL은 null)
- `verifyOGCard(url)` — 카드 렌더링 확인 (엄격한 DCInside 짝은 같은 글로 인정)
- `convertPendingToPlainLink(url)` — 확정 500/40009 + 후보 없음일 때 실패한 pending 문단을 일반 출처 링크로 변환 (`data-og-plain-link` 마킹, daum-trends 폴백 전용)
- `verifyOGPlainLink(url)` — plain-link 변환 결과 검증 (marker/href/`_blank`/`noopener noreferrer` 확인, 실패 시 발행 중단)

### 메타데이터
- `setTags(tags[])` — 태그 등록
- `setRepresentImageFromEditor(options?)` — 대표이미지 설정. 현재 helper의 MK 전용 `{targetSrc}`는 전체 src의 유일한 정확 일치만 허용. 기존 `{targetFilename}`은 `data-filename`/`src` 매칭으로 대상 미발견 시 실패 반환 (옵션 없는 기본: 첫 이미지)
- `setImageAlt(alt, index)` — 에디터 내 이미지 alt 텍스트 설정 (SEO)
- `setImageAltForUploadedImage(alt, filename, previousCount)` — 업로드 직후 새 이미지 alt 텍스트 설정 (기존 이미지 덮어쓰기 방지)

### 배너
- `verifyBannerUpload()` — 업로드 확인

## 알려진 제약

- `isTrusted=false` 이벤트 무시 → OG/태그에 우회 로직 필요
- 사진 업로드는 transient file chooser 이벤트를 먼저 포착하고 동적 DOM input을 fallback으로 사용하며, 3회 지수 백오프 재시도 후에도 둘 다 없으면 DOM/스크린샷을 기록하고 중단
- 카테고리가 ARIA combobox → Playwright click 필요
- 대표이미지 셀렉터가 Tistory 업데이트마다 변경 가능

## 변경 이력

[CHANGELOG.md](CHANGELOG.md) 참조

### CDP 연결 실패 진단 (현재 publish-post.sh)

발행 잠금 뒤 에디터 생성·로그인 전에 실제 연결을 확인합니다. 실패 시 최대 5초의 별도 프로세스에서 최대 8개 target을 target당 750ms 이내로 진단하고 `publish/cdp-attach-failed`로 중단합니다. 선택 `websocket-client`가 있으면 직접 page 채널의 상수 평가 응답으로 `responsive`를 확인하며, 연결 후 평가 시간 초과는 `unresponsive`, 모듈 부재·전송/평가 오류·지원 밖 종류·예산 소진은 `unknown`입니다. HTTP/target 목록 응답만으로 건강하다고 판정하지 않습니다.

단계·시간·제한된 id/type·상태만 기록하고 URL 전체(origin/path 포함), 제목, 원시 예외 등은 생략합니다. 기존 탭 자동 종료·reload·브라우저 재시작은 하지 않습니다. 기존 URL 기반 newpost 정리는 제거했고, 발행 잠금과 기존 게이트·실행 소유 target의 성공 후 정리는 유지합니다. 레거시 발행/로그인 경로는 변경하지 않습니다. 과거 장애 target은 확인되지 않았으며 진단 타임아웃으로 원인 탭을 확정하지 않습니다. 상세 제한은 README의 CDP 연결 preflight 절을 따릅니다.
