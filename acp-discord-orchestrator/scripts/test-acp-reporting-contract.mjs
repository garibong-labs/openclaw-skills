// Focused standalone tests for acp-reporting-contract.mjs.
// Run: node acp-discord-orchestrator/scripts/test-acp-reporting-contract.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AcpReportingContractError,
  buildAcpIntermediateReport,
  buildAcpStartMessage,
  buildAcpTerminalReport,
  validateAcpReportingContract,
} from './acp-reporting-contract.mjs';
import { readReportMessageInput } from './acp-report-message-cli.mjs';

const REPORT_MESSAGE_CLI = fileURLToPath(new URL('acp-report-message-cli.mjs', import.meta.url));

const REPO = 'openclaw-skills';
const BRANCH = 'fix/acp-reporting-fail-closed-guard';
const OTHER_CHANNEL = '999888777666555444';

const CONTEXT = {
  agent: 'claude',
  model: 'claude-fable-5',
  controlConversationId: '123456789012345678',
  lifecycleStartReceipt: {
    conversationId: '123456789012345678',
    messageId: '222333444555666777',
    deliveredAt: '2026-08-24T09:30:00.000Z',
  },
};
const CODEX_CONTEXT = { ...CONTEXT, agent: 'codex', model: 'gpt-5-codex' };

// The closed presentation mapping, written out as literals so a mapping drift
// in the module fails these tests.
const AGENT_LABELS = { claude: 'Claude Code', codex: 'Codex' };

// Templates are intentionally written out as literals here (not imported from
// the module) so a template drift in the module fails these tests.
const INSTRUCTION =
  '다음 구분자 사이의 메시지만 그대로 반환해. 앞말·뒷말·설명·코드펜스·바꿔쓰기·두 번째 메시지를 추가하지 마.';
const BEGIN = '---BEGIN ACP REPORT---';
const END = '---END ACP REPORT---';

function buildStartMessage({
  roundIndex = 1,
  label = AGENT_LABELS.claude,
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
    `🤖 **ACP**: ${label} · \`${model}\``,
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
  label = AGENT_LABELS.claude,
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
    `🤖 **ACP**: ${label} · \`${model}\``,
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
  agent = 'claude',
  schemaVersion = 'acp-reporting-v2',
  label = AGENT_LABELS[agent] ?? String(agent),
  model = CONTEXT.model,
  repository = REPO,
  branch = BRANCH,
  issueBullet = null,
  reportLines = null,
  timeoutSeconds = 45,
} = {}) {
  const startMessage = buildStartMessage({ roundIndex, label, model, repository, branch });
  const lines = reportLines ?? buildReportLines({ roundIndex, label, model, repository, branch, issueBullet });
  return {
    schemaVersion,
    ...(schemaVersion === 'acp-reporting-v2' ? { agent } : {}),
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
  for (const badVersion of ['acp-reporting-v4', 'acp-reporting', 'v2', 1, undefined]) {
    const reporting = buildReporting();
    reporting.schemaVersion = badVersion;
    expectRejected(reporting, 'invalid_reporting_schema_version');
  }

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

// Invisible characters, addressed by code point so the test source stays free
// of raw control bytes.
const NEL = String.fromCharCode(0x85); // C1 next line
const CSI = String.fromCharCode(0x9b); // C1 control sequence introducer
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const LS = String.fromCharCode(0x2028); // line separator
const ZWSP = String.fromCharCode(0x200b);
const ZWJ = String.fromCharCode(0x200d);

test('metadata containing forbidden-pattern words is legal; free-text slots are not', () => {
  // Repository/branch/model are bound by their own validators, never by the
  // free-text denylist, so ordinary names stay possible.
  const metadataCases = [
    { branch: 'fix/routing' },
    { branch: 'feat/cron-schedule' },
    { branch: 'chore/no-op-cleanup' },
    { repository: 'snapshot-tool' },
    { repository: 'grep-utils' },
  ];
  for (const overrides of metadataCases) {
    const reporting = buildReporting(overrides);
    const normalized = validateAcpReportingContract(reporting, CONTEXT);
    assert.equal(normalized.branch, reporting.branch);
    assert.equal(normalized.repository, reporting.repository);
  }
  const model = 'snapshot-router-model';
  const withModel = buildReporting({ model });
  validateAcpReportingContract(withModel, { ...CONTEXT, model });

  // The same words inside a report free-text slot keep failing closed.
  const bulletLines = buildReportLines();
  bulletLines[9] = '- 라우팅 스냅샷 정리';
  expectRejected(buildReporting({ reportLines: bulletLines }), 'invalid_reporting_forbidden_content');
});

test('start message free-text bullets are screened for forbidden content', () => {
  const screen = (index, bullet) => {
    const reporting = buildReporting();
    const lines = reporting.startMessage.split('\n');
    lines[index] = bullet;
    const message = lines.join('\n');
    reporting.startMessage = message;
    reporting.startReceipt.message = message;
    expectRejected(reporting, 'invalid_reporting_forbidden_content');
  };
  screen(6, '- git status 출력을 정리');
  screen(6, '- 세션 JSON에서 상태 확인');
  screen(12, '- /Users/anyone/repo 정리');
  screen(12, '- 스스로 판단해서 처리');
});

test('C1 controls and U+2028/U+2029 are rejected like C0 controls', () => {
  const startNel = buildReporting();
  const nelMessage = startNel.startMessage.replace('- 없음', `- 없${NEL}음`);
  startNel.startMessage = nelMessage;
  startNel.startReceipt.message = nelMessage;
  expectRejected(startNel, 'invalid_reporting_start_message');

  const reportLs = buildReportLines();
  reportLs[9] = `- 결과${LS}한 줄`;
  expectRejected(buildReporting({ reportLines: reportLs }), 'invalid_reporting_watchdog_message');

  const branchNel = buildReporting();
  branchNel.branch = `fix/a${NEL}b`;
  expectRejected(branchNel, 'invalid_reporting_branch');

  const idCsi = buildReporting();
  idCsi.watchdog.id = `id${CSI}31m`;
  expectRejected(idCsi, 'invalid_reporting_watchdog');

  const modelNel = { ...CONTEXT, model: `bad${NEL}model` };
  expectContractError(
    () => validateAcpReportingContract(buildReporting(), modelNel),
    'invalid_reporting_context'
  );
});

test('zero-width-only free text is rejected as visually empty', () => {
  const startZw = buildReporting();
  const zwMessage = startZw.startMessage.replace('- 없음', `- ${ZWSP}${ZWJ}`);
  startZw.startMessage = zwMessage;
  startZw.startReceipt.message = zwMessage;
  expectRejected(startZw, 'invalid_reporting_start_message');

  const bulletZw = buildReportLines();
  bulletZw[9] = `- ${ZWSP}`;
  expectRejected(buildReporting({ reportLines: bulletZw }), 'invalid_reporting_report');

  const stateZw = buildReportLines({ executionState: ZWSP });
  expectRejected(buildReporting({ reportLines: stateZw }), 'invalid_reporting_report');

  // A joiner inside an emoji sequence next to visible text stays legal.
  const emoji = buildReportLines();
  emoji[9] = `- 👩${ZWJ}💻 검증 진행`;
  validateAcpReportingContract(buildReporting({ reportLines: emoji }), CONTEXT);
});

test('normalized output is built from validated locals, not re-read getters', () => {
  const swapAfterFirstRead = (target, key, validValue, evilValue) => {
    let reads = 0;
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? validValue : evilValue;
      },
    });
  };

  const messageSwap = buildReporting();
  const validMessage = messageSwap.watchdog.payload.message;
  swapAfterFirstRead(messageSwap.watchdog.payload, 'message', validMessage, 'git status /Users/evil');
  const normalizedMessage = validateAcpReportingContract(messageSwap, CONTEXT);
  assert.equal(normalizedMessage.watchdog.payload.message, validMessage);

  const startSwap = buildReporting();
  const validStart = startSwap.startMessage;
  swapAfterFirstRead(startSwap, 'startMessage', validStart, '자유 형식 보고');
  const normalizedStart = validateAcpReportingContract(startSwap, CONTEXT);
  assert.equal(normalizedStart.startMessage, validStart);
  assert.equal(normalizedStart.startReceipt.message, validStart);

  const timeoutSwap = buildReporting();
  swapAfterFirstRead(timeoutSwap.watchdog.payload, 'timeoutSeconds', 45, 999999);
  assert.equal(validateAcpReportingContract(timeoutSwap, CONTEXT).watchdog.payload.timeoutSeconds, 45);

  const idSwap = buildReporting();
  swapAfterFirstRead(idSwap.watchdog, 'id', 'acp-watchdog-round-1', 'evil id');
  assert.equal(validateAcpReportingContract(idSwap, CONTEXT).watchdog.id, 'acp-watchdog-round-1');

  const toolsSwap = buildReporting();
  swapAfterFirstRead(toolsSwap.watchdog.payload, 'toolsAllow', [], { length: 0 });
  assert.deepEqual(validateAcpReportingContract(toolsSwap, CONTEXT).watchdog.payload.toolsAllow, []);
});

test('context lifecycle receipt must belong to the control conversation', () => {
  const foreign = {
    ...CONTEXT,
    lifecycleStartReceipt: {
      ...CONTEXT.lifecycleStartReceipt,
      conversationId: OTHER_CHANNEL,
    },
  };
  expectContractError(
    () => validateAcpReportingContract(buildReporting(), foreign),
    'invalid_reporting_context'
  );
});

test('unknown-key diagnostics never echo control or ANSI characters', () => {
  const reporting = buildReporting();
  reporting[`${ESC}[31mevil${BEL}key`] = 1;
  let caught;
  try {
    validateAcpReportingContract(reporting, CONTEXT);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof AcpReportingContractError);
  assert.equal(caught.code, 'invalid_reporting_unknown_key');
  assert.equal(caught.message.includes(ESC), false);
  assert.equal(caught.message.includes(BEL), false);
  assert.ok(caught.message.includes('?'));
});

test('identifier and model bounds match the supervisor bounds', () => {
  // 32-digit identifiers (the supervisor's DISCORD_ID bound) are accepted.
  const id32 = '9'.repeat(32);
  const message32 = '8'.repeat(32);
  const context32 = {
    agent: CONTEXT.agent,
    model: CONTEXT.model,
    controlConversationId: id32,
    lifecycleStartReceipt: {
      conversationId: id32,
      messageId: message32,
      deliveredAt: CONTEXT.lifecycleStartReceipt.deliveredAt,
    },
  };
  const reporting32 = buildReporting();
  reporting32.startDestination = id32;
  reporting32.watchdogDestination = id32;
  reporting32.terminalDestination = id32;
  reporting32.startReceipt.conversationId = id32;
  reporting32.startReceipt.messageId = message32;
  reporting32.watchdog.delivery.to = `channel:${id32}`;
  validateAcpReportingContract(reporting32, context32);

  // 33 digits are out of bounds.
  const context33 = {
    ...context32,
    controlConversationId: '9'.repeat(33),
    lifecycleStartReceipt: {
      ...context32.lifecycleStartReceipt,
      conversationId: '9'.repeat(33),
    },
  };
  expectContractError(
    () => validateAcpReportingContract(reporting32, context33),
    'invalid_reporting_context'
  );

  // Model length matches the supervisor's 256-character invalid_model bound.
  const model256 = 'm'.repeat(256);
  validateAcpReportingContract(
    buildReporting({ model: model256 }),
    { ...CONTEXT, model: model256 }
  );
  const model257 = 'm'.repeat(257);
  expectContractError(
    () => validateAcpReportingContract(buildReporting({ model: model257 }), { ...CONTEXT, model: model257 }),
    'invalid_reporting_context'
  );

  // deliveredAt matches the supervisor's 40-character lifecycle bound.
  const longDeliveredAt = '2'.repeat(41);
  const longContext = {
    ...CONTEXT,
    lifecycleStartReceipt: {
      ...CONTEXT.lifecycleStartReceipt,
      deliveredAt: longDeliveredAt,
    },
  };
  expectContractError(
    () => validateAcpReportingContract(buildReporting(), longContext),
    'invalid_reporting_context'
  );
});

test('omitted context model binds the templates to the runtime-default label', () => {
  const noModelContext = { ...CONTEXT };
  delete noModelContext.model;

  const labeled = buildReporting({ model: 'runtime-default' });
  const normalized = validateAcpReportingContract(labeled, noModelContext);
  assert.ok(normalized.startMessage.includes('`runtime-default`'));

  // Without a pinned model, a template claiming a concrete model must not
  // pass: the identity line no longer matches the expected label.
  expectContractError(
    () => validateAcpReportingContract(buildReporting(), noModelContext),
    'invalid_reporting_start_message'
  );

  // A present-but-invalid model is still rejected, not treated as omitted.
  expectContractError(
    () => validateAcpReportingContract(labeled, { ...noModelContext, model: 42 }),
    'invalid_reporting_context'
  );
});

test('claude v2 bundle passes and carries the agent attestation', () => {
  const reporting = buildReporting();
  assert.equal(reporting.schemaVersion, 'acp-reporting-v2');
  assert.equal(reporting.agent, 'claude');
  const normalized = validateAcpReportingContract(reporting, CONTEXT);
  assert.deepEqual(normalized, reporting);
  assert.equal(normalized.agent, 'claude');
  assert.equal(normalized.schemaVersion, 'acp-reporting-v2');
  assert.ok(normalized.startMessage.includes('🤖 **ACP**: Claude Code · '));
});

test('codex v2 bundle passes with the closed Codex label', () => {
  const reporting = buildReporting({ agent: 'codex', model: CODEX_CONTEXT.model });
  const normalized = validateAcpReportingContract(reporting, CODEX_CONTEXT);
  assert.deepEqual(normalized, reporting);
  assert.equal(normalized.agent, 'codex');
  assert.ok(normalized.startMessage.includes('🤖 **ACP**: Codex · `gpt-5-codex`'));
  assert.ok(normalized.watchdog.payload.message.includes('🤖 **ACP**: Codex · `gpt-5-codex`'));
  assert.equal(normalized.startMessage.includes('Claude Code'), false);
  assert.ok(Object.isFrozen(normalized));
});

test('bracketed adapter-advertised model IDs bind the identity lines verbatim', () => {
  // ACPX advertises Codex reasoning selection inside the model ID itself
  // (for example gpt-5.6-sol[low]); the contract treats the complete
  // bracketed string as the model and exact-matches it on every identity
  // line, unchanged.
  const model = 'gpt-5.6-sol[low]';
  const context = { ...CODEX_CONTEXT, model };
  const reporting = buildReporting({ agent: 'codex', model });
  const normalized = validateAcpReportingContract(reporting, context);
  assert.deepEqual(normalized, reporting);
  assert.ok(normalized.startMessage.includes('🤖 **ACP**: Codex · `gpt-5.6-sol[low]`'));
  assert.ok(normalized.watchdog.payload.message.includes('🤖 **ACP**: Codex · `gpt-5.6-sol[low]`'));

  // A template claiming a different reasoning suffix than the validated
  // model is an identity-line mismatch, not a silent pass.
  expectContractError(
    () => validateAcpReportingContract(
      buildReporting({ agent: 'codex', model: 'gpt-5.6-sol[high]' }),
      context
    ),
    'invalid_reporting_start_message'
  );
});

test('legacy claude v1 bundle stays valid during the bounded migration', () => {
  const reporting = buildReporting({ schemaVersion: 'acp-reporting-v1' });
  assert.equal('agent' in reporting, false);
  const normalized = validateAcpReportingContract(reporting, CONTEXT);
  assert.deepEqual(normalized, reporting);
  assert.equal(normalized.schemaVersion, 'acp-reporting-v1');
  assert.equal('agent' in normalized, false);
});

test('v1 bundle is rejected for codex', () => {
  // A v1 bundle has no agent attestation and predates the presentation
  // mapping, so it is bounded to canonical Claude: Codex must present v2.
  const reporting = buildReporting({
    agent: 'codex',
    schemaVersion: 'acp-reporting-v1',
    model: CODEX_CONTEXT.model,
  });
  expectRejected(reporting, 'invalid_reporting_schema_version', CODEX_CONTEXT);

  // Even a v1 bundle whose templates already claim the Codex label is
  // rejected on the version, before any template content is compared.
  const labeled = buildReporting({
    agent: 'claude',
    schemaVersion: 'acp-reporting-v1',
    label: AGENT_LABELS.codex,
    model: CODEX_CONTEXT.model,
  });
  expectRejected(labeled, 'invalid_reporting_schema_version', CODEX_CONTEXT);
});

test('v1 bundle carrying the v2 agent key is rejected as unknown', () => {
  const reporting = buildReporting({ schemaVersion: 'acp-reporting-v1' });
  reporting.agent = 'claude';
  expectRejected(reporting, 'invalid_reporting_unknown_key');
});

test('v2 agent attestation must equal the canonical config agent', () => {
  // Bundle claims claude while the run is codex — and the reverse.
  const claudeBundle = buildReporting();
  expectRejected(claudeBundle, 'invalid_reporting_agent', CODEX_CONTEXT);

  const codexBundle = buildReporting({ agent: 'codex', model: CODEX_CONTEXT.model });
  expectRejected(codexBundle, 'invalid_reporting_agent');

  // A v2 bundle without the attestation is rejected, not defaulted.
  const missing = buildReporting();
  delete missing.agent;
  expectRejected(missing, 'invalid_reporting_agent');

  // A non-canonical attestation spelling never equals the canonical agent.
  const spelled = buildReporting();
  spelled.agent = 'Claude';
  expectRejected(spelled, 'invalid_reporting_agent');
});

test('spoofed harness labels are rejected for both agents', () => {
  // A codex run whose templates present as Claude Code fails on the exact
  // identity line, and the same in reverse: the label is bound to the
  // canonical config agent through the closed mapping, never caller-chosen.
  const codexAsClaude = buildReporting({
    agent: 'codex',
    label: AGENT_LABELS.claude,
    model: CODEX_CONTEXT.model,
  });
  expectRejected(codexAsClaude, 'invalid_reporting_start_message', CODEX_CONTEXT);

  const claudeAsCodex = buildReporting({ label: AGENT_LABELS.codex });
  expectRejected(claudeAsCodex, 'invalid_reporting_start_message');

  // An invented label fails even when the agent attestation is truthful.
  const invented = buildReporting({ label: 'Claude Codex Ultra' });
  expectRejected(invented, 'invalid_reporting_start_message');

  // A spoofed label only inside the watchdog report (start message honest)
  // still fails, on the report identity line.
  const reportOnly = buildReporting({
    reportLines: buildReportLines({ label: AGENT_LABELS.codex }),
  });
  expectRejected(reportOnly, 'invalid_reporting_report');
});

test('unsupported and non-canonical context agents are rejected first', () => {
  const reporting = buildReporting();
  const rejectedAgents = [
    'gemini',
    'test-agent',
    '',
    undefined,
    42,
    null,
    'Claude',
    ' claude ',
    'CLAUDE',
    'Codex',
    ' codex ',
    'CODEX',
    'constructor',
  ];
  for (const agent of rejectedAgents) {
    expectContractError(
      () => validateAcpReportingContract(reporting, { ...CONTEXT, agent }),
      'invalid_reporting_agent'
    );
  }
});

// ---------------------------------------------------------------------------
// buildAcpStartMessage — the production start-message builder. Expected
// outputs are written as literals (not composed from module constants) so a
// template drift in the builder fails these tests.
// ---------------------------------------------------------------------------

const BUILDER_INPUT = Object.freeze({
  agent: 'claude',
  model: 'claude-fable-5',
  roundIndex: 1,
  repository: REPO,
  branch: BRANCH,
  timeKst: '09:12',
  scope: '보고 시작 메시지 빌더 검증',
  externalAction: '없음',
});

function expectBuilderError(input, code) {
  expectContractError(() => buildAcpStartMessage(input), code);
}

test('builder renders the exact 13-line round-1 message', () => {
  assert.equal(
    buildAcpStartMessage({ ...BUILDER_INPUT }),
    [
      '🚀 **ACP 작업 시작 · 09:12 KST**',
      '',
      '🤖 **ACP**: Claude Code · `claude-fable-5`',
      `📍 **작업**: \`${REPO}\` · \`${BRANCH}\``,
      '',
      '🎯 **범위**',
      '- 보고 시작 메시지 빌더 검증',
      '',
      '🕒 **중간 보고**',
      '- ACP 실행 10분 이상일 때만 시작',
      '',
      '🔒 **외부 작업**',
      '- 없음',
    ].join('\n')
  );
});

test('builder renders the exact correction-round-3 message with the derived 🔁 title', () => {
  const message = buildAcpStartMessage({
    ...BUILDER_INPUT,
    agent: 'codex',
    model: 'gpt-5.6-sol[medium]',
    roundIndex: 3,
  });
  assert.equal(
    message,
    [
      '🔁 **ACP 수정 라운드 3 시작 · 09:12 KST**',
      '',
      '🤖 **ACP**: Codex · `gpt-5.6-sol[medium]`',
      `📍 **작업**: \`${REPO}\` · \`${BRANCH}\``,
      '',
      '🎯 **범위**',
      '- 보고 시작 메시지 빌더 검증',
      '',
      '🕒 **중간 보고**',
      '- ACP 실행 10분 이상일 때만 시작',
      '',
      '🔒 **외부 작업**',
      '- 없음',
    ].join('\n')
  );
});

test('builder output is byte-identical to the suite literal template for both agents', () => {
  for (const [agent, model] of [
    ['claude', CONTEXT.model],
    ['codex', CODEX_CONTEXT.model],
  ]) {
    for (const roundIndex of [1, 2, 7]) {
      assert.equal(
        buildAcpStartMessage({
          agent,
          model,
          roundIndex,
          repository: REPO,
          branch: BRANCH,
          timeKst: '18:30',
          scope: '보고 계약 모듈과 테스트 구현',
          externalAction: '없음',
        }),
        buildStartMessage({ roundIndex, label: AGENT_LABELS[agent], model })
      );
    }
  }
});

test('builder derives runtime-default for an omitted claude model and rejects codex omission', () => {
  const omitted = buildAcpStartMessage({ ...BUILDER_INPUT, model: undefined });
  assert.equal(omitted.split('\n')[2], '🤖 **ACP**: Claude Code · `runtime-default`');
  expectBuilderError(
    { ...BUILDER_INPUT, agent: 'codex', model: undefined },
    'invalid_reporting_context'
  );
});

test('builder rejects caller-supplied titles and harness labels as unknown keys', () => {
  for (const smuggled of [
    { title: '🚀 **ACP 작업 시작 · 09:12 KST**' },
    { agentLabel: 'Claude Codex Ultra' },
    { label: 'Codex' },
    { startMessage: 'x' },
  ]) {
    expectBuilderError({ ...BUILDER_INPUT, ...smuggled }, 'invalid_reporting_context');
  }
});

test('builder rejects non-canonical and unsupported agents', () => {
  for (const agent of ['Claude', ' codex ', 'CODEX', 'gemini', '', undefined, null, 42]) {
    expectBuilderError({ ...BUILDER_INPUT, agent }, 'invalid_reporting_agent');
  }
});

test('builder validates roundIndex, repository, branch, and time', () => {
  for (const roundIndex of [0, -1, 2.5, '3', 1001, undefined]) {
    expectBuilderError({ ...BUILDER_INPUT, roundIndex }, 'invalid_reporting_round_index');
  }
  expectBuilderError({ ...BUILDER_INPUT, repository: 'a/b' }, 'invalid_reporting_repository');
  expectBuilderError({ ...BUILDER_INPUT, branch: 'a b' }, 'invalid_reporting_branch');
  for (const timeKst of ['9:12', '24:00', '09:60', '09:12 KST', '', undefined]) {
    expectBuilderError({ ...BUILDER_INPUT, timeKst }, 'invalid_reporting_start_message');
  }
});

test('builder sanitizes the free-text slots and never echoes rejected text', () => {
  for (const scope of ['', ' 앞공백', '뒷공백 ', '- 미리 조립된 불릿', '두\n줄', '제어문자', undefined]) {
    expectBuilderError({ ...BUILDER_INPUT, scope }, 'invalid_reporting_start_message');
  }
  // A slot made only of zero-width characters renders as blank and fails the
  // validator's visible-bullet check.
  expectBuilderError({ ...BUILDER_INPUT, externalAction: '​​' }, 'invalid_reporting_start_message');

  // The forbidden-content screen runs through the same validator path.
  const screened = 'git status 출력 정리';
  try {
    buildAcpStartMessage({ ...BUILDER_INPUT, scope: screened });
    assert.fail('expected forbidden-content rejection');
  } catch (err) {
    assert.ok(err instanceof AcpReportingContractError);
    assert.equal(err.code, 'invalid_reporting_forbidden_content');
    assert.ok(!err.message.includes(screened), 'error message must not echo the rejected slot text');
  }
});

test('builder-generated messages validate under the existing reporting contract', () => {
  for (const [agent, context] of [
    ['claude', CONTEXT],
    ['codex', CODEX_CONTEXT],
  ]) {
    for (const roundIndex of [1, 3]) {
      const startMessage = buildAcpStartMessage({
        agent,
        model: context.model,
        roundIndex,
        repository: REPO,
        branch: BRANCH,
        timeKst: '18:30',
        scope: '보고 계약 모듈과 테스트 구현',
        externalAction: '없음',
      });
      const reporting = buildReporting({ agent, model: context.model, roundIndex });
      reporting.startMessage = startMessage;
      reporting.startReceipt.message = startMessage;
      const normalized = validateAcpReportingContract(reporting, context);
      assert.equal(normalized.startMessage, startMessage);
    }
  }
});

test('regression: hand-written round-1 title in a correction round fails; builder output cannot', () => {
  // The prior mismatch class: a correction-round config whose hand-assembled
  // startMessage still carries the round-1 🚀 title. Hand-written, it slips
  // into the bundle and only the validator catches it …
  const drifted = buildReporting({ roundIndex: 3 });
  const round1Title = buildStartMessage({ roundIndex: 1 });
  drifted.startMessage = round1Title;
  drifted.startReceipt.message = round1Title;
  expectRejected(drifted, 'invalid_reporting_start_message');

  // … while the builder derives the title from roundIndex alone, so the same
  // structured input can only ever render the correction title.
  const built = buildAcpStartMessage({
    agent: 'claude',
    model: CONTEXT.model,
    roundIndex: 3,
    repository: REPO,
    branch: BRANCH,
    timeKst: '18:30',
    scope: '보고 계약 모듈과 테스트 구현',
    externalAction: '없음',
  });
  assert.ok(built.startsWith('🔁 **ACP 수정 라운드 3 시작 · '));
  const reporting = buildReporting({ roundIndex: 3 });
  reporting.startMessage = built;
  reporting.startReceipt.message = built;
  validateAcpReportingContract(reporting, CONTEXT);
});

const REPORT_BUILDER_IDENTITY = Object.freeze({
  agent: 'codex',
  model: 'gpt-5-codex',
  roundIndex: 2,
  repository: REPO,
  branch: BRANCH,
  timeKst: '19:10',
});
// The free-text elapsed slot survives only on the terminal 소요 line; the
// intermediate time line is structured.
const TERMINAL_BUILDER_IDENTITY = Object.freeze({
  ...REPORT_BUILDER_IDENTITY,
  elapsed: '17분 경과',
});
const INTERMEDIATE_TIME_FIELDS = Object.freeze({
  totalMinutes: 17,
  phaseMinutes: 6,
  lastAcpActivityMinutesAgo: 2,
});

test('canonical intermediate builder derives title, label, metadata order, and fixed sections', () => {
  const message = buildAcpIntermediateReport({
    ...REPORT_BUILDER_IDENTITY,
    ...INTERMEDIATE_TIME_FIELDS,
    phaseIndex: 3,
    executionState: '자체 검증이 진행되는 중',
    newResultDelta: 1,
    newResult: '게이트 구현 완료',
    inProgress: '통합 테스트 실행',
    verification: '집중 테스트 통과',
    next: '전체 회귀 테스트 실행',
  });
  assert.equal(message, [
    '🔄 **ACP 중간 보고 · 19:10 KST**',
    '',
    '🤖 **ACP**: Codex · `gpt-5-codex`',
    `📍 **작업**: \`${REPO}\` · \`${BRANCH}\``,
    '🔢 **라운드**: 2 · 3/4 자체 검증',
    '⏱️ **ACP 시간**: 전체 17분 · 현재 단계 6분 · 마지막 ACP 활동 2분 전',
    '🔁 **실행 상태**: 자체 검증이 진행되는 중',
    '',
    '✅ **새 결과**',
    '- Δ1 · 게이트 구현 완료',
    '',
    '🛠️ **ACP 진행 중**',
    '- 통합 테스트 실행',
    '',
    '🧪 **ACP 자체 검증**',
    '- 집중 테스트 통과',
    '',
    '⏭️ **ACP 다음**',
    '- 전체 회귀 테스트 실행',
  ].join('\n'));
});

test('canonical completed builder is byte-exact with the established 20-line success contract', () => {
  const message = buildAcpTerminalReport({
    ...TERMINAL_BUILDER_IDENTITY,
    status: 'completed',
    summary: '요청 범위 구현 완료',
    verification: '전체 테스트 통과',
    result: '로컬 커밋 1개 · 변경 파일 9개',
    next: 'Eli 독립 검증 시작',
    externalAction: '없음',
  });
  assert.equal(message, [
    '🏁 **ACP 완료 보고 · 19:10 KST**',
    '',
    '🤖 **ACP**: Codex · `gpt-5-codex`',
    `📍 **작업**: \`${REPO}\` · \`${BRANCH}\``,
    '⏱️ **ACP 소요**: 17분 경과 · 라운드 2',
    '',
    '✅ **ACP 완료**',
    '- 요청 범위 구현 완료',
    '',
    '🧪 **ACP 자체 검증**',
    '- 전체 테스트 통과',
    '',
    '📦 **결과**',
    '- 로컬 커밋 1개 · 변경 파일 9개',
    '',
    '🔍 **다음**',
    '- Eli 독립 검증 시작',
    '',
    '🔒 **외부 작업**',
    '- 없음',
  ].join('\n'));
});

test('cancelled and failed terminal builders stay visibly distinct from success', () => {
  const report = (status) => buildAcpTerminalReport({
    ...TERMINAL_BUILDER_IDENTITY,
    status,
    summary: '터미널 경계 확인',
    verification: '상태 검증',
    result: '변경 없음',
    next: '원인 검토',
    externalAction: '없음',
  });
  const cancelled = report('cancelled');
  const failed = report('failed');
  assert.equal(cancelled.startsWith('⛔ **ACP 취소 보고 · 19:10 KST**'), true);
  assert.equal(cancelled.includes('\n⛔ **ACP 취소**\n'), true);
  assert.equal(failed.startsWith('❌ **ACP 실패 보고 · 19:10 KST**'), true);
  assert.equal(failed.includes('\n❌ **ACP 실패**\n'), true);
  assert.equal(cancelled.includes('🏁 **ACP 완료 보고'), false);
  assert.equal(failed.includes('🏁 **ACP 완료 보고'), false);
});

test('report builders reject caller title, label, phase, status, and forbidden template drift', () => {
  const intermediate = {
    ...REPORT_BUILDER_IDENTITY,
    ...INTERMEDIATE_TIME_FIELDS,
    phaseIndex: 2,
    executionState: '구현 중',
    newResultDelta: 1,
    newResult: '결과',
    inProgress: '진행',
    verification: '검증',
    next: '다음',
  };
  expectContractError(() => buildAcpIntermediateReport({ ...intermediate, title: 'spoof' }), 'invalid_reporting_context');
  expectContractError(() => buildAcpIntermediateReport({ ...intermediate, agentLabel: 'Claude Code' }), 'invalid_reporting_context');
  expectContractError(() => buildAcpIntermediateReport({ ...intermediate, phaseIndex: 9 }), 'invalid_reporting_report');
  expectContractError(() => buildAcpIntermediateReport({ ...intermediate, next: 'git status 확인' }), 'invalid_reporting_forbidden_content');
  expectContractError(() => buildAcpTerminalReport({
    ...TERMINAL_BUILDER_IDENTITY,
    status: 'success',
    summary: '완료',
    verification: '통과',
    result: '결과',
    next: '검토',
    externalAction: '없음',
  }), 'invalid_reporting_report');
});

test('intermediate builder derives the structured 시간 line and rejects ambiguous or incoherent time input', () => {
  const valid = {
    ...REPORT_BUILDER_IDENTITY,
    ...INTERMEDIATE_TIME_FIELDS,
    phaseIndex: 2,
    executionState: '구현 중',
    newResultDelta: 1,
    newResult: '결과',
    inProgress: '진행',
    verification: '검증',
    next: '다음',
  };
  // The pre-migration free-text elapsed key is ambiguous old input and the
  // builder input shape is not a committed compatibility contract: reject.
  expectContractError(() => buildAcpIntermediateReport({ ...valid, elapsed: '17분 경과' }), 'invalid_reporting_context');
  // So is the ambiguous lastAcpStateChangeAt spelling of the activity age.
  expectContractError(() => buildAcpIntermediateReport({ ...valid, lastAcpStateChangeAt: '2026-08-31T10:00:00.000Z' }), 'invalid_reporting_context');
  for (const field of ['totalMinutes', 'phaseMinutes', 'lastAcpActivityMinutesAgo']) {
    const missing = { ...valid };
    delete missing[field];
    expectContractError(() => buildAcpIntermediateReport(missing), 'invalid_reporting_report');
    expectContractError(() => buildAcpIntermediateReport({ ...valid, [field]: -1 }), 'invalid_reporting_report');
    expectContractError(() => buildAcpIntermediateReport({ ...valid, [field]: 3.5 }), 'invalid_reporting_report');
    expectContractError(() => buildAcpIntermediateReport({ ...valid, [field]: '17분' }), 'invalid_reporting_report');
  }
  expectContractError(() => buildAcpIntermediateReport({ ...valid, phaseMinutes: 18 }), 'invalid_reporting_report');
  expectContractError(() => buildAcpIntermediateReport({ ...valid, lastAcpActivityMinutesAgo: 18 }), 'invalid_reporting_report');
});

test('Δ counts newly completed results and requires the canonical no-result bullet at Δ0', () => {
  const base = {
    ...REPORT_BUILDER_IDENTITY,
    ...INTERMEDIATE_TIME_FIELDS,
    phaseIndex: 2,
    executionState: '구현 중',
    inProgress: '진행',
    verification: '검증',
    next: '다음',
  };
  const delta3 = buildAcpIntermediateReport({ ...base, newResultDelta: 3, newResult: '완료 항목 셋' });
  assert.equal(delta3.includes('\n- Δ3 · 완료 항목 셋\n'), true);
  expectContractError(() => buildAcpIntermediateReport({ ...base, newResultDelta: 0, newResult: '결과' }), 'invalid_reporting_report');
  expectContractError(() => buildAcpIntermediateReport({ ...base, newResultDelta: 1 }), 'invalid_reporting_report');
  expectContractError(() => buildAcpIntermediateReport({ ...base, newResultDelta: -1, newResult: '결과' }), 'invalid_reporting_report');
  expectContractError(() => buildAcpIntermediateReport({ ...base, newResultDelta: '1', newResult: '결과' }), 'invalid_reporting_report');
  const missingDelta = { ...base, newResult: '결과' };
  expectContractError(() => buildAcpIntermediateReport(missingDelta), 'invalid_reporting_report');
});

test('regression: 마지막 ACP 활동 0분 전 validly coexists with Δ0 · 새로 확인된 ACP 결과 없음', () => {
  // Activity age and Δ are independent: the run just produced normalized ACP
  // activity (age 0), yet no result completed since the previous successfully
  // delivered intermediate report (Δ0). Both statements share one report.
  const message = buildAcpIntermediateReport({
    ...REPORT_BUILDER_IDENTITY,
    totalMinutes: 20,
    phaseMinutes: 8,
    lastAcpActivityMinutesAgo: 0,
    phaseIndex: 2,
    executionState: '범위 내 작업이 계속되는 중',
    newResultDelta: 0,
    inProgress: '긴 통합 테스트 실행',
    verification: '이전 검증 유지',
    next: '테스트 완료 대기',
  });
  const lines = message.split('\n');
  assert.equal(lines[5], '⏱️ **ACP 시간**: 전체 20분 · 현재 단계 8분 · 마지막 ACP 활동 0분 전');
  assert.equal(lines[9], '- Δ0 · 새로 확인된 ACP 결과 없음');
  // The mirror case: a completed result increments Δ independently of a
  // stale activity age.
  const staleActivity = buildAcpIntermediateReport({
    ...REPORT_BUILDER_IDENTITY,
    totalMinutes: 20,
    phaseMinutes: 8,
    lastAcpActivityMinutesAgo: 5,
    phaseIndex: 2,
    executionState: '범위 내 작업이 계속되는 중',
    newResultDelta: 2,
    newResult: '완료된 결과 두 건',
    inProgress: '다음 작업 준비',
    verification: '검증 진행',
    next: '다음 단계',
  });
  assert.equal(staleActivity.split('\n')[5], '⏱️ **ACP 시간**: 전체 20분 · 현재 단계 8분 · 마지막 ACP 활동 5분 전');
  assert.equal(staleActivity.split('\n')[9], '- Δ2 · 완료된 결과 두 건');
});

test('report-message CLI builds both canonical kinds and rejects title drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-report-builder-cli-'));
  const run = (value) => {
    const inputFile = path.join(root, `${Math.random()}.json`);
    fs.writeFileSync(inputFile, JSON.stringify(value), { mode: 0o600 });
    return spawnSync(process.execPath, [REPORT_MESSAGE_CLI, '--input', inputFile], { encoding: 'utf8' });
  };
  const intermediate = run({
    kind: 'intermediate',
    report: {
      ...REPORT_BUILDER_IDENTITY,
      ...INTERMEDIATE_TIME_FIELDS,
      phaseIndex: 2,
      executionState: '구현 중',
      newResultDelta: 0,
      inProgress: '진행',
      verification: '검증',
      next: '다음',
    },
  });
  assert.equal(intermediate.status, 0);
  assert.equal(intermediate.stdout.startsWith('🔄 **ACP 중간 보고'), true);
  assert.equal(intermediate.stdout.includes('마지막 ACP 활동 2분 전'), true);
  assert.equal(intermediate.stdout.includes('- Δ0 · 새로 확인된 ACP 결과 없음'), true);
  const terminal = run({
    kind: 'terminal',
    report: {
      ...TERMINAL_BUILDER_IDENTITY,
      status: 'failed',
      summary: '실패 경계 확인',
      verification: '오류 확인',
      result: '변경 없음',
      next: '원인 검토',
      externalAction: '없음',
    },
  });
  assert.equal(terminal.status, 0);
  assert.equal(terminal.stdout.startsWith('❌ **ACP 실패 보고'), true);
  const drift = run({
    kind: 'terminal',
    report: {
      ...TERMINAL_BUILDER_IDENTITY,
      status: 'completed',
      title: 'caller title',
      summary: '완료',
      verification: '검증',
      result: '결과',
      next: '검토',
      externalAction: '없음',
    },
  });
  assert.equal(drift.status, 64);
  assert.equal(JSON.parse(drift.stderr).code, 'invalid_reporting_context');
});

test('report builders allow Claude runtime default but require explicit non-Claude models', () => {
  const intermediate = {
    ...REPORT_BUILDER_IDENTITY,
    ...INTERMEDIATE_TIME_FIELDS,
    agent: 'claude',
    phaseIndex: 2,
    executionState: '구현 중',
    newResultDelta: 0,
    inProgress: '진행',
    verification: '검증',
    next: '다음',
  };
  delete intermediate.model;
  const claude = buildAcpIntermediateReport(intermediate);
  assert.equal(claude.includes('Claude Code · `runtime-default`'), true);
  const terminal = {
    ...TERMINAL_BUILDER_IDENTITY,
    agent: 'claude',
    status: 'completed',
    summary: '완료',
    verification: '검증',
    result: '결과',
    next: '확인',
    externalAction: '없음',
  };
  delete terminal.model;
  assert.equal(buildAcpTerminalReport(terminal).includes('Claude Code · `runtime-default`'), true);

  const codexMissing = { ...intermediate, agent: 'codex' };
  expectContractError(() => buildAcpIntermediateReport(codexMissing), 'invalid_reporting_context');
  expectContractError(() => buildAcpIntermediateReport({
    ...codexMissing,
    model: 'runtime-default',
  }), 'invalid_reporting_context');
  expectContractError(() => buildAcpTerminalReport({ ...terminal, agent: 'codex' }), 'invalid_reporting_context');
  expectContractError(() => buildAcpStartMessage({
    agent: 'codex',
    model: 'runtime-default',
    roundIndex: 1,
    repository: REPO,
    branch: BRANCH,
    timeKst: '12:34',
    scope: '범위 확인',
    externalAction: '없음',
  }), 'invalid_reporting_context');
});

test('phaseIndex accepts only integer own properties of the canonical phase map', () => {
  const base = {
    ...REPORT_BUILDER_IDENTITY,
    ...INTERMEDIATE_TIME_FIELDS,
    executionState: '구현 중',
    newResultDelta: 0,
    inProgress: '진행',
    verification: '검증',
    next: '다음',
  };
  for (const phaseIndex of ['2', 'toString', 2.5, 0, 5]) {
    expectContractError(
      () => buildAcpIntermediateReport({ ...base, phaseIndex }),
      'invalid_reporting_report'
    );
  }
  assert.equal(buildAcpIntermediateReport({ ...base, phaseIndex: 2 }).includes('2/4 구현'), true);
});

test('report input reader distinguishes empty, oversized, unreadable, and invalid JSON files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-report-reader-'));
  const empty = path.join(root, 'empty.json');
  const oversized = path.join(root, 'oversized.json');
  const invalid = path.join(root, 'invalid.json');
  const readable = path.join(root, 'readable.json');
  fs.writeFileSync(empty, '', { mode: 0o600 });
  fs.writeFileSync(oversized, 'x'.repeat(65537), { mode: 0o600 });
  fs.writeFileSync(invalid, '{', { mode: 0o600 });
  fs.writeFileSync(readable, '{}', { mode: 0o600 });
  assert.throws(() => readReportMessageInput(empty), /invalid_input_file_empty/);
  assert.throws(() => readReportMessageInput(oversized), /invalid_input_file_too_large/);
  assert.throws(() => readReportMessageInput(invalid), /invalid_input_json/);
  assert.throws(() => readReportMessageInput(readable, {
    fileSystem: {
      lstatSync: (filePath) => fs.lstatSync(filePath),
      readFileSync() {
        const error = new Error('synthetic unreadable');
        error.code = 'EACCES';
        throw error;
      },
    },
  }), /invalid_input_file_unreadable/);
});

// ---------------------------------------------------------------------------
// acp-reporting-v3: the enabled report-pump attestation supersedes the
// disabled-snapshot watchdog. v3 carries no static report payload at all.
// ---------------------------------------------------------------------------

function buildReportingV3({
  roundIndex = 1,
  agent = 'claude',
  label = AGENT_LABELS[agent] ?? String(agent),
  model = CONTEXT.model,
  repository = REPO,
  branch = BRANCH,
  pump = {},
} = {}) {
  const startMessage = buildStartMessage({ roundIndex, label, model, repository, branch });
  return {
    schemaVersion: 'acp-reporting-v3',
    agent,
    roundIndex,
    repository,
    branch,
    startMessage,
    startDestination: CONTEXT.controlConversationId,
    pumpDestination: CONTEXT.controlConversationId,
    terminalDestination: CONTEXT.controlConversationId,
    startReceipt: { ...CONTEXT.lifecycleStartReceipt, message: startMessage },
    reportPump: {
      id: `acp-report-pump-round-${roundIndex}`,
      roundIndex,
      enabled: true,
      sessionTarget: 'isolated',
      schedule: { kind: 'every', everyMs: 600000 },
      delivery: {
        mode: 'announce',
        channel: 'discord',
        to: `channel:${CONTEXT.controlConversationId}`,
      },
      deleteAfterRun: false,
      ...pump,
    },
  };
}

test('valid acp-reporting-v3 bundle passes for claude and codex and normalizes the pump', () => {
  const claude = buildReportingV3();
  const normalized = validateAcpReportingContract(claude, CONTEXT);
  assert.notEqual(normalized, claude);
  assert.deepEqual(normalized, claude);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.reportPump));
  assert.equal(normalized.reportPump.enabled, true);
  assert.equal(normalized.pumpDestination, CONTEXT.controlConversationId);
  assert.equal('watchdog' in normalized, false);
  assert.equal('watchdogDestination' in normalized, false);

  const codex = buildReportingV3({ agent: 'codex', model: CODEX_CONTEXT.model });
  const codexNormalized = validateAcpReportingContract(codex, CODEX_CONTEXT);
  assert.equal(codexNormalized.agent, 'codex');
  assert.equal(codexNormalized.reportPump.schedule.everyMs, 600000);
});

test('acp-reporting-v3 requires the agent attestation to equal the canonical config agent', () => {
  const spoofed = buildReportingV3();
  spoofed.agent = 'codex';
  expectRejected(spoofed, 'invalid_reporting_agent');
  const missing = buildReportingV3();
  delete missing.agent;
  expectRejected(missing, 'invalid_reporting_agent');
});

test('acp-reporting-v3 rejects a disabled, mis-scheduled, mis-routed, or mis-bound pump', () => {
  expectRejected(buildReportingV3({ pump: { enabled: false } }), 'invalid_reporting_report_pump');
  expectRejected(buildReportingV3({ pump: { sessionTarget: 'main' } }), 'invalid_reporting_report_pump');
  expectRejected(buildReportingV3({ pump: { deleteAfterRun: true } }), 'invalid_reporting_report_pump');
  expectRejected(buildReportingV3({ pump: { id: 'has whitespace' } }), 'invalid_reporting_report_pump');
  expectRejected(
    buildReportingV3({ pump: { roundIndex: 2 } }),
    'invalid_reporting_report_pump_round'
  );
  expectRejected(
    buildReportingV3({ pump: { schedule: { kind: 'every', everyMs: 300000 } } }),
    'invalid_reporting_report_pump_schedule'
  );
  expectRejected(
    buildReportingV3({ pump: { delivery: { mode: 'announce', channel: 'discord', to: `channel:${OTHER_CHANNEL}` } } }),
    'invalid_reporting_report_pump_delivery'
  );
});

test('acp-reporting-v3 carries no static report payload and no watchdog keys', () => {
  // A payload smuggled into the pump attestation is an unknown key: report
  // content is machine-derived per claim, never replayed from the config.
  expectRejected(
    buildReportingV3({ pump: { payload: { kind: 'agentTurn', toolsAllow: [], timeoutSeconds: 45, message: 'static' } } }),
    'invalid_reporting_report_pump'
  );
  const withWatchdog = buildReportingV3();
  withWatchdog.watchdog = buildReporting().watchdog;
  expectRejected(withWatchdog, 'invalid_reporting_unknown_key');
  const withWatchdogDestination = buildReportingV3();
  withWatchdogDestination.watchdogDestination = CONTEXT.controlConversationId;
  expectRejected(withWatchdogDestination, 'invalid_reporting_unknown_key');
  // The v2/v1 watchdog shapes remain accepted as the bounded migration path.
  assert.equal(
    validateAcpReportingContract(buildReporting(), CONTEXT).schemaVersion,
    'acp-reporting-v2'
  );
});
