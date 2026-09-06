# Changelog

## Unreleased
- **Daum Trends 발행 탭 누적 방지**
  - `daum-trends`가 발행과 기존 post-publish 검증을 모두 성공한 뒤, 그 실행이 생성한 정확한 CDP page target만 최대 5초로 best-effort 종료
  - 다른 탭을 URL로 추측하거나 실패 경로에서 정리하지 않으며, target 식별·종료 실패는 성공 결과를 바꾸지 않음
  - exact target 식별, 대상 한정, cleanup 예외 격리 regression 테스트 추가
- **확정 500/40009 Daum 다음 기사 폴백** (뉴스 OG 카드 지속 scrap 실패 대응)
  - 뉴스 OG placeholder가 같은 트렌드 항목의 ordered 후보를 `data-og-fallback-urls`(공백 구분)로 실어 오면, 원본 1회 + 같은 URL 재시도 1회가 **둘 다 안전 연관된 HTTP 500 + payload `code=40009`로 확정**된 경우에만 첫 적격 v.daum.net 기사 후보를 정확히 1회 시도 (같은 URL 재시도 없음, 2차 후보 없음)
  - 후보 적격성은 보수적 v.daum.net 기사 계약(`/v/<id>`, query/fragment 금지)으로 재검증 — 검색 페이지·다른 Daum 서비스·커뮤니티 URL·외부 언론사·현재 URL·중복은 제외. 후보가 없으면 기존 fail-closed abort 유지
  - generic `found=false`, timeout, 미관측/미파싱 응답, 500 아닌 상태, 40009 아닌 코드(40002 포함), 1회 확정+1회 불명은 Daum 폴백 금지. **확정 40002 DCInside 짝 폴백은 그대로이며 Daum이나 다른 호스트로 넓히지 않음**
  - JS helper에 `getOGPlaceholderEntries()` 추가 — placeholder별 URL + 후보 목록 반환 (속성 없음/파싱 불가 시 빈 후보로 fail-closed). Step 5와 unexpected-navigation 복구 경로는 같은 candidate-aware `render_og_cards()`와 같은 per-placeholder 후보를 공유
  - regression 테스트 추가: URL 계약/후보 선택/entries 정규화, 확정 500/40009 폴백 성공·실패·후보 없음, 미확정 변형 비폴백, DCInside 40002 불변, count 게이트
- **daum-trends 대표이미지를 만화가 아닌 primary keyword 본문 첨부로 결정적으로 선택**
  - `setRepresentImageFromEditor(options)`에 `targetFilename` 지원 추가 — `data-filename`/`src` 매칭으로 대상 이미지를 선택하고, 대상이 없으면 클릭 없이 실패 반환 (첫 이미지 fallback 금지). `tistory-editor-helpers.js`/`tistory-publish.js` 양쪽 동기화
  - `publish-post.sh` Step 6: `--template daum-trends`는 inline 이미지 중 첫 non-comic(`00-comic.*` 제외) 파일을 대표이미지 대상으로 결정하고, 대상 미해결·선택 실패 시 발행을 중단 (만화가 대표이미지로 silent 선택되는 것 방지). 다른 템플릿은 기존 첫 이미지 동작 유지
  - regression 테스트 추가: JS 대상 선택/기본 동작/대상 미발견, Python `resolve_represent_image_target` (comic 변형·경로·실패 케이스)
- **OG 카드 제한 재시도 + 확정 40002 DCInside 짝 폴백** (2026-08-13 발행 abort 대응)
  - Step 5와 unexpected-navigation 복구 경로를 공용 `render_og_cards()`로 통합 (드리프트 방지, 복구 경로 helper JS 재주입 보장)
  - 카드 미생성 시 원본 placeholder URL을 제한된 지수 백오프로 정확히 1회 재시도 (`TISTORY_OG_RETRY_BACKOFF_BASE_S`/`_MAX_S`)
  - 각 Enter 시도에 연관된 인증 Tistory `/manage/scrap` 응답을 Playwright로 포착·분류하고, 두 원본 시도 모두 payload `code=40002`로 확정된 경우에만 엄격한 DCInside 모바일/데스크톱 짝 URL(`m.dcinside.com/board/<g>/<no>` ↔ `gall.dcinside.com/board/view/?id=<g>&no=<no>`)을 정확히 1회 시도. 미관측/미파싱 응답, HTTP 오류, generic `found=false`는 기존 fail-closed 유지
  - `getOGCardStatus()`가 엄격한 DCInside 짝을 같은 글로 인정 (모바일 scrap 성공 시 카드가 데스크톱 canonical URL을 담는 케이스) — 그 외 URL은 기존 정규화-일치 유지
  - JS helper에 `prepareOGRetry(fromUrl, toUrl)`, `dcinsidePairedOGUrl(url)` 추가 (`tistory-editor-helpers.js`, `tistory-publish.js`)
  - 모든 변형 실패 시 시도·분류 진단(payload 본문 제외)과 함께 발행 중단
- Tistory 사진 메뉴가 transient input을 바로 제거하는 경우를 위해 Playwright file chooser 이벤트를 클릭 전에 포착하고 직접 파일을 전달하도록 이미지 업로드 경로 보강
- 업로드 실패 DOM 상태 수집기의 JavaScript 닫는 괄호 오류 수정 및 실제 식 문법 회귀 테스트 추가
- inline 이미지와 배너 업로드를 공용 helper로 통합하고, Tistory의 동적 file input 생성 지연에 대해 3회 지수 백오프 재시도를 추가
- `#openFile`이 없어도 image accept input 또는 단일 file input을 안전하게 탐색하며, 최종 실패 시 DOM HTML과 스크린샷 기록
- **SEO 지원 추가**
  - `scripts/seo_check.py` 신규: 발행 전 SEO 정적 검사 (제목 길이/키워드 위치, 도입부(메타 디스크립션) 존재·분량, h2/h3 구조, 이미지 alt, 내부/외부 링크, 본문 분량, 태그 중복·개수)
  - `publish-post.sh`/`publish.sh`에 `--seo-check off|warn|strict`, `--seo-keyword`, `--seo-min-body-chars` 옵션 추가 (`TISTORY_SEO_CHECK` 환경변수로 기본값 지정 가능)
  - `strict` 모드에서는 본문 최소 글자수 미달도 발행 중단 error로 처리
  - `--banner-alt` 옵션 추가: 배너 업로드 후 새로 추가된 이미지에 alt 텍스트 설정 (미지정 시 제목 사용 — 빈 alt 업로드 방지)
  - JS helper에 `setImageAlt(alt, index)`, `setImageAltForUploadedImage(alt, filename, previousCount)` 추가 (`tistory-editor-helpers.js`, `tistory-publish.js`)
  - SKILL.md에 본문 SEO 작성 규칙 문서화
- `mk-review` preset 기본 발행 대상을 `anthropic.tistory.com` / `재테크 이야기/경제신문 리뷰`로 변경
- `publish-post.sh` 기본 CDP 포트를 Ruth/Tistory 운영 포트인 `18800`으로 정렬
- `publish-post.sh` 로그인 자동 복구가 현재 `--blog`와 `--cdp-port`를 `login.sh`에 전달하도록 수정
- `login.sh`에서 `--blog` 옵션과 `TISTORY_CDP_PORT` 기본값 지원

## v5.1.2 (2026-03-28)
- OpenClaw 보안 스캔 Suspicious 지적 수정 (메타데이터 불완전)
- frontmatter에 `runtime` 및 `credentials` 필드 선언 추가
- 전제 조건에 자격증명 파일 경로 및 용도 명시
- `publish.sh`는 자격증명을 읽지 않음을 문서에 명시

## v5.1.1 (2026-03-28)
- 보안 스캔(VirusTotal/OpenClaw) 지적 수정
- `publish.sh`에서 자격증명 처리 코드 제거 → 세션 만료 시 에러 메시지 + `scripts/login.sh` 안내로 대체
- 로그인 기능을 `scripts/login.sh` 전용 스크립트로 분리

## v5.1.0 (2026-03-28)
- 카카오 로그인 세션 만료 시 자동 재로그인 기능 추가 (deprecated by v5.1.1)

## v5.0.3 (2026-03-27)
- OpenClaw security scan 지적 수정
- `banner.js`: `child_process.execSync` 제거
- `deep-dive.js`: 미사용 `child_process` import 제거

## v5.0.2 (2026-03-27)
- VirusTotal security scan 지적 수정
- `publish.sh`: Canvas Drop fallback 제거 (base64/atob 패턴), `subprocess` → `datetime` 교체
- `tistory-publish.js`: 레거시 함수에 LEGACY 주석 추가

## v5.0.0 (2026-03-27)
- **agent-browser → OpenClaw Playwright CDP 전환** (networkidle hang 해결)
- 단일 Python 스크립트 내장 (bash → Python heredoc)
- `--template` preset 지원 (mk-review, simple-post)
- `--article-title` 자동 날짜 접두사 생성
- `--cdp-port` 옵션 추가
- 배너: Playwright `set_input_files`로 업로드
- 빈 본문 방지: 발행 직전 `save()` + textarea 길이 검증
- 비공개 저장: 다이얼로그 닫힘 확인
- 레거시 삭제: `agent-browser-mk-publish.sh`, `tistory_post.py`, `tistory_post_cdp.py`

## v4.1.0 (2026-03-23)
- 본문 삽입 후 길이 검증 추가
- 발행 후 공개 페이지 재검증 추가

## v4.0.0 (2026-03-07)
- 범용 스킬로 재설계: 매경 리뷰 전용 → 어떤 포맷이든 발행 가능
- 범용 `publish.sh` 스크립트 추가
- 매경 리뷰를 `templates/mk-review/` 예시로 이동
- 단순 발행 예시 `templates/simple-post/` 추가

## v3.0.0 (2026-03-07)
- OpenClaw Playwright → agent-browser 전환
- 카테고리: JS eval → Playwright native ARIA combobox click
- 배너: base64 chunk → agent-browser upload
