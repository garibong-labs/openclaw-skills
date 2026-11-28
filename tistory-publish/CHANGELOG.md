# Changelog

## Unreleased

- **Daum Trends 본문 이미지의 슬롯별 업로드 확인**
  - 파일명이 정확히 일치하고 HTTPS 이미지 로드가 완료된 새 `figure`를 마커에 배치한 뒤 다음 슬롯으로 진행한다. 슬롯당 파일 전달은 한 번으로 제한한다.
  - 정확한 업로드 실패 알림 직후 파일 지정이 예외를 내도 관찰 결과가 일치할 때만 `editor-reported-failure`로 판정한다. 빈 콜론 구분 목록과 업로드 실패·불확실 상태는 제출 전에 고정 코드와 슬롯 번호를 보고한다. 오프라인 테스트로 검증했다.

- **Daum Trends 뉴스 리다이렉트 500/40002 다음 기사 폴백**
  - `https://cp.news.search.daum.net/p/12345` 형태(예시 ID, ASCII 숫자만)의 원본 URL과 동일 URL 재시도에서 각각 안전하게 연관·파싱된 HTTP 500 + `code=40002`가 확인되면, 같은 OG placeholder에 연결된 첫 적격 v.daum.net 기사 후보를 정확히 1회 렌더한다.
  - Step 5와 복구 경로에서 후보 URL 일치와 카드 수를 확인한다. 후보 부재, 렌더 실패·미완료, 확인되지 않거나 엇갈린 응답은 일반 링크 변환 없이 발행 전 중단한다.

- MK 기사 이미지 모드의 별도 배너 alt에서만 ASCII 큰따옴표를 전각 큰따옴표로 표기해 티스토리 저장 시 이중 escape를 피한다. 공개 배너 검증은 Stage2 공개 본문 파서와 실제 티스토리 `imageblock` 구조를 사용하고, 업로드 출처·alt·가시성 검사는 유지한다.

- **발행 제목의 가운데점 공백 통일**
  - 현재/legacy 진입점 모두 공통 helper로 preset 최종 제목의 U+00B7 양쪽 공백을 한 칸으로 정리한 뒤 SEO·에디터에 전달. 연속/맨 앞·뒤 점과 인접 유니코드 공백을 일관되게 처리하며 다른 문자·본문·출처 URL은 보존
  - 현재 발행기의 중복 검사·발행 확인도 같은 정규화를 사용해 과거 공백 없는 제목과 동등 비교. 기존 엔티티/따옴표 처리와 MK 날짜 중복 방지 유지. 브라우저/네트워크 없이 두 shell 진입점·preset·에디터 전달·RSS/관리 목록 중복 거절 회귀 검증

- **MK editor gate의 실제 본문 DOM snapshot 사용**
  - 빈 문단 정규화·OG thumbnail 증거 보존·`save()` 순서를 유지하고, 저장 후 현재 `getBody().innerHTML`을 strict Stage2에 전달. 이미지가 shortcode로 직렬화되는 `getContent()`는 사용하지 않음
  - editor/body 부재·잘못된/빈 snapshot·읽기 오류는 제출 전 중단. validator·receipt·공개 snapshot·legacy 경로 유지
  - 실제 snapshot JS의 저장 후 body 교체/호출 순서/실패 차단과 합성 네 기사·별도 배너의 DOM 통과 및 저장용 직렬화 거절 회귀 추가

- **MK Stage3 TinyMCE 빈 문단 서식 보완**
  - MK opt-in의 editor gate와 최종 submit 직전 gate에서 snapshot/save 전에 최상위 bare `<p>`의 BR(속성 없음 또는 정확한 `data-mce-bogus="1"`)·NBSP·공백만 확인해 `data-ke-size="size16"`을 추가. 노드 삭제/삽입, 누락된 코멘트 간격 복구, 기존 속성 변경은 하지 않음
  - 의미 있는 텍스트·다른 자식·hidden/event/marker 등 속성·충돌하는 size·중첩 문단은 그대로 strict Stage2 검증에 전달. helper 부재/평가 오류/성공 결과 누락은 제출 전 중단하며 기존 비-MK OG cleanup과 외부 validator는 유지
  - 실제 JS helper의 DOM fixture·멱등성·노드 보존·cleanup 상호작용, Python 양쪽 gate의 호출 순서/실패 차단, 합성 원고의 외부 Stage2 통합 회귀 추가

- **MK 업로드 동일 src 쓰기 오탐 수정**
  - 시작 시 원본 이미지 노드별 정확한 src 속성 값(null·빈 문자열 구분)을 고정하고 `attributeOldValue`를 수집. 콜백과 polling의 `takeRecords()` 모두에서 모든 oldValue와 최종 값이 원래 값과 같은 경우만 무변경으로 인정
  - 실제 src 전이·같은 배치/별도 배치의 변경 후 복원·oldValue 증거 누락은 영구 실패 유지. body 교체·기존 src 재사용·복수 첨부 제한·유일 노드 안정화·노드 identity·재전달 차단 유지
  - 동일 값 쓰기, null/빈 문자열 전이, 원본 여러 노드의 교차 기록과 기존 보호 조건을 합성 fixture로 집중 검증. 실제 DOM 검증은 별도이며, 과거 live 장애의 mutation old/new 값이 없어 해당 장애 원인을 확정하지 않음

- **Stage3 CC R5 여섯 항목 수정**
  - 기사 filename을 단일 basename으로 제한하고 실제 원본을 fingerprint에 명시적으로 포함. 빈 값·점/상위/절대 경로·양쪽 구분자·source symlink를 사전 검증과 업로드 전 거부
  - 사전 검증 성공 후 원래 draft 결과를 재호출 없이 `draft-gate.json`에 0600으로 저장. 거절 시 디렉터리 미예약과 이후 실패 증거 유지
  - 태그 `tags`, 동기화/중복 검사/다이얼로그 `publish`, snapshot 입력 오류 `editor`/`public` phase를 실제 경계에 지정. URL/ID 복구 시 실패 phase 보존
  - parser 종료만으로 잡히지 않는 잘린 태그/속성과 rawtext 내부 marker를 인용값·주석을 구분하는 lexical 검사로 차단. 실제 legacy shell과 MK-disabled embedded 경로 및 무해한 literal 회귀 추가
  - 배너 audit CLI에 import·dependency API·입력·배너·embed·내부 오류 고정 진단 추가. 경로/원시 예외를 출력하지 않으며 외부 Stage2 없이 실행되는 모듈 mock 진입점 회귀 추가
  - Step11이 실제 공개 fetch timeout/용량/decode/validator·추가 OG 원인을 마스킹·제한하여 JSON/state에 전달. 발행 identity·non-zero·자동 재시도 금지 유지

- **Stage3 CC R4 다섯 항목 수정**
  - 실제 embedded `fail` 경로의 호출자 코드/원인을 credential 마스킹·500자 제한한 `detail`로 최종 JSON과 실패 state에 동일 보존. Step6 실패는 `representative` phase로 기록하고 URL/ID 복구는 원래 실패 phase 유지
  - 업로드 결과 대기를 rAF 대신 250ms 숫자 polling으로 지정. 오류 시 해당 token의 observer만 해제하고 실패 작업을 유지하며 원인 예외 보존·두 번째 파일 전달 차단
  - 최종 노드 삽입 후 임시 노드가 다음 task에서 제거되는 겹침은 관찰 시작부터 최대 1000ms pending 처리. 유일한 노드가 된 뒤 새 500ms 안정화 필수; 지속된 복수 첨부·body 교체·원본 변조·기존 src 재사용은 영구 실패
  - 설정된 추가 OG validator는 마지막 비어 있지 않은 stdout 줄의 JSON 객체와 정확한 `success:true`·종료 코드 0 요구. 앞선 진행 로그 허용, malformed/falsy/배열/누락 결과 거부. 별도 필수 Stage2 이미지 validator의 전체 stdout JSON 계약 유지
  - legacy guard의 의존성 import도 제어된 오류 경로에 포함하고 금지 marker·의존성/실행 오류·본문 읽기/UTF-8 오류를 구분. 브라우저 전 fail-closed 및 제한된 고정 진단 유지
  - 실제 embedded 실패/Step6/추가 OG/legacy shell guard와 업로드 인자·겹침/영구 실패/정리 회귀 추가. 합성 오프라인 검증이며 live CDP·업로드·발행 증거는 아님

- **Stage3 CC 일곱 항목 수정**
  - 기본/simple-post/Daum과 legacy publisher의 `trend-image-N` 일반 첨부 복원. Stage1 전용 속성·알 수 없는 marker 차단 유지
  - 실패 처리의 발행 URL/ID 복구가 원래 phase를 바꾸지 않도록 수정. 설정된 추가 OG draft/public validator를 실제 실행하고 이미지 증명은 `articleImageValidation`으로 분리하며 미실행 OG 성공 보고 제거
  - CDP 전 생성자/draft 거절에 제한된 원인·validator stdout/stderr와 credential 마스킹 제공. 거절 시 증거 디렉터리 미예약 유지
  - thumbnail 증거 수집에 공용 OG discovery 적용. 분리된 업로드 임시 노드는 제외하고 교체 노드는 동일 src라도 안정화 시간 초기화; 동시에 남은 복수 첨부·기존 src 재사용/변조 거부 유지
  - Stage1/2의 JPEG 전용 계약을 명시하고 기사 확장자·바이트 서명 불일치를 증거 디렉터리 생성/업로드 전에 거부. 전달 시 SHA 확인한 frozen bytes와 MIME 일치 검사
  - 일곱 항목 오프라인 재현/회귀, 실제 외부 Stage2와 추가 OG CLI의 합성 snapshot 통합 검증. 외부 코드 변경·네트워크·실제 브라우저/업로드/발행 없음

- **MK Stage3 대표이미지 배너 선택 필수화 (R2)**
  - 별도 배너 업로드에서 실제 관찰한 전체 src의 유일한 정확 일치 대상만 선택. MK 생략 설정, src 누락/중복/미발견, 버튼 미발견, helper 실패/반환 대상 불일치는 제출 전 중단. 기존 helper 선택 로직에 `targetSrc` 옵션을 추가하며 legacy/Daum 동작 유지
  - 실제 Step6 분기와 JS helper의 오프라인 회귀 추가. mock/helper 성공·버튼 클릭은 live 플랫폼 대표이미지 저장 상태 증거가 아님

- **MK 기사 이미지 Stage3 공통 publisher opt-in**
  - `publish-post.sh --mk-article-images`와 현재 입력/run/외부 Stage2 validator+명시적 interpreter/출처 증거/새 private 증거 디렉터리를 모두 요구. CDP 전 mandatory draft, 발행 전 editor snapshot, 확인된 글 URL의 public snapshot을 동일 Stage2 증거 계약으로 검증. 환경변수/SEO 설정으로 gate를 끄거나 legacy로 낮출 수 없음
  - stdlib Python 3.9 호환 `mk_article_image_publisher.py` adapter 추가. 고정 순서 네 verified 파일의 SHA를 확인한 바이트를 기존 UI에 전달하고, 작업 전 observer로 추적한 유일한 새 첨부 노드의 실제 HTTPS src로 Stage2 receipt 생산. filename/개수/늦은 DOM 추정 금지, 파일 전달 뒤 불확실한 재전달 금지. 기사별 alt·figure figcaption AI disclosure, 실제 관찰한 카드 thumbnail `data-og-image`, 별도 배너 검증
  - 현재 입력/자산/sidecar/엔진/validator 코드 identity·SHA 및 receipt/snapshot 변조를 단계 사이 재검사. 제출/발행 identity와 bounded 증거 보존. public 실패는 non-success·non-zero, 페이지 보존, 경고 전환/자동 재저장/재발행 없음
  - 기존 Daum flags/OG 폴백/대표이미지/잠금/로그인/성공 탭 정리 유지. legacy `publish.sh`에는 Stage1 marker 원고 우회 방지 guard만 추가; Stage3 전용 JS는 legacy helper에 미러링하지 않음
  - 합성 Stage1-compatible JPEG/sidecar와 실제 외부 Stage2 validator의 오프라인 통합, UI mock 및 기존 회귀 검증. 외부 출처/engine/provider/CDP/실제 업로드·공개 fetch 미실행이며 live Tistory 호환성 증거 없음. Stage2 PR285 알려진 P2 후속은 외부 코드 수정/완화 없이 제한으로 문서화, 이미지 경로의 비이미지 embed 거부. 생성/cron Stage4 미구현

- **카카오 간편로그인 프로필 앵커 선택 지원**
  - `login.sh` 계정 후보에 실제 화면의 `a.wrap_profile[role="button"]`을 기존 네이티브 버튼과 함께 단일 선택자로 포함. 동일 노드를 중복 집계하지 않으며 표시된 독립 행의 전체 식별자가 정확히 일치하는 표시·활성 후보가 유일할 때만 선택
  - 네이티브 버튼·프로필 앵커 혼합 중복은 즉시 중단. 다른 계정·부분/마스킹 식별자·계정 삭제/새 계정 컨트롤을 선택하지 않으며, 기존 인증 요구 중단·제한 시간·백오프·지연 렌더링/활성화 처리 유지
  - 실제 프로필 HTML 구조의 합성 fixture로 선택·혼합 중복·비적격 후보·지연·선택 전후 인증 요구 회귀 검증. 실제 브라우저·CDP·계정 접근 없이 집중 테스트 수행

- **카카오 간편로그인 계정 선택의 보수적 처리**
  - `login.sh`에서 간편로그인 화면이면 기존 `kakao_id` 전체와 표시 텍스트의 한 줄이 정확히 일치하는 활성 네이티브 버튼이 유일할 때만 1회 선택. 불일치·중복·숨김·마스킹·부분 일치는 중단하며 다른 계정 로그인으로 우회하지 않음
  - 선택 후 인증 완료 이동 또는 실제 입력 폼을 제한 시간 내 확인하며 직접 폼 경로와 기존 최종 로그인 검증 유지. 선택·입력·제출 전과 이동/제출 후 CAPTCHA·2단계/추가 인증 요구를 확인해 수동 인증 안내로 중단. 계정·비밀번호·DOM·원시 예외는 오류에 출력하지 않음
  - 실제 로그인·CDP·자격증명 파일 접근 없이 합성 페이지로 회귀 검증. 인증/프로필/쿠키/토큰 저장 정책 변경 없음
  - 간편로그인 URL 진입 후 계정 버튼의 지연 렌더링·활성화를 최대 15초 동안 0.25→0.5→1초 간격(남은 시간 이내)으로 대기. 표시된 독립 행의 전체 식별자가 정확히 일치하는 활성 네이티브 버튼이 유일할 때만 1회 선택하며, 중복은 즉시 중단하고 미일치·시간 초과 시 다른 계정/입력 폼으로 우회하지 않음
  - 대기 중 수동 인증 요구는 중단하고, 실제 입력 폼·인증 완료 화면으로 이동한 경우 이전 계정 버튼을 선택하지 않고 기존 처리로 연결. 지연 삽입·활성화·중복·인증 요구·이동·기한 만료를 가짜 시간 기반 합성 테스트로 검증

- **mk-review 실행 소유 탭의 검증 성공 후 정리 및 실제 종료 확인**
  - 발행 후 글 ID·URL 및 적용되는 사후 검증이 모두 확인되고 경고·불확실성이 없을 때 `mk-review`도 생성 시 캡처한 정확한 page target만 정리. 실패·발행 미확인·사후 편집/재저장/gap 불확실성·비공개 최신 글 대체 선택은 탭 보존
  - Daum의 기존 성공 경로 정리 자격(경고 허용 포함)은 유지. 공용 정리의 종료 증거만 강화: 유일한 page target 일치 확인 → 정확한 ID에 1회 종료 요청 → 유효한 목록에서 소멸 확인. 닫기 응답만으로 성공 로그를 남기지 않음
  - 표준 라이브러리 `cdp_owned_tab_cleanup.py` 독립 프로세스에 전체 5초 제한 적용. ID 누락/불일치·조회/종료 오류·시간 초과는 종료 미확인 로그만 남기며 검증된 발행 성공·종료 코드를 바꾸거나 재발행하지 않음
  - 소멸 확인 재조회는 1초·2초 순 지수 백오프를 적용하고 남은 worker 4.5초 예산으로 대기를 제한. 외부 5초 제한 유지
  - MK 사후 재저장은 기존 반환값/경고/성공 결과와 별도로 대화상자·공개/비공개 라디오·실제 저장 버튼 실행 및 저장 후 실제 `/manage/posts` 경로 이동을 모두 확인해야 탭 정리 허용. 평가/클릭/이동 오류·제어 누락·시간 초과·대화상자 소멸만 관측·편집 URL의 returnURL 문자열은 미확인으로 탭 보존. Daum 및 다른 호출자의 기존 재저장 동작 유지
  - 기존 사용자 탭·브라우저/context와 다른 템플릿·레거시 경로 변경 없음. 실제 브라우저/발행 없이 mk/Daum 성공, 실패/불확실 경로, 사용자 탭 보호, target 누락/불일치, 응답 대 실제 소멸, 제한 시간 모의 회귀 검증

- **현재 publish-post.sh의 제한 시간 있는 실제 CDP preflight와 읽기 전용 target 진단**
  - 잠금 후 에디터 생성·로그인 전에 실제 Playwright attach 1회, 성공 연결 재사용. `--cdp-connect-timeout-ms` / `TISTORY_CDP_CONNECT_TIMEOUT_MS`: 기본 15000ms, 허용 1000~60000ms
  - 실패 시 독립 프로세스 총 5초, 최대 8개 target, 각각 최대 750ms. 선택 `websocket-client`의 직접 page 채널 상수 평가만 정상 증거로 인정하며, 모듈 부재·지원 밖 target·전송 오류·예산 소진은 unknown. 새 필수 의존성·자동 설치 없음
  - 단계·소요 시간·제한된 target id/type·고정 상태/사유만 기록하고 URL 전체·제목·원시 예외·브라우저 메타데이터 생략. 진단 실패는 attach 오류를 가리지 않고 운영자 인터럽트 전파, 에디터 접근 전 fail-closed
  - 기존 탭 상태를 보존하도록 URL 기반 newpost 자동 종료 두 경로 제거. 잠금·발행/이미지/OG/중복 게이트와 실행 소유 target의 기존 성공 후 정리 유지. 레거시 publish/login 변경 없음
  - 오프라인 정상/정체 target·선택 전송 부재·예산/프로세스 종료·비밀 비노출 회귀 추가. 역사적 장애 target은 미확인이고 진단은 원인 확정 수단이 아님
- **daum-trends 짝 소진(exhausted-pair) 확정 500/40002 plain-link 폴백** (2026-10-01 발행 abort 대응)
  - 배경: DCInside 마이너 갤러리 모바일 게시글(`m.dcinside.com/board/<g>/<no>`)은 짝 helper가 regular 데스크톱 경로(`gall.dcinside.com/board/view`)를 계산하지만 실제 canonical은 `/mgallery/board/view`라서, 원본 2회 + 계산된 짝 1회가 전부 HTTP 500 + payload `code=40002`로 확정 실패하고 발행 전체가 중단되던 문제
  - 제한된 3회 시퀀스(`original`, `original-retry`, 계산된 짝으로의 `dcinside-paired-fallback` 정확히 1회)가 **전부 안전 연관된 found=false + HTTP 500 + `code=40002`로 확정**되고, 짝 시도 URL이 helper가 계산한 짝과 정확히 일치하고, caller가 명시적으로 켠 경우(`--template daum-trends`이고 custom OG validator 미설정)에만, 원본 URL(계산된 짝이 아님)을 카드 대신 명시적 일반 하이퍼링크로 유지 — 원본 URL은 기존 보수적 safe external http(s) 계약도 통과해야 함
  - **깨진 OG와 실패한 짝은 절대 카드로 계산하지 않음**: 기존 `render_og_cards()` 집계/검증 경로 재사용 (`placeholder 수 − plain link 수` 카드 게이트 + 마킹된 plain link 수 일치 검증 + `ogPlainLinkFallbacks`의 `url`/`reason`/`phase` 보고, reason은 `confirmed scrap 500/code=40002 on original twice and paired fallback once`로 40009 케이스와 구분). **strict custom OG validator(`TISTORY_OG_VALIDATOR`)가 켜져 있으면 이 폴백도 비활성화**
  - 기존 동작 불변: 짝 시도 성공은 그대로 카드 반환·계산, 원본 1·2차 성공 불변, 짝이 없거나 짝 시도에 도달하지 못한 40002 실패·시퀀스 종류/순서/횟수 불일치·짝 URL 불일치·미관측/미파싱/타 상태/타 코드·변환/검증/count 실패는 전부 기존 fail-closed abort, 확정 500/40009 Daum 다음 기사·plain-link 폴백 동작 그대로
  - 변환/검증 정책은 40009 케이스와 공용 `degrade_to_plain_link()`로 통합 (JS helper 변경 없음). 짝 시도가 pending 문단을 짝 URL로 키잉해 두므로, 변환 전에 기존 `prepareOGRetry`로 pending을 원본 URL로 재바인딩한다 — 추가 Enter/scrap 시도 없이 문단 텍스트/키만 복원하며, 재바인딩 실패·미확인은 변환 전 fail-closed abort (40009 경로는 재바인딩 없음, 동작 불변). 보존된 2026-10-01 incident payload(마이너 갤러리 모바일 URL + 잘못 계산된 regular 짝 + 3회 시도 기록)에서 파생한 repo 내 fixture와 replay/negative/집계 regression 테스트 추가
- **daum-trends 확정 500/40009 plain-link 폴백** (2026-09-29 발행 abort 대응)
  - 두 원본 OG 시도가 **모두 안전 연관된 HTTP 500 + payload `code=40009`로 확정**되고, 적격 v.daum.net 다음 기사 후보가 전혀 없고, caller가 명시적으로 켠 경우(`--template daum-trends`이고 custom OG validator 미설정)에만, 실패한 placeholder의 출처를 카드 대신 명시적 일반 하이퍼링크로 유지 (원본 인코딩 URL 그대로 `href`+앵커 텍스트, `_blank`, `noopener noreferrer`, `data-og-plain-link` 내구 마킹)
  - 원본 URL은 보수적 safe external http(s) 계약을 통과해야 함 — 빈/비정상 값, 비 http(s) 스킴, userinfo, localhost/`.local`/dotless 내부 이름, loopback/private/link-local/reserved/multicast literal IP는 폴백 금지 (fail-closed 유지)
  - **깨진 OG는 절대 카드로 계산하지 않음**: `render_og_cards()` 카드 수 게이트는 실제 카드 수를 `placeholder 수 − plain link 수`와 비교하고, 에디터에 실제 마킹된 plain link 수가 폴백 수와 일치하는지도 검증. plain link는 `found`를 만족시키거나 `ogCards`를 올리지 않음
  - **strict custom OG validator(`TISTORY_OG_VALIDATOR`)가 켜져 있으면 이 폴백은 비활성화** — draft/public 카드 검증의 엄격한 의미론 유지. 적격 후보가 있으면 기존대로 후보 1회 시도 후 실패 시 fail-closed(silent 다운그레이드 금지). generic `found=false`, 미관측/미파싱 응답, 500 아닌 상태, 40009 아닌 코드, 1회 확정+1회 불명, 확정 40002 DCInside 짝 폴백, 비 daum-trends 템플릿은 전부 기존 동작 그대로
  - JS helper에 `convertPendingToPlainLink(url)`/`verifyOGPlainLink(url)` 추가 (`tistory-editor-helpers.js`/`tistory-publish.js` 양쪽 동일 소스, parity 테스트로 고정). 변환/검증 실패 시 발행 전 abort. helper preflight(`ensure_og_helpers`)는 이 두 함수를 폴백 opt-in일 때만 요구 — 비 opt-in 경로(mk-review, custom validator 등)는 구버전 helper 표면으로도 기존대로 동작하고, opt-in인데 주입 후에도 두 함수가 없으면 발행 전 abort. `cleanupOGResiduals()`는 마킹된 plain link를 (mk.co.kr 호스트 포함) 보존하고 `plainLinks` 수를 별도 보고하며, 마킹 없는 pending/naked 잔여물은 기존대로 제거
  - 관측성: `confirmed 500/code=40009 -> degraded to plain source link` 로그(원본 URL/phase 포함)와 최종 발행 결과 JSON의 `ogPlainLinkFallbacks`(`url`/`reason`/`phase`) — OG 카드로 라벨링하지 않음. Step 5와 unexpected-navigation 복구 경로는 같은 helper/적격성/집계 경로 공유
  - 보존된 2026-09-29 incident payload(인코딩 Wikipedia URL + 두 시도 기록)에서 파생한 repo 내 fixture와 replay/negative regression 테스트 추가
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
