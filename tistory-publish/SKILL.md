---
name: tistory-publish
description: Automate Tistory blog publishing via agent-browser (Playwright-based CLI). Handles TinyMCE editor manipulation, OG card insertion, banner upload, tag registration, category setting, and representative image selection. Works around Tistory's isTrusted event filtering.
---

# Tistory Publish

티스토리 블로그 자동 발행 스킬. Tistory Open API 종료(2024.02) 이후 유일한 자동화 경로인 브라우저 자동화를 제공합니다.

## 전제 조건

- [agent-browser](https://github.com/anthropics/agent-browser) CLI 설치 + 프로필 생성
- 티스토리 블로그 (Kakao 계정 로그인 완료 상태의 프로필)
- Node.js 18+ (`@napi-rs/canvas` — 배너 생성용, 선택)

## 브라우저 자동화 방식

**v3.0부터 agent-browser 기반으로 전환.** 기존 OpenClaw 내장 Playwright(`profile="openclaw"`)는 더 이상 사용하지 않습니다.

| 항목 | 기존 (Playwright) | 현재 (agent-browser) |
|------|-------------------|---------------------|
| 브라우저 제어 | OpenClaw browser tool | agent-browser CLI |
| 카테고리 선택 | JS eval (`setCategory()`) | Playwright native click (ARIA combobox) |
| 배너 업로드 | base64 chunked inject | `agent-browser upload` (파일 입력) |
| 안정성 | 타임아웃 빈발, CDP 충돌 | 타임아웃 0회, 충돌 0회 |
| 속도 | 60~90초 | ~60초 (배너+OG 4개 포함) |

## 핵심 파일

| 파일 | 용도 |
|------|------|
| `scripts/tistory-publish.js` | 에디터 조작 함수 모음 (agent-browser eval로 로드) |
| `scripts/mk-banner.js` | 배너 이미지 생성 (1150×630, 선택) |
| `blog-drafts/MK-PUBLISH-RUNBOOK.md` | 발행 순서 런북 예시 |
| `blog-drafts/TEMPLATE-mk-review.md` | 원고 작성 템플릿 예시 |

## 발행 워크플로우 (요약)

```
0. 배너 생성 (선택): node scripts/mk-banner.js
1. 새 글 페이지: agent-browser navigate → /manage/newpost
2. JS 헬퍼 주입: agent-browser eval로 tistory-publish.js 로드
3. 카테고리 선택: agent-browser click (ARIA combobox → option)
4. 제목 입력: agent-browser eval (base64 디코딩)
5. 본문 삽입: insertContent(html)
6. 배너 업로드: 첨부→사진 메뉴 → agent-browser upload #openFile
7. OG 카드: prepareOGPlaceholder() → agent-browser press Enter → verifyOGCard()
8. 대표이미지: setRepresentImageFromEditor()
9. 태그: setTags([...])
10. 발행: clickPublish() 또는 agent-browser click
```

## 주요 함수 (`tistory-publish.js`)

모든 함수는 `agent-browser eval`로 실행. 스크립트를 먼저 페이지에 로드한 뒤 호출.

### 콘텐츠 삽입
- `buildBlogHTML({intro, articles})` — HTML 생성 (OG placeholder 포함)
- `insertContent(html)` — TinyMCE에 HTML 삽입 (CodeMirror 동기화)
- `registerSchema()` — `data-ke-*` 속성 허용 등록 (insertContent 전 호출)

### OG 카드 (isTrusted 우회 필수)
- `getOGPlaceholders()` — placeholder URL 목록 반환
- `prepareOGPlaceholder(url)` — placeholder를 URL 텍스트로 교체 + 커서 위치
- `verifyOGCard(url)` — OG 카드 렌더링 확인 + URL 잔여물 정리
- `cleanupOGResiduals()` — 남은 URL 텍스트 전체 정리

> ⚠️ OG 카드는 JS 단독 불가. `prepareOGPlaceholder()` 후 반드시 `agent-browser press Enter` (또는 Playwright press)로 isTrusted=true 이벤트를 보내야 Tistory OG 파서가 트리거됨.

### 배너
- `openBannerUploadInput()` — 첨부→사진 메뉴를 열어 `input#openFile` 활성화 (deprecated — agent-browser에서는 직접 메뉴 클릭 권장)
- `verifyBannerUpload()` — 업로드된 이미지가 서버 URL인지 확인

### 메타데이터
- `setCategory(name)` — ⚠️ **네이티브 `<select>` 전용** (Tistory가 ARIA combobox로 변경됨 — agent-browser click 사용 권장)
- `setTitle(title)` — 제목 입력
- `setTags(tags[])` — 태그 등록 (nativeSetter + InputEvent + KeyboardEvent)
- `clearTags()` — 기존 태그 전체 삭제

### 대표이미지
- `setRepresentImageFromEditor()` — 에디터 내 첫 번째 서버 이미지를 대표이미지로 설정

### 발행
- `clickPublish()` — 발행 버튼 클릭

## 카테고리 선택 (중요)

Tistory 에디터의 카테고리가 네이티브 `<select>`에서 **ARIA combobox**(`#category-btn` + `#category-list`)로 변경되었습니다. JS `setCategory()` 함수는 동작하지 않습니다.

**agent-browser 방식:**
```bash
agent-browser find role combobox click --name '카테고리 선택'
sleep 0.5
agent-browser find role option click --name '카테고리명'
```

## 배너 업로드 (중요)

base64 인라인 방식은 토큰/셸 한도 초과 위험이 있습니다. **파일 입력 방식 권장:**

```bash
# 첨부 → 사진 메뉴로 input#openFile 활성화
agent-browser find role button click --name '첨부'
agent-browser find role menuitem click --name '사진'
# 파일 업로드
agent-browser upload '#openFile' /path/to/banner.jpg
```

## 설정 커스터마이징

이 스킬은 신문 리뷰를 예시로 포함하고 있지만, 다른 용도로도 사용 가능합니다:

1. `blog-drafts/TEMPLATE-mk-review.md`를 복사해서 자신의 템플릿 작성
2. `buildBlogHTML()`에 전달하는 `{intro, articles}` 구조만 맞추면 어떤 콘텐츠든 발행 가능
3. 카테고리/제목/태그는 agent-browser CLI로 직접 제어
4. 배너는 `mk-banner.js`를 수정하거나 직접 이미지 파일 준비

## 알려진 제약

- Tistory 에디터가 `isTrusted=false` 이벤트를 무시 → OG/태그에 우회 로직 필요
- 배너 파일 다이얼로그를 JS로 제어 불가 → agent-browser upload 사용
- 카테고리가 ARIA combobox → JS `setCategory()` 불가, Playwright click 필요
- 대표이미지 셀렉터가 Tistory 업데이트마다 변경될 수 있음

## 변경 이력

### v3.0.0 (2026-03-07)
- **Breaking**: OpenClaw Playwright → agent-browser 기반으로 전환
- 카테고리 선택: JS eval → Playwright native ARIA combobox click
- 배너 업로드: base64 chunk inject → `agent-browser upload` (파일 입력)
- 런북을 agent-browser 워크플로우로 업데이트
- HTML 포맷 규칙 추가 (단락 묶음 필수)
- 안정성 대폭 개선 (타임아웃/CDP 충돌 제거)
