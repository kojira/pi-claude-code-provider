import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VERIFIED_VERSIONS } from "../../src/compatibility.ts";
import { PAID_LAUNCH_BUDGET_ENV } from "../../src/paid-launch-budget.ts";
import { closeLiveRpcProcess, consumeJsonl, superviseLiveProcess } from "../../scripts/lib/live-process.js";
import { piCliEntry } from "../../scripts/lib/pi-installation.js";
import { CLAUDE_HEADLESS_HELP, ELIGIBLE_CLAUDE_AUTH } from "../support/claude-fixture.js";
import { nodeFixtureArgs, nodeFixtureSource } from "../support/node-fixture.js";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("../..", import.meta.url));

async function fakeClaude(directory) {
  const executable = join(directory, process.platform === "win32" ? "claude.cjs" : "claude");
  const init = { type: "system", subtype: "init", tools: [], mcp_servers: [], model: "claude-sonnet-5", permissionMode: "dontAsk", slash_commands: [], skills: [], plugins: [], apiKeySource: "none" };
  // This fake CLI must not rely on buffered child stdout in restricted sandboxes.
  await writeFile(executable, nodeFixtureSource(`
if (process.argv.includes("--version")) process.stdout.write(${JSON.stringify(`${VERIFIED_VERSIONS.claudeCode}\n`)});
else if (process.argv[2] === "auth" && process.argv[3] === "status") process.stdout.write(JSON.stringify(${JSON.stringify(ELIGIBLE_CLAUDE_AUTH)}));
else if (process.argv.includes("--help")) process.stdout.write(${JSON.stringify(CLAUDE_HEADLESS_HELP)});
else {
  // Real Claude Code launches the proposal bridge from --mcp-config and lists
  // its tools before accepting the prompt; the provider waits for that ready
  // marker whenever Pi exposes any tool (kojira/pi always exposes its work
  // control tools, even under --no-tools). Mirror that handshake here so the
  // fixture does not stall on the MCP readiness timeout.
  const { spawn } = require("node:child_process");
  const config = JSON.parse(process.argv[process.argv.indexOf("--mcp-config") + 1]);
  const server = config.mcpServers && config.mcpServers.pi;
  let exposedTools = [];
  const finish = () => {
    process.stdout.write(JSON.stringify({ ...${JSON.stringify(init)}, tools: exposedTools, mcp_servers: server ? [{ name: "pi", status: "connected" }] : [] }) + "\\n");
    process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"OK"}) + "\\n");
  };
  const readPrompt = () => {
    process.stdin.resume();
    process.stdin.on("end", finish);
  };
  if (!server) readPrompt();
  else {
    const bridge = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
    let listed = false;
    let buffer = "";
    bridge.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const response = JSON.parse(line);
          if (response.id === 2 && !listed) {
            exposedTools = response.result.tools.map((tool) => "mcp__pi__" + tool.name);
            listed = true; bridge.stdin.end(); readPrompt();
          }
        } catch {}
      }
    });
    bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\\n");
    bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\\n");
  }
}
`), { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

test("paid RPC accounting flushes one metric for every claim before graceful exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-paid-rpc-lifecycle-"));
  const stageDirectory = join(directory, "stage");
  const aggregateDirectory = join(directory, "aggregate");
  const metricsPath = join(directory, "metrics.jsonl");
  await mkdir(stageDirectory);
  await mkdir(aggregateDirectory);
  const executable = await fakeClaude(directory);
  // Preload only the test-launched Pi process; runtime Pi behavior stays unchanged.
  const child = spawn(process.execPath, nodeFixtureArgs([
    piCliEntry(), "--mode", "rpc", "--no-session", "--no-extensions", "-e", root,
    "--no-skills", "--no-context-files", "--provider", "pi-claude-code-provider",
    "--model", "sonnet:medium", "--no-tools",
  ]), {
    cwd: directory,
    detached: process.platform !== "win32",
    windowsHide: process.platform === "win32",
    env: {
      ...process.env,
      PI_CLAUDE_CODE_PROVIDER_PATH: executable,
      PI_CLAUDE_CODE_PROVIDER_METRICS_LOG: metricsPath,
      [PAID_LAUNCH_BUDGET_ENV.child]: "1",
      [PAID_LAUNCH_BUDGET_ENV.stageDirectory]: stageDirectory,
      [PAID_LAUNCH_BUDGET_ENV.stageCap]: "2",
      [PAID_LAUNCH_BUDGET_ENV.aggregateDirectory]: aggregateDirectory,
      [PAID_LAUNCH_BUDGET_ENV.aggregateCap]: "2",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const supervisor = superviseLiveProcess(child, { timeoutMs: 15_000, label: "paid RPC lifecycle fixture" });
  const closed = supervisor.wait();
  let pending;
  const events = [];
  let protocolError;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024); });
  void closed.then(
    ({ code, signal }) => pending?.reject(new Error(`Pi fixture exited (code ${String(code)}, signal ${String(signal)}): ${stderr}`)),
    (error) => pending?.reject(error),
  );
  consumeJsonl(child.stdout, (event) => {
    if (["message_end", "agent_settled", "work_contract"].includes(event.type)) events.push(event.type === "message_end" ? [event.type, event.message?.stopReason, event.message?.errorMessage] : [event.type, event.state]);
    if (event.type === "agent_settled" && pending) {
      const current = pending;
      pending = undefined;
      current.resolve();
    }
  }, (error) => {
    protocolError = error;
    if (pending) {
      const current = pending;
      pending = undefined;
      current.reject(error);
    }
  });
  const turn = (message) => new Promise((resolve, reject) => {
    pending = { resolve, reject };
    child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
  });

  try {
    await turn("Reply exactly OK.");
    if (protocolError) throw protocolError;
    // Modern Pi keeps the work contract active after ordinary text, so one
    // RPC prompt can spend both paid claims on automatic continuations. Older
    // Pi versions settle after the first Claude invocation. Test the actual
    // claim count rather than assuming one claim per user prompt.
    const claimsAfterFirst = (await readdir(stageDirectory)).filter((name) => name.endsWith(".claim")).length;
    if (claimsAfterFirst === 1) {
      await turn("Reply exactly OK again.");
      if (protocolError) throw protocolError;
    }
    const shutdown = await closeLiveRpcProcess(child, supervisor, closed);
    assert.equal(shutdown.graceful, true);
    assert.deepEqual(shutdown.result, { code: 0, signal: null }, stderr);
    assert.equal((await readdir(stageDirectory)).filter((name) => name.endsWith(".claim")).length, 2, JSON.stringify(events));
    assert.equal((await readdir(aggregateDirectory)).filter((name) => name.endsWith(".claim")).length, 2);
    const records = (await readFile(metricsPath, "utf8")).trim().split("\n").map(JSON.parse);
    // Budget rejection can also emit a diagnostic record, but every actual
    // paid launch must have exactly one complete success metric on shutdown.
    const paidRecords = records.filter((record) => record.stopReason === "stop");
    assert.equal(paidRecords.length, 2, JSON.stringify({ events, records, stderr }));
    assert.equal(paidRecords.every((record) => record.cleanupComplete === true), true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) await supervisor.terminate().catch(() => {});
    await closed.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
