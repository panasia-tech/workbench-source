"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const modularRoot = root;
const legacyRootEntry = path.join(root, "legacy/rank_rpa.py");
const sourceRoots = [
  path.join(modularRoot, "src/main"),
  path.join(modularRoot, "src/preload"),
  path.join(modularRoot, "src/renderer/src")
];
const sellerFiles = [
  "src/main/seller-state-machine.js",
  "src/main/seller-schedule.js",
  "src/main/seller-store.js",
  "src/main/seller-scheduler.js",
  "src/main/seller-worker.js",
  "src/main/seller-goofish.js",
  "src/preload/index.js",
  "src/renderer/src/views/SellerCrawl.vue"
].map((relative) => path.join(modularRoot, relative));
const forbidden = [
  /\bopenai\b/i,
  /\banthropic\b/i,
  /\bchatgpt\b/i,
  /from\s+['"].*llm/i,
  /seller.*llm|llm.*seller/i
];

function filesUnder(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => filesUnder(path.join(target, entry.name)));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function main() {
  assert(sourceRoots.every((target) => fs.existsSync(target) && fs.statSync(target).isDirectory()), "modular Electron source roots must exist");
  assert(sellerFiles.every((target) => fs.existsSync(target) && fs.statSync(target).isFile()), "canonical seller modules must all exist");

  const scanned = sellerFiles.map((file) => ({ file, value: fs.readFileSync(file, "utf8") }));
  const violations = scanned.flatMap(({ file, value }) => forbidden
    .filter((pattern) => pattern.test(value))
    .map((pattern) => `${path.relative(root, file)} matched ${pattern}`));
  assert.deepStrictEqual(violations, [], `seller modules must not depend on a model service:\n${violations.join("\n")}`);

  const stateMachine = fs.readFileSync(path.join(modularRoot, "src/main/seller-state-machine.js"), "utf8");
  for (const symbol of ["SELLER_STATUSES", "evaluateSellerEvidence", "validateAccountIdentities", "decideNextAttempt"]) {
    assert(stateMachine.includes("export ") && stateMachine.includes(symbol), `canonical state-machine export missing: ${symbol}`);
  }
  const scheduler = fs.readFileSync(path.join(modularRoot, "src/main/seller-scheduler.js"), "utf8");
  for (const symbol of ["computeSellerDelay", "claimNext", "finalizeFormalAttempt", "getSellerWebContents"]) {
    assert(scheduler.includes(symbol), `canonical seller scheduler seam missing: ${symbol}`);
  }

  const preload = fs.readFileSync(path.join(modularRoot, "src/preload/index.js"), "utf8");
  const renderer = fs.readFileSync(path.join(modularRoot, "src/renderer/src/views/SellerCrawl.vue"), "utf8");
  assert(preload.includes("seller:"), "canonical preload must expose bounded seller IPC");
  assert(renderer.includes("seller"), "canonical renderer must contain the seller evidence workbench");
  assert(fs.existsSync(legacyRootEntry), "legacy RPA entry must remain available as rollback evidence");

  const legacyEvidence = {
    path: path.relative(root, legacyRootEntry),
    sha256: sha256(legacyRootEntry)
  };
  const modularFiles = sourceRoots.flatMap(filesUnder).filter((file) => !file.endsWith(".map"));

  console.log(JSON.stringify({
    ok: true,
    canonicalRoot: path.relative(root, modularRoot),
    canonicalFilesScanned: modularFiles.length,
    sellerFilesScanned: sellerFiles.length,
    legacyRootEntry: { ...legacyEvidence, role: "compatibility-evidence-only" }
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`seller RPA source contract: FAIL\n${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
}
