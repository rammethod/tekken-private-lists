import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readProductionWorkerState } from "./inspect-worker.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = join(repoRoot, "wrangler.toml");
const canonicalWorker = join(repoRoot, "worker", "ewgf-worker-with-stat-pentagon.js");
const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
const wranglerBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
const failures = [];

if (!existsSync(canonicalWorker)) failures.push("canonical Worker is missing");
if (!existsSync(configPath)) failures.push("wrangler.toml is missing");
const requiredConfig = [
  [/^\s*name\s*=\s*["']tight-bar-55c1["']\s*$/m, "confirmed Worker name is missing"],
  [/^\s*account_id\s*=\s*["']d81e9284c64cedb0660c9c7d2a3610a0["']\s*$/m, "confirmed account_id is missing"],
  [/^\s*main\s*=\s*["']worker\/ewgf-worker-with-stat-pentagon\.js["']\s*$/m, "canonical Worker main path is missing"],
  [/^\s*compatibility_date\s*=\s*["']2026-07-23["']\s*$/m, "confirmed compatibility_date is missing"],
  [/^\s*compatibility_flags\s*=\s*\[\]\s*$/m, "confirmed compatibility_flags are missing"],
  [/^\s*workers_dev\s*=\s*true\s*$/m, "confirmed workers_dev setting is missing"],
  [/^\s*preview_urls\s*=\s*false\s*$/m, "confirmed preview_urls setting is missing"],
  [/^\s*keep_vars\s*=\s*true\s*$/m, "keep_vars must be enabled for dashboard variable preservation"],
  [/^\s*crons\s*=\s*\["\*\/5 \* \* \* \*"\]\s*$/m, "confirmed cron trigger is missing"],
  [/^\s*required\s*=\s*\["EWGF_PUBLIC_API_KEY",\s*"FIREBASE_SERVICE_ACCOUNT_JSON"\]\s*$/m, "both required secret names are missing"],
];
for (const [pattern, message] of requiredConfig) if (!pattern.test(config)) failures.push(message);

if (failures.length > 0) {
  console.error("WORKER_DEPLOY: REFUSED");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("No production command was executed.");
  process.exit(1);
}

execFileSync(process.execPath, [join(repoRoot, "tools", "check-repo.mjs")], { stdio: "inherit" });

let remoteState;
try {
  remoteState = await readProductionWorkerState(repoRoot);
} catch (error) {
  console.error("WORKER_DEPLOY: REFUSED");
  console.error(error instanceof Error ? error.message : "Cloudflare read-only inspection failed");
  console.error("No production command was executed.");
  process.exit(1);
}

const remoteFailures = [];
if (remoteState.worker_name !== "tight-bar-55c1") remoteFailures.push("remote Worker name differs from canonical config");
if (remoteState.account_id !== "d81e9284c64cedb0660c9c7d2a3610a0") remoteFailures.push("remote account differs from canonical config");
if (remoteState.compatibility_date !== "2026-07-23") remoteFailures.push("remote compatibility date differs from canonical config");
if (remoteState.compatibility_flags.length !== 0) remoteFailures.push("remote compatibility flags are not empty");
if (!remoteState.workers_dev_enabled) remoteFailures.push("remote workers.dev is not enabled");
if (remoteState.workers_dev_previews_enabled !== false) remoteFailures.push("remote Preview URLs are enabled but canonical config requires them disabled");
if (remoteState.routes.length !== 0) remoteFailures.push("remote routes exist but are not represented in canonical config");
if (remoteState.custom_domains.length !== 0) remoteFailures.push("remote custom domains exist but are not represented in canonical config");
if (remoteState.cron_triggers.length !== 1 || remoteState.cron_triggers[0] !== "*/5 * * * *") remoteFailures.push("remote cron triggers differ from canonical config");
for (const requiredSecret of ["EWGF_PUBLIC_API_KEY", "FIREBASE_SERVICE_ACCOUNT_JSON"]) {
  if (!remoteState.secret_names.includes(requiredSecret)) remoteFailures.push(`remote required secret binding is missing: ${requiredSecret}`);
}
if (remoteFailures.length > 0) {
  console.error("WORKER_DEPLOY: REFUSED");
  for (const failure of remoteFailures) console.error(`- ${failure}`);
  console.error("No production command was executed.");
  process.exit(1);
}

if (process.env.KENTOMO_WORKER_REMOTE_CONFIRMED !== "1") {
  console.error("WORKER_DEPLOY: REFUSED");
  console.error("Set KENTOMO_WORKER_REMOTE_CONFIRMED=1 only after a fresh read-only production settings check.");
  process.exit(1);
}

if (process.env.KENTOMO_ALLOW_WORKER_DEPLOY !== "1") {
  console.error("WORKER_DEPLOY: REFUSED");
  console.error("Set KENTOMO_ALLOW_WORKER_DEPLOY=1 only after Lead Engineer review.");
  process.exit(1);
}

if (!existsSync(wranglerBin)) {
  console.error("WORKER_DEPLOY: REFUSED");
  console.error("Pinned local wrangler CLI is not installed.");
  process.exit(1);
}

const wranglerCheck = spawnSync(wranglerBin, ["--version"], {
  stdio: "ignore",
  shell: process.platform === "win32",
  windowsHide: true,
});
if (wranglerCheck.status !== 0) {
  console.error("WORKER_DEPLOY: REFUSED");
  console.error("wrangler CLI is not available.");
  process.exit(1);
}

console.error("Worker deploy requires pre-existing Cloudflare bindings for EWGF_PUBLIC_API_KEY and FIREBASE_SERVICE_ACCOUNT_JSON.");
execFileSync(wranglerBin, ["deploy", "--config", configPath, "--strict", "--keep-vars"], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
  windowsHide: true,
});
