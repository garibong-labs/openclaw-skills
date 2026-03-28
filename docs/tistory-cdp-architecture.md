# Tistory CDP 아키텍처

## 개요

티스토리 자동 발행은 두 개의 독립된 Chrome CDP 인스턴스를 사용한다.
각 인스턴스는 별도 카카오 계정으로 로그인된 세션을 유지한다.

## 포트 구성

| 포트 | 계정 | 블로그 | 용도 | 크론 |
|------|------|--------|------|------|
| 18800 | ruth@ | bongman (멤버) + anthropic (관리자) | 매경 리뷰, anthropic 데일리, 댓글 체크 | `b846720b`, `6ad82072`, `687817a6` |
| 18801 | eli@ | bongman (멤버) | OpenClaw 릴리즈 포스트 | `ab83db6d` |

## Chrome 인스턴스

### Port 18800 (기본)
- OpenClaw 내장 브라우저 서비스
- user-data: `~/.openclaw/browser/openclaw/user-data`
- 관리: OpenClaw 자동 관리

### Port 18801 (Eli 전용)
- launchd: `dev.garibong.chrome-eli-tistory`
- plist: `~/Library/LaunchAgents/dev.garibong.chrome-eli-tistory.plist`
- user-data: `~/.openclaw/browser/eli-tistory/user-data`
- headless, KeepAlive

## 자격증명

| 계정 | 파일 | 용도 |
|------|------|------|
| ruth@ | `~/.openclaw/workspace-ruth/.credentials/tistory-kakao.enc` | bongman 매경/anthropic 발행 |
| eli@ | `~/.openclaw/secrets/kakao.json` | bongman 릴리즈 발행 |

## 로그인 복구

세션 만료 시 `login.sh` 사용:
```bash
# Ruth (port 18800)
bash scripts/login.sh --cred-file ~/.openclaw/workspace-ruth/.credentials/tistory-kakao.enc

# Eli (port 18801)
bash scripts/login.sh --cdp-port 18801 --cred-file ~/.openclaw/secrets/kakao.json
```

## 블로그-계정 매핑

```
bongman.tistory.com
├── 관리자: Gary (개인 카카오)
├── 멤버: 에이전트 루스 (ruth@) — 매경 리뷰 발행
└── 멤버: 에이전트 일라이 (eli@) — OpenClaw 릴리즈 발행

anthropic.tistory.com
└── 관리자: 에이전트 루스 (ruth@) — 세금/사업자 데일리 발행
```

## 주의사항

- 두 포트의 세션은 독립적 — 한쪽 로그아웃이 다른 쪽에 영향 없음
- `publish.sh --cdp-port` 로 포트 지정 (기본: 18800)
- 18801은 크론 payload에서만 지정, 스킬 배포 코드에 하드코딩 금지

## 변경 이력

- 2026-03-28: 별도 CDP 포트 구조 도입 (이전: 세션 전환 방식)
- 2026-03-27: agent-browser → OpenClaw Playwright CDP 전환
