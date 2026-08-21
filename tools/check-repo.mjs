import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const failures = [];
const warnings = [];

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
if (!/^\s*main\s*=\s*["']worker\/ewgf-worker-with-stat-pentagon\.js["']\s*$/m.test(wranglerText)) {
  fail("wrangler.toml main must point to the canonical Worker");
}
if (!/^\s*name\s*=/m.test(wranglerText)) warnings.push("Worker name is unresolved");
if (!/^\s*compatibility_date\s*=/m.test(wranglerText)) warnings.push("Worker compatibility_date is unresolved");
if (!/^\s*crons?\s*=|^\s*\[triggers\]/m.test(wranglerText)) warnings.push("Worker scheduled trigger is unresolved");

for (const filePath of files.filter((candidate) => extname(candidate).toLowerCase() === ".js")) {
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
console.log(`JAVASCRIPT_FILES_CHECKED: ${files.filter((filePath) => extname(filePath).toLowerCase() === ".js").length}`);
console.log("JSON_FILES_CHECKED: 5");
for (const warning of warnings) console.log(`WARNING: ${warning}`);
