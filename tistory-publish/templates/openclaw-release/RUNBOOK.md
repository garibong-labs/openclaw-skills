# OpenClaw 릴리즈 노트 발행 런북

> bongman.tistory.com — AI-Agent/OpenClaw 카테고리
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
  --category "AI-Agent/OpenClaw" \
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

### 1단계: 초안 작성 (마크다운)
- 파일: `/Users/garibong/.openclaw/workspace/drafts/openclaw-{버전}-review.md`
- 블로그 스타일: ~했다 건조체, 존대말 금지
- 핵심 변경사항 중심으로 코드 블록 + 실제 사용 예시

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

### 4단계: 발행
```bash
bash /Users/garibong/.openclaw/workspace/skills/garibong-labs/tistory-publish/scripts/publish.sh \
  --title "OpenClaw {버전} 릴리즈 노트 분석 - {키워드1}, {키워드2}, {키워드3}" \
  --body-file "/tmp/openclaw-{버전}-body.html" \
  --category "AI-Agent/OpenClaw" \
  --banner "/tmp/openclaw-{버전}-banner.jpg" \
  --tags "OpenClaw,릴리즈노트,AI에이전트,{버전},{키워드태그들}" \
  --blog "bongman.tistory.com"
```

### 5단계: 확인
- `success: true` 확인
- 발행된 URL 메모
- 대표이미지(배너) 포스트에서 확인

---

## OG 카드 (필수)

포스트 **맨 마지막** 구조: `"릴리즈 노트" h2 제목 → OG 카드` 순서로 배치.

```
h2: 릴리즈 노트
OG: https://github.com/openclaw/openclaw/releases/tag/v{버전}
```

- OG 카드 URL은 반드시 **버전별 태그 URL** 사용 (`/releases/tag/v{버전}`)
- URL 텍스트 링크가 별도로 남지 않도록 주의 (OG 카드만 표시)
- TinyMCE에서 URL 입력 후 Enter → 자동 OG 카드 렌더링

---

## 태그 기본 세트

```
OpenClaw,릴리즈노트,AI에이전트,멀티에이전트,가리봉랩스
```

+ 릴리즈별 핵심 키워드 추가

---

## 참고
- 블로그: https://bongman.tistory.com
- 카테고리: AI-Agent/OpenClaw
- 레퍼런스 포스트: https://bongman.tistory.com/1303 (2026.3.2)
