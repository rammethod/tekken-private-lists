import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = join(repoRoot, "wrangler.toml");
const canonicalWorker = join(repoRoot, "worker", "ewgf-worker-with-stat-pentagon.js");
const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
const failures = [];

if (!existsSync(canonicalWorker)) failures.push("canonical Worker is missing");
if (!existsSync(configPath)) failures.push("wrangler.toml is missing");
if (!/^\s*main\s*=\s*["']worker\/ewgf-worker-with-stat-pentagon\.js["']\s*$/m.test(config)) {
  failures.push("wrangler.toml main does not point to the canonical Worker");
}
if (!/^\s*name\s*=/m.test(config)) failures.push("Worker name is unresolved");
if (!/^\s*compatibility_date\s*=/m.test(config)) failures.push("Worker compatibility_date is unresolved");
if (!/^\s*crons?\s*=|^\s*\[triggers\]/m.test(config)) failures.push("Worker scheduled trigger is unresolved");

if (failures.length > 0) {
  console.error("WORKER_DEPLOY: REFUSED");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("No production command was executed.");
  process.exit(1);
}

execFileSync(process.execPath, [join(repoRoot, "tools", "check-repo.mjs")], { stdio: "inherit" });

if (process.env.KENTOMO_ALLOW_WORKER_DEPLOY !== "1") {
  console.error("WORKER_DEPLOY: REFUSED");
  console.error("Set KENTOMO_ALLOW_WORKER_DEPLOY=1 only after Lead Engineer review.");
  process.exit(1);
}

const wranglerCheck = spawnSync("wrangler", ["--version"], { stdio: "ignore" });
if (wranglerCheck.status !== 0) {
  console.error("WORKER_DEPLOY: REFUSED");
  console.error("wrangler CLI is not available.");
  process.exit(1);
}

console.error("Worker deploy requires pre-existing Cloudflare bindings for EWGF_PUBLIC_API_KEY and FIREBASE_SERVICE_ACCOUNT_JSON.");
execFileSync("wrangler", ["deploy", "--config", configPath], { cwd: repoRoot, stdio: "inherit" });
