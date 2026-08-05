# Changelog

## Unreleased
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
