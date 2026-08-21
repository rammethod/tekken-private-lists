import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const candidateIndex = args.indexOf("--candidate");
const projectIndex = args.indexOf("--project");
const candidate = candidateIndex >= 0 ? args[candidateIndex + 1] : "";
const project = projectIndex >= 0 ? args[projectIndex + 1] : process.env.KENTOMO_FIREBASE_PROJECT_ID || "";
const configName = candidate === "admin"
  ? "firebase.admin-candidate.json"
  : candidate === "prototype"
    ? "firebase.prototype-candidate.json"
    : "";
const configPath = configName ? join(repoRoot, "firebase", configName) : "";
const candidatePath = candidate === "admin"
  ? join(repoRoot, "firebase", "candidates", "firebase-user-lists-admin-rules.json")
  : candidate === "prototype"
    ? join(repoRoot, "firebase", "candidates", "firebase-user-lists-rules-prototype.json")
    : "";
const failures = [];

if (!configName) failures.push("choose an explicit --candidate admin or --candidate prototype");
if (!project) failures.push("Firebase project is unresolved; pass --project or KENTOMO_FIREBASE_PROJECT_ID");
if (configPath && !existsSync(configPath)) failures.push("selected Firebase config is missing");
if (candidatePath && !existsSync(candidatePath)) failures.push("selected Rules candidate is missing");

if (failures.length > 0) {
  console.error("RULES_DEPLOY: REFUSED");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("No production command was executed.");
  process.exit(1);
}

execFileSync(process.execPath, [join(repoRoot, "tools", "check-repo.mjs")], { stdio: "inherit" });

if (process.env.KENTOMO_ALLOW_RULES_DEPLOY !== "1") {
  console.error("RULES_DEPLOY: REFUSED");
  console.error("Set KENTOMO_ALLOW_RULES_DEPLOY=1 only after Lead Engineer review.");
  process.exit(1);
}

const firebaseCheck = spawnSync("firebase", ["--version"], { stdio: "ignore" });
if (firebaseCheck.status !== 0) {
  console.error("RULES_DEPLOY: REFUSED");
  console.error("Firebase CLI is not available.");
  process.exit(1);
}

console.error("Firebase Rules deploy uses only the explicitly selected candidate and project.");
execFileSync("firebase", ["deploy", "--only", "database", "--project", project, "--config", configPath], {
  cwd: repoRoot,
  stdio: "inherit",
});
