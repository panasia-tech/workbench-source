"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "../..");
const modularRoot = projectRoot;

async function main() {
  const importStandaloneModule = async (relativePath) => {
    const source = fs.readFileSync(path.join(modularRoot, relativePath), "utf8");
    return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  };
  const stateMachine = await importStandaloneModule("src/main/seller-state-machine.js");
  const schedule = await importStandaloneModule("src/main/seller-schedule.js");

  assert.deepStrictEqual([...stateMachine.SELLER_STATUSES], [
    "pending", "running", "completed", "no_active", "incomplete",
    "needs_review", "failed", "login_expired", "risk_cooldown"
  ]);

  const complete = stateMachine.evaluateSellerEvidence({
    expected: { active: 2, sold: 1 },
    expectedTrusted: { active: true, sold: true },
    itemIds: { active: ["active-1", "active-2"], sold: ["sold-1"] }
  });
  assert.strictEqual(complete.status, "completed", "trusted active/sold evidence must complete");

  const incomplete = stateMachine.evaluateSellerEvidence({
    expected: { active: 2, sold: 1 },
    expectedTrusted: { active: true, sold: true },
    itemIds: { active: ["active-1"], sold: ["sold-1"] }
  });
  assert.strictEqual(incomplete.status, "incomplete", "short trusted count must remain incomplete");

  const accounts = stateMachine.validateAccountIdentities([
    { id: "account-a", partition: "persist:seller-a" },
    { id: "account-b", partition: "persist:seller-b" }
  ]);
  assert.strictEqual(accounts.length, 2);

  const due = schedule.evaluateSchedule({
    now: new Date("2026-08-24T02:00:00+08:00"),
    settings: { weeklyEnabled: true, weeklyDay: 1, weeklyTime: "02:00", timezone: "Asia/Shanghai" },
    lastCycle: null,
    running: false
  });
  assert.strictEqual(due.outcome, "scheduled", "Monday 02:00 Shanghai must be scheduled");

  console.log(JSON.stringify({
    ok: true,
    implementationRoot: path.relative(projectRoot, modularRoot),
    exercisedExports: [
      "seller-state-machine.evaluateSellerEvidence",
      "seller-state-machine.validateAccountIdentities",
      "seller-schedule.evaluateSchedule"
    ]
  }, null, 2));
}

const timeoutMs = 10_000;
let timeout;
Promise.race([
  main(),
  new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`offline seller runtime harness timed out after ${timeoutMs}ms`)), timeoutMs);
    timeout.unref();
  })
]).then(() => {
  clearTimeout(timeout);
}).catch((error) => {
  clearTimeout(timeout);
  console.error(`seller RPA runtime harness: FAIL\n${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
});
