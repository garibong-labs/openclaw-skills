// Focused standalone tests for acp-reporting-contract.mjs.
// Run: node acp-discord-orchestrator/scripts/test-acp-reporting-contract.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AcpReportingContractError,
  validateAcpReportingContract,
} from './acp-reporting-contract.mjs';

const REPO = 'openclaw-skills';
const BRANCH = 'fix/acp-reporting-fail-closed-guard';
const OTHER_CHANNEL = '999888777666555444';

const CONTEXT = {
  model: 'claude-fable-5',
  controlConversationId: '123456789012345678',
  lifecycleStartReceipt: {
    conversationId: '123456789012345678',
    messageId: '222333444555666777',
    deliveredAt: '2026-08-24T09:30:00.000Z',
  },
};

// Templates are intentionally written out as literals here (not imported from
// the module) so a template drift in the module fails these tests.
const INSTRUCTION =
  '다음 구분자 사이의 메시지만 그대로 반환해. 앞말·뒷말·설명·코드펜스·바꿔쓰기·두 번째 메시지를 추가하지 마.';
const BEGIN = '---BEGIN ACP REPORT---';
const END = '---END ACP REPORT---';

function buildStartMessage({
  roundIndex = 1,
  model = CONTEXT.model,
  repository = REPO,
  branch = BRANCH,
  time = '18:30',
} = {}) {
  const title =
    roundIndex === 1
      ? `🚀 **ACP 작업 시작 · ${time} KST**`
      : `🔁 **ACP 수정 라운드 ${roundIndex} 시작 · ${time} KST**`;
  return [
    title,
    '',
    `🤖 **ACP**: Claude Code · \`${model}\``,
    `📍 **작업**: \`${repository}\` · \`${branch}\``,
    '',
    '🎯 **범위**',
    '- 보고 계약 모듈과 테스트 구현',
    '',
    '🕒 **중간 보고**',
    '- ACP 실행 10분 이상일 때만 시작',
    '',
    '🔒 **외부 작업**',
    '- 없음',
  ].join('\n');
}

const PHASES = { 1: '분석', 2: '구현', 3: '자체 검증', 4: '완료 준비' };

function buildReportLines({
  roundIndex = 1,
  phaseIndex = 2,
  phaseName = null,
  model = CONTEXT.model,
  repository = REPO,
  branch = BRANCH,
  time = '18:45',
  elapsed = '12분 경과',
  executionState = '계약 검증 구현이 계속되는 중',
  issueBullet = null,
} = {}) {
  const lines = [
    `🔄 **ACP 중간 보고 · ${time} KST**`,
    '',
    `🤖 **ACP**: Claude Code · \`${model}\``,
    `📍 **작업**: \`${repository}\` · \`${branch}\``,
    `🔢 **라운드**: ${roundIndex} · ${phaseIndex}/4 ${phaseName ?? PHASES[phaseIndex]}`,
    `⏱️ **ACP 시간**: ${elapsed}`,
    `🔁 **실행 상태**: ${executionState}`,
    '',
    '✅ **새 결과**',
    '- 시작 템플릿 검증 부분 완료',
    '',
    '🛠️ **ACP 진행 중**',
    '- 워치독 페이로드 검증 작성',
    '',
    '🧪 **ACP 자체 검증**',
    '- 단위 테스트 전부 통과 확인',
    '',
    '⏭️ **ACP 다음**',
    '- 보고서 검증 마무리',
  ];
  if (issueBullet) {
    lines.push('', '⚠️ **이슈**', issueBullet);
  }
  return lines;
}

function buildPayloadMessage(report) {
  return `${INSTRUCTION}\n\n${BEGIN}\n${report}\n${END}`;
}

function buildReporting({
  roundIndex = 1,
  repository = REPO,
  branch = BRANCH,
  issueBullet = null,
  reportLines = null,
  timeoutSeconds = 45,
} = {}) {
  const startMessage = buildStartMessage({ roundIndex, repository, branch });
  const lines = reportLines ?? buildReportLines({ roundIndex, repository, branch, issueBullet });
  return {
    schemaVersion: 'acp-reporting-v1',
    roundIndex,
    repository,
    branch,
    startMessage,
    startDestination: CONTEXT.controlConversationId,
    watchdogDestination: CONTEXT.controlConversationId,
    terminalDestination: CONTEXT.controlConversationId,
    startReceipt: { ...CONTEXT.lifecycleStartReceipt, message: startMessage },
    watchdog: {
      id: `acp-watchdog-round-${roundIndex}`,
      roundIndex,
      enabled: false,
      sessionTarget: 'isolated',
      schedule: { kind: 'every', everyMs: 600000 },
      delivery: {
        mode: 'announce',
        channel: 'discord',
        to: `channel:${CONTEXT.controlConversationId}`,
      },
      deleteAfterRun: false,
      payload: {
        kind: 'agentTurn',
        toolsAllow: [],
        timeoutSeconds,
        message: buildPayloadMessage(lines.join('\n')),
      },
    },
  };
}

function expectContractError(fn, code) {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    assert.ok(err instanceof AcpReportingContractError, `expected AcpReportingContractError, got ${err && err.name}: ${err && err.message}`);
    assert.equal(err.code, code, `expected code ${code}, got ${err.code} (${err.message})`);
  }
  assert.ok(threw, `expected rejection with ${code}, but validation passed`);
}

function expectRejected(reporting, code, context = CONTEXT) {
  expectContractError(() => validateAcpReportingContract(reporting, context), code);
}

test('valid round 1 reporting passes and returns a frozen normalized copy', () => {
  const reporting = buildReporting();
  const normalized = validateAcpReportingContract(reporting, CONTEXT);
  assert.notEqual(normalized, reporting);
  assert.deepEqual(normalized, reporting);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.watchdog));
  assert.ok(Object.isFrozen(normalized.watchdog.payload));
  assert.notEqual(normalized.watchdog, reporting.watchdog);
  assert.equal(normalized.startReceipt.message, reporting.startMessage);
});

test('valid correction round 3 reporting passes', () => {
  const reporting = buildReporting({ roundIndex: 3 });
  const normalized = validateAcpReportingContract(reporting, CONTEXT);
  assert.equal(normalized.roundIndex, 3);
  assert.equal(normalized.watchdog.roundIndex, 3);
  assert.ok(normalized.startMessage.startsWith('🔁 **ACP 수정 라운드 3 시작 · '));
});

test('free-form incident round-2 start message is rejected', () => {
  const freeform = [
    '🔁 수정 라운드 2 시작합니다.',
    '',
    '지난 라운드에서 지적된 보고 누락을 고치는 중입니다. 워치독이 내부 세션 JSON과 PID를 직접 확인하던 동작을 제거할 예정입니다.',
    '진행 상황은 확인되는 대로 다시 공유드리겠습니다.',
  ].join('\n');
  const reporting = buildReporting({ roundIndex: 2 });
  reporting.startMessage = freeform;
  reporting.startReceipt.message = freeform;
  expectRejected(reporting, 'invalid_reporting_start_message');
});

test('free-form incident round-3 start message is rejected', () => {
  const freeform = [
    '세 번째 수정 라운드 시작 보고드립니다.',
    '',
    '저장소 openclaw-skills의 fix/acp-reporting-fail-closed-guard 브랜치에서 보고 계약 검증을 다시 손보고 있습니다.',
    '완료되면 결과를 정리해서 올리겠습니다.',
  ].join('\n');
  const reporting = buildReporting({ roundIndex: 3 });
  reporting.startMessage = freeform;
  reporting.startReceipt.message = freeform;
  expectRejected(reporting, 'invalid_reporting_start_message');
});

test('watchdog payload missing toolsAllow is rejected', () => {
  const reporting = buildReporting();
  delete reporting.watchdog.payload.toolsAllow;
  expectRejected(reporting, 'invalid_reporting_watchdog_payload');
});

test('watchdog payload timeoutSeconds 180 is rejected', () => {
  const reporting = buildReporting({ timeoutSeconds: 180 });
  expectRejected(reporting, 'invalid_reporting_watchdog_payload');
});

const INSPECTOR_BULLETS = [
  ['session JSON', '- 세션 JSON에서 마지막 상태를 확인'],
  ['PID', '- PID 4242가 살아있는지 확인'],
  ['ps -p', '- ps -p 4242 결과를 정리'],
  ['git status', '- git status 출력 정리'],
  ['git log', '- git log 최근 항목 요약'],
];
for (const [label, bullet] of INSPECTOR_BULLETS) {
  test(`inspector payload containing ${label} is rejected`, () => {
    const lines = buildReportLines();
    lines[9] = bullet;
    const reporting = buildReporting({ reportLines: lines });
    expectRejected(reporting, 'invalid_reporting_forbidden_content');
  });
}

test('destination route mismatches are rejected', () => {
  for (const key of ['startDestination', 'watchdogDestination', 'terminalDestination']) {
    const reporting = buildReporting();
    reporting[key] = OTHER_CHANNEL;
    expectRejected(reporting, 'invalid_reporting_destination');
  }
  const reporting = buildReporting();
  reporting.watchdog.delivery.to = `channel:${OTHER_CHANNEL}`;
  expectRejected(reporting, 'invalid_reporting_watchdog_delivery');
});

test('mismatched or reused watchdog round is rejected', () => {
  const reused = buildReporting({ roundIndex: 3 });
  reused.watchdog.roundIndex = 2;
  expectRejected(reused, 'invalid_reporting_watchdog_round');
  const ahead = buildReporting({ roundIndex: 3 });
  ahead.watchdog.roundIndex = 4;
  expectRejected(ahead, 'invalid_reporting_watchdog_round');
});

test('middle report with reordered sections is rejected', () => {
  const lines = buildReportLines();
  [lines[8], lines[11]] = [lines[11], lines[8]];
  [lines[9], lines[12]] = [lines[12], lines[9]];
  const reporting = buildReporting({ reportLines: lines });
  expectRejected(reporting, 'invalid_reporting_report');
});

test('fully valid public-only watchdog payload (with optional 이슈 last) is accepted', () => {
  const reporting = buildReporting({ roundIndex: 2, issueBullet: '- 외부 API 응답 지연 관찰' });
  const normalized = validateAcpReportingContract(reporting, CONTEXT);
  assert.equal(normalized.watchdog.payload.message, reporting.watchdog.payload.message);
  assert.deepEqual(normalized.watchdog.payload.toolsAllow, []);
  assert.equal(normalized.watchdog.payload.kind, 'agentTurn');
  assert.deepEqual(normalized.watchdog.schedule, { kind: 'every', everyMs: 600000 });
});

test('start receipt content and lifecycle mismatches are rejected', () => {
  const wrongMessage = buildReporting();
  wrongMessage.startReceipt.message += '!';
  expectRejected(wrongMessage, 'invalid_reporting_start_receipt');

  const wrongMessageId = buildReporting();
  wrongMessageId.startReceipt.messageId = OTHER_CHANNEL;
  expectRejected(wrongMessageId, 'invalid_reporting_start_receipt');

  const wrongDeliveredAt = buildReporting();
  wrongDeliveredAt.startReceipt.deliveredAt = '2026-08-24T10:00:00.000Z';
  expectRejected(wrongDeliveredAt, 'invalid_reporting_start_receipt');

  const extraKey = buildReporting();
  extraKey.startReceipt.note = 'x';
  expectRejected(extraKey, 'invalid_reporting_start_receipt');
});

test('schemaVersion, roundIndex, repository, and branch are validated', () => {
  const badSchema = buildReporting();
  badSchema.schemaVersion = 'acp-reporting-v2';
  expectRejected(badSchema, 'invalid_reporting_schema_version');

  for (const badRound of [0, -1, 2.5, '1']) {
    const reporting = buildReporting();
    reporting.roundIndex = badRound;
    expectRejected(reporting, 'invalid_reporting_round_index');
  }

  for (const badRepo of ['.', '..', 'a/b', 'a'.repeat(101), '']) {
    const reporting = buildReporting();
    reporting.repository = badRepo;
    expectRejected(reporting, 'invalid_reporting_repository');
  }

  for (const badBranch of ['/lead', 'trail/', 'a..b', 'feat/x.lock', 'name.', 'a b', 'a//b', 'a@{b']) {
    const reporting = buildReporting();
    reporting.branch = badBranch;
    expectRejected(reporting, 'invalid_reporting_branch');
  }
});

test('CR characters, fences, and delimiter abuse are rejected', () => {
  const cr = buildReporting();
  cr.watchdog.payload.message = cr.watchdog.payload.message.replaceAll('\n', '\r\n');
  expectRejected(cr, 'invalid_reporting_watchdog_message');

  const fenceLines = buildReportLines();
  fenceLines[9] = '- ```결과```';
  expectRejected(buildReporting({ reportLines: fenceLines }), 'invalid_reporting_watchdog_message');

  const dupEnd = buildReporting();
  dupEnd.watchdog.payload.message += `\n${END}`;
  expectRejected(dupEnd, 'invalid_reporting_watchdog_message');

  const prefixed = buildReporting();
  prefixed.watchdog.payload.message = `참고하세요\n${prefixed.watchdog.payload.message}`;
  expectRejected(prefixed, 'invalid_reporting_watchdog_message');

  const suffixed = buildReporting();
  suffixed.watchdog.payload.message += '\n끝';
  expectRejected(suffixed, 'invalid_reporting_watchdog_message');

  const crStart = buildReporting();
  crStart.startMessage += '\r';
  expectRejected(crStart, 'invalid_reporting_start_message');
});

test('middle report metadata must match model, repository, branch, and round', () => {
  const wrongModel = buildReporting({ reportLines: buildReportLines({ model: 'claude-opus-4-8' }) });
  expectRejected(wrongModel, 'invalid_reporting_report');

  const wrongRound = buildReporting({ roundIndex: 3, reportLines: buildReportLines({ roundIndex: 2 }) });
  expectRejected(wrongRound, 'invalid_reporting_report');

  const wrongRepo = buildReporting({ reportLines: buildReportLines({ repository: 'other-repo' }) });
  expectRejected(wrongRepo, 'invalid_reporting_report');

  const wrongBranch = buildReporting({ reportLines: buildReportLines({ branch: 'feat/other' }) });
  expectRejected(wrongBranch, 'invalid_reporting_report');
});

test('unknown keys are rejected at every nesting level', () => {
  const topLevel = buildReporting();
  topLevel.extra = 1;
  expectRejected(topLevel, 'invalid_reporting_unknown_key');

  const watchdogKey = buildReporting();
  watchdogKey.watchdog.note = 'x';
  expectRejected(watchdogKey, 'invalid_reporting_watchdog');

  const scheduleKey = buildReporting();
  scheduleKey.watchdog.schedule.jitterMs = 5;
  expectRejected(scheduleKey, 'invalid_reporting_watchdog_schedule');

  const deliveryKey = buildReporting();
  deliveryKey.watchdog.delivery.cc = 'x';
  expectRejected(deliveryKey, 'invalid_reporting_watchdog_delivery');

  const payloadKey = buildReporting();
  payloadKey.watchdog.payload.model = 'x';
  expectRejected(payloadKey, 'invalid_reporting_watchdog_payload');
});

test('watchdog invariants are enforced exactly', () => {
  const enabled = buildReporting();
  enabled.watchdog.enabled = true;
  expectRejected(enabled, 'invalid_reporting_watchdog');

  const sharedTarget = buildReporting();
  sharedTarget.watchdog.sessionTarget = 'shared';
  expectRejected(sharedTarget, 'invalid_reporting_watchdog');

  const deleteAfterRun = buildReporting();
  deleteAfterRun.watchdog.deleteAfterRun = true;
  expectRejected(deleteAfterRun, 'invalid_reporting_watchdog');

  const badId = buildReporting();
  badId.watchdog.id = 'bad id';
  expectRejected(badId, 'invalid_reporting_watchdog');

  const badSchedule = buildReporting();
  badSchedule.watchdog.schedule.everyMs = 300000;
  expectRejected(badSchedule, 'invalid_reporting_watchdog_schedule');

  const badChannel = buildReporting();
  badChannel.watchdog.delivery.channel = 'slack';
  expectRejected(badChannel, 'invalid_reporting_watchdog_delivery');

  const badKind = buildReporting();
  badKind.watchdog.payload.kind = 'shellCommand';
  expectRejected(badKind, 'invalid_reporting_watchdog_payload');

  const nonEmptyTools = buildReporting();
  nonEmptyTools.watchdog.payload.toolsAllow = ['Bash'];
  expectRejected(nonEmptyTools, 'invalid_reporting_watchdog_payload');

  const zeroTimeout = buildReporting({ timeoutSeconds: 0 });
  expectRejected(zeroTimeout, 'invalid_reporting_watchdog_payload');
});

test('optional 이슈 section must come last and appear at most once', () => {
  const base = buildReportLines();
  const misplaced = [
    ...base.slice(0, 17),
    '⚠️ **이슈**',
    '- 지연 관찰',
    '',
    ...base.slice(17),
  ];
  expectRejected(buildReporting({ reportLines: misplaced }), 'invalid_reporting_report');

  const duplicated = [
    ...buildReportLines({ issueBullet: '- 지연 관찰' }),
    '',
    '⚠️ **이슈**',
    '- 또 다른 이슈',
  ];
  expectRejected(buildReporting({ reportLines: duplicated }), 'invalid_reporting_report');
});

test('round-4 invented middle-report layout is rejected', () => {
  // The layout the previous round's tests wrongly validated: 실행 상태 as a
  // section, invented section emoji, and a 라운드 line without phase data.
  const invented = [
    '🔄 **ACP 중간 보고 · 18:45 KST**',
    '',
    `🤖 **ACP**: Claude Code · \`${CONTEXT.model}\``,
    `📍 **작업**: \`${REPO}\` · \`${BRANCH}\``,
    '🔁 **라운드**: 1',
    '⏱️ **ACP 시간**: 12분 경과',
    '',
    '🚦 **실행 상태**',
    '- 계약 검증 구현이 계속되는 중',
    '',
    '📦 **새 결과**',
    '- 시작 템플릿 검증 부분 완료',
    '',
    '🔨 **ACP 진행 중**',
    '- 워치독 페이로드 검증 작성',
    '',
    '✅ **ACP 자체 검증**',
    '- 단위 테스트 전부 통과 확인',
    '',
    '➡️ **ACP 다음**',
    '- 보고서 검증 마무리',
  ];
  expectRejected(buildReporting({ reportLines: invented }), 'invalid_reporting_report');
});

test('each of the four phase mappings is accepted', () => {
  for (const [phaseIndex, phaseName] of Object.entries(PHASES)) {
    const reporting = buildReporting({
      reportLines: buildReportLines({ phaseIndex: Number(phaseIndex), phaseName }),
    });
    const normalized = validateAcpReportingContract(reporting, CONTEXT);
    assert.ok(
      normalized.watchdog.payload.message.includes(`🔢 **라운드**: 1 · ${phaseIndex}/4 ${phaseName}`),
      `phase ${phaseIndex}/4 ${phaseName} must be accepted`
    );
  }
});

test('mismatched phase index/name pairs are rejected', () => {
  const badPairs = [
    [1, '구현'],
    [2, '분석'],
    [3, '완료 준비'],
    [4, '자체 검증'],
    [2, '검증'],
    [0, '분석'],
    [5, '완료 준비'],
  ];
  for (const [phaseIndex, phaseName] of badPairs) {
    const reporting = buildReporting({ reportLines: buildReportLines({ phaseIndex, phaseName }) });
    expectRejected(reporting, 'invalid_reporting_report');
  }
});

test('missing or empty 실행 상태 metadata is rejected', () => {
  const missing = buildReportLines();
  missing.splice(6, 1);
  expectRejected(buildReporting({ reportLines: missing }), 'invalid_reporting_report');

  const empty = buildReportLines({ executionState: ' ' });
  expectRejected(buildReporting({ reportLines: empty }), 'invalid_reporting_report');

  const asSection = buildReportLines();
  asSection[6] = '🔁 **실행 상태**';
  expectRejected(buildReporting({ reportLines: asSection }), 'invalid_reporting_report');
});
