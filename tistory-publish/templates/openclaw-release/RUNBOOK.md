# OpenClaw 릴리즈 노트 발행 런북

> bongman.tistory.com — AI-Agent/OpenClaw-Release 카테고리
> 담당: Eli (eli@garibong.dev)
> 정책: Gary 리뷰 없이 초안 완성 즉시 발행까지 자동 진행

---

## 제목 형식 (필수)

```
OpenClaw {버전} 릴리즈 노트 분석 - {핵심키워드1}, {핵심키워드2}, {핵심키워드3}
```

**예시:**
- `OpenClaw 2026.3.2 릴리즈 노트 분석 - PDF 도구, SecretRef 확대, 보안 대폭 강화`
- `OpenClaw 2026.3.7 릴리즈 노트 분석 - ContextEngine 플러그인, ACP 영속화, Telegram 토픽 라우팅`

**규칙:**
- 대괄호(`[]`) 사용 금지
- 키워드는 이번 릴리즈에서 가장 임팩트 있는 3가지 추출
- 버전은 `2026.X.X` 형식 그대로

---

## 배너 이미지 (필수)

배너 없이 발행 금지. 반드시 아래 순서로 생성 후 포스트에 포함.

### 생성

```bash
# 1. 배너 생성 스크립트 실행
node /Users/garibong/.openclaw/workspace/skills/garibong-labs/tistory-publish/templates/openclaw-release/banner.js {버전}
# 출력: /tmp/openclaw-{버전}-banner.jpg

# 2. 백업 저장
cp /tmp/openclaw-{버전}-banner.jpg \
   /Users/garibong/.openclaw/workspace/drafts/openclaw-{버전}-banner.jpg
```

### 배너 스펙
- 크기: 1200x630
- 배경: 어두운 다크레드 그라데이언트 (#1a0505 → #0d0000)
- 상단 강조선: 빨간색 5px
- 제목: "OpenClaw" 볼드 빨간색(#e84040) 80px
- 부제: "v{버전} Release Notes" 회색 30px
- 불릿: 주요 변경사항 6개 이내

### 포스트에 삽입

publish.sh 실행 시 `--banner` 옵션 필수:

```bash
bash .../publish.sh \
  --title "OpenClaw {버전} 릴리즈 노트 분석 - {키워드1}, {키워드2}, {키워드3}" \
  --body-file "/tmp/openclaw-{버전}-body.html" \
  --category "AI-Agent/OpenClaw-Release" \
  --banner "/tmp/openclaw-{버전}-banner.jpg" \
  --tags "OpenClaw,릴리즈노트,AI에이전트,{키워드태그들}" \
  --blog "bongman.tistory.com"
```

---

## 전체 작업 순서

### 0단계: 릴리즈 노트 수집
```bash
# npm에서 릴리즈 확인
npm view openclaw dist-tags
# GitHub releases 페이지 확인
# https://github.com/openclaw/openclaw/releases
```

### 1단계: 초안 작성 (Tistory HTML 직접 작성)
- 파일: `/Users/garibong/.openclaw/workspace/drafts/openclaw-{버전}-review.md` (내부 메모용)
- **본문 HTML은 처음부터 Tistory 태그로 직접 작성** (마크다운 변환 없음 — 인코딩/개행 이슈 원천 차단)
- 블로그 스타일: ~했다 건조체, 존대말 금지
- 핵심 변경사항 중심으로 코드 블록 + 실제 사용 예시

#### HTML 구조 표준 (h2/h3 계층)

```html
<p data-ke-size="size16">도입부 요약 문단 (짧아도 앞 문단에 합쳐서 작성)</p>

<h2 data-ke-size="size26">핵심 3가지</h2>
<p data-ke-size="size16"><strong>항목1</strong> — 설명<br><strong>항목2</strong> — 설명<br><strong>항목3</strong> — 설명</p>

<p data-ke-size="size16">&nbsp;</p>
<h2 data-ke-size="size26">변경사항</h2>
<h3 data-ke-size="size23">세부 항목</h3>
<p data-ke-size="size16">내용...</p>

<p data-ke-size="size16">&nbsp;</p>
<h2 data-ke-size="size26">보안 패치</h2>
<h3 data-ke-size="size23">세부 항목</h3>
<p data-ke-size="size16">내용...</p>

<p data-ke-size="size16">&nbsp;</p>
<h2 data-ke-size="size26">버그 수정</h2>
<h3 data-ke-size="size23">세부 항목</h3>
<p data-ke-size="size16">내용...</p>

<p data-ke-size="size16">&nbsp;</p>
<h2 data-ke-size="size26">업그레이드</h2>
<pre class="language-bash"><code>...</code></pre>

<p data-ke-size="size16">&nbsp;</p>
<h2 data-ke-size="size26">요약</h2>
<table style="width:100%;border-collapse:collapse;margin:16px 0">...</table>

<h2 data-ke-size="size26">릴리즈 노트</h2>
<p data-og-placeholder="https://github.com/openclaw/openclaw/releases/tag/v{버전}">&#8203;</p>
```

**계층 규칙:**
- `h2` = 대분류 (변경사항/보안 패치/버그 수정/업그레이드/요약/릴리즈 노트) — 앞에 `<p>&nbsp;</p>` 추가 (첫 h2 제외)
- `h3` = 세부 항목 — 앞 공백 없음
- 짧은 결론 문장은 독립 단락 금지 — 앞 단락에 이어서 작성
- 리스트 항목 사이 빈 줄 금지

**문체 규칙:**
- 엠대시(—) 사용 금지: 한국 독자에게 낯선 표현
  - `A — B` (설명 연결) → `A: B`
  - `A — B —` (삽입구) → `A(B)` 또는 문장 분리
  - `~다 — 이유` (강조 끊기) → `~다. 이유`

#### ⚠️ 마크다운 작성 포맷 규칙 (Tistory CSS 개행 이슈)

Tistory는 `<p>` 태그 사이에 기본 마진이 있어서 빈 줄이 많으면 공백이 과도하게 넓어진다.

**규칙 1: 리스트 항목 사이 빈 줄 금지**
```markdown
# ❌ 잘못된 예
- 항목 A

- 항목 B

- 항목 C

# ✅ 올바른 예
- 항목 A
- 항목 B
- 항목 C
```

**규칙 2: 짧은 결론 문장은 독립 단락 금지 — 이전 단락에 이어 작성**
```markdown
# ❌ 잘못된 예
저장소를 클론하면 workspace plugin이 자동으로 로드되는 문제다. 악성 저장소를 클론하는 것만으로도 코드가 실행될 수 있었다.

지금 바로 업그레이드하는 걸 권장한다.

# ✅ 올바른 예
저장소를 클론하면 workspace plugin이 자동으로 로드되는 문제다. 악성 저장소를 클론하는 것만으로도 코드가 실행될 수 있었다. 지금 바로 업그레이드하는 걸 권장한다.
```

**일반 원칙:** 한 두 문장짜리 단락은 앞 단락과 합친다. 새 단락은 주제가 완전히 바뀔 때만 만든다.

### 2단계: 배너 생성
위 "배너 이미지" 섹션 참조

### 3단계: HTML 변환
- 마크다운 → Tistory 에디터용 HTML
- 저장: `/tmp/openclaw-{버전}-body.html`
- `<p data-ke-size="size16">`, `<h2 data-ke-size="size26">` 태그 사용
- ⚠️ **마크다운 표 → HTML 변환 시 반드시 인라인 스타일 추가**:
  ```html
  <table style="width:100%;border-collapse:collapse;margin:16px 0">
    <thead>
      <tr>
        <th style="border:1px solid #dddddd;padding:10px 14px;background:#f5f5f5;text-align:left;font-weight:bold">기능</th>
        <th style="border:1px solid #dddddd;padding:10px 14px;background:#f5f5f5;text-align:left;font-weight:bold">핵심 포인트</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="border:1px solid #dddddd;padding:10px 14px">셀 내용</td>
        <td style="border:1px solid #dddddd;padding:10px 14px">셀 내용</td>
      </tr>
    </tbody>
  </table>
  ```
  → Tistory 테마는 `<table>`에 기본 border가 없어서 인라인 스타일 없으면 외곽선 안 보임
- ⚠️ **한글 인코딩 주의**: `atob()` (base64 → Latin1)은 한글 깨짐 발생. publish.sh는 `encodeURIComponent`/`decodeURIComponent` 청크 방식 사용 중
- **릴리즈 노트 섹션**: 본문 HTML 맨 마지막에 `<h2>릴리즈 노트</h2>` 포함할 것 (OG 카드는 발행 후 수동 추가)

### 4단계: 발행
```bash
bash /Users/garibong/.openclaw/workspace/skills/garibong-labs/tistory-publish/scripts/publish.sh \
  --title "OpenClaw {버전} 릴리즈 노트 분석 - {키워드1}, {키워드2}, {키워드3}" \
  --body-file "/tmp/openclaw-{버전}-body.html" \
  --category "AI-Agent/OpenClaw-Release" \
  --banner "/tmp/openclaw-{버전}-banner.jpg" \
  --tags "OpenClaw,릴리즈노트,AI에이전트,{버전},{키워드태그들}" \
  --blog "bongman.tistory.com"
```

### 5단계: 확인
- `success: true` 확인
- 발행된 URL 메모
- 대표이미지(배너) 포스트에서 확인

---

## OG 카드 + 하이퍼링크 (필수)

포스트 **맨 마지막** 구조:

```
h2: 릴리즈 노트
p: URL 하이퍼링크 (클릭 가능한 <a> 태그)
figure: OG 카드 (썸네일 + 제목 + 설명)
```

### 자동 생성 순서 (publish.sh 실행 후 수동 후처리)

1. `publish.sh`는 OG 카드를 자동 생성하지 않음 — 발행 후 에디터에서 추가
2. 에디터에서 "릴리즈 노트" h2 아래에 URL 텍스트 입력
3. URL 텍스트 끝에 커서 → **Playwright Enter 키** (isTrusted 이벤트 필요)
4. 5초 대기 → OG 카드 자동 생성 확인
5. URL 텍스트를 하이퍼링크(`<a>`)로 변환
6. 재발행

### 주의사항
- OG 카드 URL은 반드시 **버전별 태그 URL** 사용 (`/releases/tag/v{버전}`)
- JS `dispatchEvent(new KeyboardEvent('keydown'))` 방식은 `isTrusted: false`라 OG 트리거 안 됨 → Playwright/agent-browser의 실제 키 입력 필요
- URL 하이퍼링크와 OG 카드 **둘 다** 있어야 함 (OG 카드만 단독 X)
- ⚠️ **OG 트리거는 plain text URL에서만 작동**: 하이퍼링크(`<a>`)로 먼저 변환하면 Enter 이벤트를 OG로 인식 안 함. 반드시 plain text URL 상태에서 Enter → OG 생성 확인 → 그 다음 URL을 하이퍼링크로 변환하는 순서 지킬 것

---

## 태그 기본 세트

```
OpenClaw,릴리즈노트,AI에이전트,멀티에이전트,가리봉랩스
```

+ 릴리즈별 핵심 키워드 추가

---

## 참고
- 블로그: https://bongman.tistory.com
- 카테고리: AI-Agent/OpenClaw-Release
- 레퍼런스 포스트: https://bongman.tistory.com/1303 (2026.3.2)
