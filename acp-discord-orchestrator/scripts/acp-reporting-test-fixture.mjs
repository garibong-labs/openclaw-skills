// Shared integration-test fixture for the ACP reporting bundle. Imported by
// the supervisor suite, the launcher suite, and the repo-root CLI suite so
// the three integration layers exercise one canonical bundle instead of three
// drifting copies. It is intentionally built FROM the contract module's
// exported template constants: the integration layers test wiring, not
// template wording. The standalone contract suite
// (test-acp-reporting-contract.mjs) is the opposite by design — its templates
// are literal so any drift in the module's own constants fails there.
//
// Not a test file: no assertions, nothing executable beyond the builder.

import {
  ACP_AGENT_PRESENTATIONS,
  ACP_REPORTING_SCHEMA_VERSION_V2,
  ACP_REPORT_BEGIN_DELIMITER,
  ACP_REPORT_END_DELIMITER,
  ACP_REPORT_INSTRUCTION,
  ACP_REPORT_ISSUE_HEADER,
  ACP_REPORT_PHASES,
  ACP_REPORT_SECTION_HEADERS,
  buildAcpStartMessage
} from "./acp-reporting-contract.mjs";

export const FIXTURE_REPOSITORY = "openclaw-skills";
export const FIXTURE_BRANCH = "fix/acp-reporting-fail-closed-guard";

const DEFAULT_SECTION_BULLETS = Object.freeze([
  "- 통합 픽스처 준비 완료",
  "- 통합 테스트 작성",
  "- 단위 테스트 통과 확인",
  "- 통합 검증 마무리"
]);

const FIXTURE_START_TIME_KST = "18:30";

// Canonical path: the production builder. Returns null when the fixture
// inputs are not the builder's valid shape (spoofed label, screened bullet,
// non-canonical agent, …) so the caller falls back to literal assembly.
function tryBuildStartMessage({ agent, agentLabel, model, roundIndex, repository, branch, scopeBullet }) {
  if (
    agentLabel !== ACP_AGENT_PRESENTATIONS[agent] ||
    typeof scopeBullet !== "string" ||
    !scopeBullet.startsWith("- ")
  ) {
    return null;
  }
  try {
    return buildAcpStartMessage({
      agent,
      model,
      roundIndex,
      repository,
      branch,
      timeKst: FIXTURE_START_TIME_KST,
      scope: scopeBullet.slice(2),
      externalAction: "없음"
    });
  } catch {
    return null;
  }
}

// Literal fallback for deliberately invalid bundles, byte-identical to the
// builder's output whenever both paths accept the same inputs.
function buildLiteralStartMessage({ agentLabel, model, roundIndex, repository, branch, scopeBullet }) {
  const title = roundIndex === 1
    ? `🚀 **ACP 작업 시작 · ${FIXTURE_START_TIME_KST} KST**`
    : `🔁 **ACP 수정 라운드 ${roundIndex} 시작 · ${FIXTURE_START_TIME_KST} KST**`;
  return [
    title,
    "",
    `🤖 **ACP**: ${agentLabel} · \`${model}\``,
    `📍 **작업**: \`${repository}\` · \`${branch}\``,
    "",
    "🎯 **범위**",
    scopeBullet,
    "",
    "🕒 **중간 보고**",
    "- ACP 실행 10분 이상일 때만 시작",
    "",
    "🔒 **외부 작업**",
    "- 없음"
  ].join("\n");
}

/**
 * Build a fully valid reporting bundle bound to the given canonical agent,
 * control conversation, and lifecycle receipt: a round start message,
 * matching destinations and receipt snapshot, and one disabled tool-less
 * 10-minute public watchdog whose payload carries the exact 19-line (or
 * 22-line, with issueBullet) report layout.
 *
 * Defaults to schema acp-reporting-v2, whose bundle carries the top-level
 * `agent` attestation; pass `schemaVersion: "acp-reporting-v1"` to build the
 * legacy bundle shape (valid only for agent "claude" — the contract enforces
 * that, not this builder). `agentLabel` exists only so tests can deliberately
 * build spoofed bundles; valid bundles always derive the label from the
 * closed presentation mapping.
 */
export function buildValidReporting({
  controlConversationId,
  messageId,
  deliveredAt,
  receiptConversationId = controlConversationId,
  agent = "claude",
  schemaVersion = ACP_REPORTING_SCHEMA_VERSION_V2,
  agentLabel = ACP_AGENT_PRESENTATIONS[agent] ?? String(agent),
  model = "test-model",
  roundIndex = 1,
  repository = FIXTURE_REPOSITORY,
  branch = FIXTURE_BRANCH,
  scopeBullet = "- 통합 픽스처 검증",
  sectionBullets = DEFAULT_SECTION_BULLETS,
  issueBullet = null
}) {
  // The valid path derives the start message through the production builder,
  // so integration fixtures exercise the same canonical preparation path as
  // operators — title and harness-label derivation included. Deliberately
  // invalid fixtures (a spoofed agentLabel, a screened or malformed
  // scopeBullet, a non-canonical agent) cannot pass the fail-closed builder
  // and fall back to literal assembly: the contract under test, not this
  // fixture, must be what rejects them.
  const startMessage =
    tryBuildStartMessage({ agent, agentLabel, model, roundIndex, repository, branch, scopeBullet }) ??
    buildLiteralStartMessage({ agentLabel, model, roundIndex, repository, branch, scopeBullet });
  const reportLines = [
    "🔄 **ACP 중간 보고 · 18:45 KST**",
    "",
    `🤖 **ACP**: ${agentLabel} · \`${model}\``,
    `📍 **작업**: \`${repository}\` · \`${branch}\``,
    `🔢 **라운드**: ${roundIndex} · 2/4 ${ACP_REPORT_PHASES[2]}`,
    "⏱️ **ACP 시간**: 12분 경과",
    "🔁 **실행 상태**: 통합 검증이 계속되는 중",
    ""
  ];
  for (let i = 0; i < ACP_REPORT_SECTION_HEADERS.length; i += 1) {
    reportLines.push(ACP_REPORT_SECTION_HEADERS[i], sectionBullets[i]);
    if (i < ACP_REPORT_SECTION_HEADERS.length - 1) {
      reportLines.push("");
    }
  }
  if (issueBullet) {
    reportLines.push("", ACP_REPORT_ISSUE_HEADER, issueBullet);
  }
  const report = reportLines.join("\n");
  return {
    schemaVersion,
    ...(schemaVersion === ACP_REPORTING_SCHEMA_VERSION_V2 ? { agent } : {}),
    roundIndex,
    repository,
    branch,
    startMessage,
    startDestination: controlConversationId,
    watchdogDestination: controlConversationId,
    terminalDestination: controlConversationId,
    startReceipt: {
      conversationId: receiptConversationId,
      messageId,
      deliveredAt,
      message: startMessage
    },
    watchdog: {
      id: `acp-watchdog-round-${roundIndex}`,
      roundIndex,
      enabled: false,
      sessionTarget: "isolated",
      schedule: { kind: "every", everyMs: 600000 },
      delivery: {
        mode: "announce",
        channel: "discord",
        to: `channel:${controlConversationId}`
      },
      deleteAfterRun: false,
      payload: {
        kind: "agentTurn",
        toolsAllow: [],
        timeoutSeconds: 45,
        message: `${ACP_REPORT_INSTRUCTION}\n\n${ACP_REPORT_BEGIN_DELIMITER}\n${report}\n${ACP_REPORT_END_DELIMITER}`
      }
    }
  };
}
