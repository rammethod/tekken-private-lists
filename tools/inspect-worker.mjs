import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function configValue(config, key) {
  return config.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']\\s*$`, "m"))?.[1] || "";
}

function getAccountId(config) {
  return configValue(config, "account_id");
}

function wranglerBin(root = repoRoot) {
  return join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
}

export function authHeadersFromWranglerJson(credentials) {
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) return null;

  if ((credentials.type === "oauth" || credentials.type === "api_token") && typeof credentials.token === "string" && credentials.token) {
    return { Authorization: `Bearer ${credentials.token}` };
  }
  if (credentials.type === "api_key" && typeof credentials.email === "string" && credentials.email && typeof credentials.key === "string" && credentials.key) {
    return { "X-Auth-Email": credentials.email, "X-Auth-Key": credentials.key };
  }
  return null;
}

export function authHeadersFromWranglerOutput(stdout, status = 0) {
  if (status !== 0 || typeof stdout !== "string" || !stdout.trim()) return null;
  try {
    return authHeadersFromWranglerJson(JSON.parse(stdout));
  } catch {
    return null;
  }
}

function getAuthHeaders(root = repoRoot) {
  const result = spawnSync(wranglerBin(root), ["auth", "token", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    windowsHide: true,
  });
  return authHeadersFromWranglerOutput(result.stdout, result.status);
}

async function cloudflareGet(authHeaders, path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { ...authHeaders, Accept: "application/json" },
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Cloudflare read failed: status ${response.status}`);
  }
  if (!response.ok || body.success !== true) throw new Error(`Cloudflare read failed: status ${response.status}`);
  return body.result;
}

export async function readProductionWorkerState(root = repoRoot) {
  const config = readFileSync(join(root, "wrangler.toml"), "utf8");
  const accountId = getAccountId(config);
  const workerName = configValue(config, "name");
  const authHeaders = getAuthHeaders(root);
  if (!accountId || !workerName) throw new Error("wrangler.toml production target is incomplete");
  if (!authHeaders) throw new Error("Cloudflare read-only authentication is unavailable");

  const base = `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`;
  const [settings, subdomain, schedules, domains, zones] = await Promise.all([
    cloudflareGet(authHeaders, `${base}/settings`),
    cloudflareGet(authHeaders, `${base}/subdomain`),
    cloudflareGet(authHeaders, `${base}/schedules`),
    cloudflareGet(authHeaders, `/accounts/${encodeURIComponent(accountId)}/workers/domains`),
    cloudflareGet(authHeaders, `/zones?account.id=${encodeURIComponent(accountId)}&per_page=50`),
  ]);

  const routes = [];
  for (const zone of Array.isArray(zones) ? zones : []) {
    const zoneRoutes = await cloudflareGet(authHeaders, `/zones/${encodeURIComponent(zone.id)}/workers/routes?per_page=100`);
    for (const route of Array.isArray(zoneRoutes) ? zoneRoutes : []) {
      if (route.script === workerName) routes.push({ pattern: route.pattern || "", script: route.script || "" });
    }
  }

  const bindings = Array.isArray(settings?.bindings) ? settings.bindings : [];
  const secretNames = bindings
    .filter((binding) => String(binding.type || "").startsWith("secret_"))
    .map((binding) => String(binding.name || ""))
    .filter(Boolean)
    .sort();
  const nonSecretVarNames = bindings
    .filter((binding) => binding.type === "plain_text")
    .map((binding) => String(binding.name || ""))
    .filter(Boolean)
    .sort();
  const customDomains = (Array.isArray(domains) ? domains : [])
    .filter((domain) => (domain.service || domain.script || domain.worker || "") === workerName)
    .map((domain) => String(domain.hostname || ""))
    .filter(Boolean)
    .sort();

  return {
    worker_name: workerName,
    account_id: accountId,
    compatibility_date: String(settings?.compatibility_date || ""),
    compatibility_flags: Array.isArray(settings?.compatibility_flags) ? [...settings.compatibility_flags].sort() : [],
    workers_dev_enabled: subdomain?.enabled === true,
    workers_dev_previews_enabled: subdomain?.previews_enabled === true,
    cron_triggers: (Array.isArray(schedules?.schedules) ? schedules.schedules : [])
      .map((schedule) => String(schedule.cron || ""))
      .filter(Boolean)
      .sort(),
    routes,
    custom_domains: customDomains,
    non_secret_var_names: nonSecretVarNames,
    secret_names: secretNames,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const state = await readProductionWorkerState();
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(state, null, 2));
    } else {
      console.log(`WORKER_NAME: ${state.worker_name}`);
      console.log(`ACCOUNT_ID: ${state.account_id}`);
      console.log(`COMPATIBILITY_DATE: ${state.compatibility_date}`);
      console.log(`COMPATIBILITY_FLAGS: ${state.compatibility_flags.join(",") || "NONE"}`);
      console.log(`WORKERS_DEV_ENABLED: ${state.workers_dev_enabled}`);
      console.log(`WORKERS_DEV_PREVIEWS_ENABLED: ${state.workers_dev_previews_enabled}`);
      console.log(`CRON_TRIGGERS: ${state.cron_triggers.join(",") || "NONE"}`);
      console.log(`ROUTES: ${state.routes.length}`);
      console.log(`CUSTOM_DOMAINS: ${state.custom_domains.length}`);
      console.log(`NON_SECRET_VAR_NAMES: ${state.non_secret_var_names.join(",") || "NONE"}`);
      console.log(`SECRET_NAMES: ${state.secret_names.join(",") || "NONE"}`);
    }
  } catch (error) {
    console.error(`WORKER_READONLY_INSPECTION: REFUSED (${error instanceof Error ? error.message : "unknown error"})`);
    process.exitCode = 1;
  }
}
