import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SUPERVISOR_ERROR_EXIT = 22;

const CONTROL_CONVERSATION_ID = "100000000000000001";
const START_MESSAGE_ID = "100000000000000002";
const REPORT_REPOSITORY = "openclaw-skills";
const REPORT_BRANCH = "fix/acp-reporting-fail-closed-guard";
const REPORT_INSTRUCTION =
  "다음 구분자 사이의 메시지만 그대로 반환해. 앞말·뒷말·설명·코드펜스·바꿔쓰기·두 번째 메시지를 추가하지 마.";

// Deterministic acp-reporting-v1 bundle mirroring the canonical fixture in
// the supervisor unit suite, bound to this test's lifecycle receipt so the
// config passes the mandatory reporting gate and reaches turn execution.
function validReporting(deliveredAt, model = "test-model") {
  const startMessage = [
    "🚀 **ACP 작업 시작 · 18:30 KST**",
    "",
    "🤖 **ACP**: Claude Code · `" + model + "`",
    "📍 **작업**: `" + REPORT_REPOSITORY + "` · `" + REPORT_BRANCH + "`",
    "",
    "🎯 **범위**",
    "- CLI 종료 코드 검증",
    "",
    "🕒 **중간 보고**",
    "- ACP 실행 10분 이상일 때만 시작",
    "",
    "🔒 **외부 작업**",
    "- 없음"
  ].join("\n");
  const report = [
    "🔄 **ACP 중간 보고 · 18:45 KST**",
    "",
    "🤖 **ACP**: Claude Code · `" + model + "`",
    "📍 **작업**: `" + REPORT_REPOSITORY + "` · `" + REPORT_BRANCH + "`",
    "🔢 **라운드**: 1 · 2/4 구현",
    "⏱️ **ACP 시간**: 12분 경과",
    "🔁 **실행 상태**: CLI 종료 코드 검증이 계속되는 중",
    "",
    "✅ **새 결과**",
    "- CLI 픽스처 준비 완료",
    "",
    "🛠️ **ACP 진행 중**",
    "- CLI 종료 테스트 작성",
    "",
    "🧪 **ACP 자체 검증**",
    "- 단위 테스트 통과 확인",
    "",
    "⏭️ **ACP 다음**",
    "- 통합 검증 마무리"
  ].join("\n");
  return {
    schemaVersion: "acp-reporting-v1",
    roundIndex: 1,
    repository: REPORT_REPOSITORY,
    branch: REPORT_BRANCH,
    startMessage,
    startDestination: CONTROL_CONVERSATION_ID,
    watchdogDestination: CONTROL_CONVERSATION_ID,
    terminalDestination: CONTROL_CONVERSATION_ID,
    startReceipt: {
      conversationId: CONTROL_CONVERSATION_ID,
      messageId: START_MESSAGE_ID,
      deliveredAt,
      message: startMessage
    },
    watchdog: {
      id: "acp-watchdog-round-1",
      roundIndex: 1,
      enabled: false,
      sessionTarget: "isolated",
      schedule: { kind: "every", everyMs: 600000 },
      delivery: {
        mode: "announce",
        channel: "discord",
        to: "channel:" + CONTROL_CONVERSATION_ID
      },
      deleteAfterRun: false,
      payload: {
        kind: "agentTurn",
        toolsAllow: [],
        timeoutSeconds: 45,
        message: REPORT_INSTRUCTION + "\n\n---BEGIN ACP REPORT---\n" + report + "\n---END ACP REPORT---"
      }
    }
  };
}

test("CLI exits with the mapped code despite a leaked runtime handle", {
  timeout: 5000
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-cli-exit-"));
  const runtimeFile = path.join(root, "runtime.mjs");
  const promptFile = path.join(root, "prompt.txt");
  const responseFile = path.join(root, "response.txt");
  const configFile = path.join(root, "run.json");
  const stateDir = path.join(root, "state");

  fs.writeFileSync(runtimeFile, `
export function createRuntimeStore() { return {}; }
export function createAgentRegistry() { return {}; }
export function createAcpRuntime() {
  setInterval(() => {}, 1000);
  return {
    async ensureSession() { return { sessionId: "mock" }; },
    startTurn(input) {
      return {
        requestId: input.requestId,
        events: { async *[Symbol.asyncIterator]() {} },
        result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        async cancel() {},
        async closeStream() {}
      };
    },
    async close() { throw new Error("simulated cleanup failure"); }
  };
}
`, { mode: 0o600 });
  fs.writeFileSync(promptFile, "bounded no-op", { mode: 0o600 });
  const deliveredAt = new Date().toISOString();
  fs.writeFileSync(configFile, JSON.stringify({
    agent: "test-agent",
    model: "test-model",
    cwd: root,
    sessionKey: "cli-exit-test",
    promptFile,
    responseFile,
    stateDir,
    timeoutMs: 1000,
    progressMs: 0,
    lifecycle: {
      controlConversationId: CONTROL_CONVERSATION_ID,
      maxStartReceiptAgeMs: 60000,
      startReceipt: {
        conversationId: CONTROL_CONVERSATION_ID,
        messageId: START_MESSAGE_ID,
        deliveredAt
      }
    },
    reporting: validReporting(deliveredAt),
    allowKinds: ["read"],
    runtimeModule: runtimeFile
  }), { mode: 0o600 });

  const supervisorFile = fileURLToPath(new URL(
    "../acp-discord-orchestrator/scripts/acpx-foreground-supervisor.mjs",
    import.meta.url
  ));
  const child = spawn(process.execPath, [
    supervisorFile,
    "--config",
    configFile
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI did not exit after terminal output"));
    }, 3000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  assert.deepEqual(outcome, {
    code: SUPERVISOR_ERROR_EXIT,
    signal: null
  });
  assert.equal(stderr, "");
  assert.equal(fs.existsSync(responseFile), true);
  const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "terminal");
  assert.equal(events.at(-1).status, "completed");
  assert.equal(events.at(-1).supervisorStatus, "degraded");
  assert.equal(events.at(-1).cleanupOk, false);
});
