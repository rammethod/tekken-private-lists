import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const failures = [];
const warnings = [];
const isJavaScript = (filePath) => [".js", ".mjs"].includes(extname(filePath).toLowerCase());

function rel(filePath) {
  return relative(repoRoot, filePath).replaceAll("\\", "/") || ".";
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".wrangler") continue;
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(filePath));
    else files.push(filePath);
  }
  return files;
}

function readText(filePath) {
  const bytes = readFileSync(filePath);
  if (bytes.includes(0)) return null;
  return bytes.toString("utf8");
}

function fail(message) {
  failures.push(message);
}

function parseJson(relativePath) {
  const filePath = join(repoRoot, relativePath);
  try {
    JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    fail(`invalid JSON: ${relativePath}`);
  }
}

const files = walk(repoRoot);
const textFiles = files
  .map((filePath) => ({ filePath, text: readText(filePath) }))
  .filter((entry) => entry.text !== null);

for (const { filePath, text } of textFiles) {
  const fileName = basename(filePath);
  if (/^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|.*\.local)$/i.test(fileName)) {
    fail(`local secret file present: ${rel(filePath)}`);
  }

  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=\r\n\s]{40,}-----END [A-Z ]*PRIVATE KEY-----/i.test(text)) {
    fail(`private key material detected in: ${rel(filePath)}`);
  }

  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i.test(text)) {
    fail(`literal bearer token detected in: ${rel(filePath)}`);
  }

  if (/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:api[_-]?key|token|secret|password|private[_-]?key)\s*=\s*["'`](?!\s*["'`])[^"'`]+["'`]/i.test(text)) {
    fail(`hard-coded credential assignment detected in: ${rel(filePath)}`);
  }

  if (/\bEWGF_PUBLIC_API_KEY\s*=\s*["'`](?!\s*["'`])[^"'`]+["'`]/.test(text)) {
    fail(`hard-coded EWGF credential assignment detected in: ${rel(filePath)}`);
  }
}

for (const jsonPath of [
  "package.json",
  "firebase/firebase.admin-candidate.json",
  "firebase/firebase.prototype-candidate.json",
  "firebase/candidates/firebase-user-lists-admin-rules.json",
  "firebase/candidates/firebase-user-lists-rules-prototype.json",
]) {
  parseJson(jsonPath);
}

const wranglerPath = join(repoRoot, "wrangler.toml");
const wranglerText = readFileSync(wranglerPath, "utf8");
const requiredWranglerLines = [
  [/^\s*name\s*=\s*["']tight-bar-55c1["']\s*$/m, "wrangler.toml Worker name is not the confirmed production Worker"],
  [/^\s*account_id\s*=\s*["']d81e9284c64cedb0660c9c7d2a3610a0["']\s*$/m, "wrangler.toml account_id is not the confirmed production account"],
  [/^\s*main\s*=\s*["']worker\/ewgf-worker-with-stat-pentagon\.js["']\s*$/m, "wrangler.toml main must point to the canonical Worker"],
  [/^\s*compatibility_date\s*=\s*["']2026-07-23["']\s*$/m, "wrangler.toml compatibility_date does not match read-only production settings"],
  [/^\s*compatibility_flags\s*=\s*\[\]\s*$/m, "wrangler.toml compatibility_flags must remain empty"],
  [/^\s*workers_dev\s*=\s*true\s*$/m, "wrangler.toml workers_dev must remain enabled"],
  [/^\s*keep_vars\s*=\s*true\s*$/m, "wrangler.toml keep_vars must protect dashboard vars during migration"],
  [/^\s*crons\s*=\s*\["\*\/5 \* \* \* \*"\]\s*$/m, "wrangler.toml must record the confirmed cron trigger"],
  [/^\s*required\s*=\s*\["EWGF_PUBLIC_API_KEY",\s*"FIREBASE_SERVICE_ACCOUNT_JSON"\]\s*$/m, "wrangler.toml must declare both required secret names"],
];
for (const [pattern, message] of requiredWranglerLines) if (!pattern.test(wranglerText)) fail(message);

for (const filePath of files.filter(isJavaScript)) {
  const result = spawnSync(process.execPath, ["--check", filePath], { encoding: "utf8" });
  if (result.status !== 0) fail(`JavaScript syntax check failed: ${rel(filePath)}`);
}

const diffCheck = spawnSync("git", ["diff", "--check"], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (diffCheck.status !== 0) fail("git diff --check failed");

if (failures.length > 0) {
  console.error("REPO_CHECK: FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("REPO_CHECK: PASS");
console.log(`FILES_SCANNED: ${files.length}`);
console.log(`JAVASCRIPT_FILES_CHECKED: ${files.filter(isJavaScript).length}`);
console.log("JSON_FILES_CHECKED: 5");
for (const warning of warnings) console.log(`WARNING: ${warning}`);
