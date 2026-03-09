# OpenClaw 릴리즈 노트 원고 템플릿

> 이 파일을 복사해서 `openclaw-{버전}-review.md`로 저장 후 작성
> 작성 후 런북 순서대로 진행 (배너 → HTML 변환 → 발행)



## 메타

```
title: OpenClaw {버전} 릴리즈 노트 분석 - {키워드1}, {키워드2}, {키워드3}
category: AI-Agent/OpenClaw
tags: OpenClaw,릴리즈노트,AI에이전트,{버전},{키워드태그들}
og_url: https://github.com/openclaw/openclaw/releases/tag/v{버전}
```



## 구조

### 한 줄 요약

> 이번 릴리즈의 핵심을 1~2문장으로. 가장 임팩트 있는 변경 중심.

### 핵심 3가지

1. **{핵심1}** — 한 줄 설명
2. **{핵심2}** — 한 줄 설명
3. **{핵심3}** — 한 줄 설명



### {섹션1: 가장 중요한 변경}

변경 배경 설명 (2~3문장, ~했다 건조체)

#### 설정/사용 예시

```yaml
# config 예시 또는 CLI 명령어
```

#### 실제 적용 예시 (선택)

```bash
# 실행 명령어
```



### {섹션2}

(동일 구조 반복)



### {섹션3}

(동일 구조 반복)



### 기타 변경사항

#### {소항목1}

```yaml
# config 예시
```

#### {소항목2}

```yaml
# config 예시
```



### 업그레이드

```bash
# npm
npm i -g openclaw@latest

# openclaw CLI
openclaw update
```

업그레이드 후 `openclaw config validate`로 설정 확인.



### 요약

| 기능 | 핵심 포인트 |
|------|------------|
| {기능1} | {한 줄 설명} |
| {기능2} | {한 줄 설명} |
| {기능3} | {한 줄 설명} |
| {기능4} | {한 줄 설명} |
| {기능5} | {한 줄 설명} |



### 릴리즈 노트

*OG 카드: https://github.com/openclaw/openclaw/releases/tag/v{버전}*



## HTML 변환 규칙 (참고)

- `## 제목` → `<p data-ke-size="size16">&nbsp;</p><h2 data-ke-size="size26">` (h2 위에 빈 줄 1개 필수 — 가독성)
- `### 소제목` → `<h3 data-ke-size="size23">`
- 단락 → `<p data-ke-size="size16">` (2~4문장 묶음)
- 코드블록 → `<pre class="language-{lang}"><code>...</code></pre>`
- ~~구분선~~ → **사용 금지** (h2 제목으로 섹션 구분, 구분선 불필요)
- 표 → 인라인 스타일 필수 (`border:1px solid #ddd; padding:10px 14px`)
- OG 카드 → URL 텍스트 입력 후 Enter (TinyMCE 자동 렌더링)

## 문체 규칙

- ~했다 건조체, 존대말 절대 금지
- 주니어 개발자 대상이지만 기술적 깊이 유지
- 코드 블록 + 실행 명령어 중심, 장황한 설명 배제
- "실제 사례를 중심으로 따라할 수 있는" 내용
