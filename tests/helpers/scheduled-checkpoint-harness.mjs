import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import * as persistence from "../../worker/stats-persistence.mjs";

export const BASE = "ba880ad91095b57a9ae88e4b347b4965cb7fc82e";
export const root = new URL("../../", import.meta.url);
export const baseline = execFileSync("git", ["show", `${BASE}:worker/ewgf-worker-with-stat-pentagon.js`], { cwd: root, encoding: "utf8" });
export const candidate = readFileSync(new URL("worker/ewgf-worker-with-stat-pentagon.js", root), "utf8").replaceAll("\r\n", "\n");
export const prefix = "KENTOMO_SCHEDULED_CHECKPOINT ";
const plain = value => JSON.parse(JSON.stringify(value));

export async function run(source, spec = {}) {
  const epoch = spec.epoch ?? Date.UTC(2026, 9, 29, 0);
  class FrozenDate extends Date {
    constructor(...args) { super(...(args.length ? args : [epoch])); }
    static now() { return epoch; }
  }
  const member = { gameId: "SYNTHETIC_001", privateFixture: "SENSITIVE_FIXTURE_MEMBER" };
  const db = {
    users: { owner: { lists: { list: { shareId: "SYNTHETIC_SHARE_1234", awardEnabled: true, members: { member } } } } },
    backgroundSyncState: { SYNTHETIC_001: { schema: "20260822-dormant-all-time-highest-rank", lastSyncedAt: spec.due ? 0 : epoch, nextRetryAt: 0 } },
    awardSchedules: { owner: { list: { enabled: !spec.disabled, ...(spec.reset ? { resetRequestedAt: 1 } : {}) } } },
    awardRuns: { owner: { list: {} } },
  };
  if (spec.sharedCollision) db.users.other = { lists: { second: { shareId: "SYNTHETIC_SHARE_1234", members: { member: { ...member } } } } };
  if (spec.newerCanonical) db.workerStatsByGameId = { SYNTHETIC_001: { schema: persistence.STATS_SCHEMA, sourceSnapshots: { ewgfProfile: persistence.buildEwgfProfileSourceSnapshot({ playerName: "KEEP_NEWER_FIXTURE", tekkenProwess: 999, statPentagon: { attack: 90 }, rankedCharacterStats: { Kazuya: { games: 99, wins: 50, losses: 49 } }, latestBattleAt: "2026-10-01T00:00:00Z", ewgfProfileRevisionAt: "2026-10-01T00:00:00Z" }, "2026-10-01T00:00:00Z") } } };
  const periodDate = new Date(epoch + 9 * 3600000);
  const period = `${periodDate.getUTCFullYear()}-${String(periodDate.getUTCMonth() + 1).padStart(2, "0")}`;
  if (!spec.emptyAward) db.awardRuns.owner.list[period] = { status: "started", start: { member: { totalRankedGames: 1 } } };
  const trace = [], diagnostic = [], attempts = [], legacy = [], counts = {}, snapshots = [];
  let tokenCalls = 0, profileCalls = 0, error = null;
  function get(path) { return path.split("/").reduce((v, k) => v?.[k], db) ?? null; }
  function put(path, value, patch) {
    const keys = path.split("/"); const leaf = keys.pop(); let node = db;
    for (const key of keys) node = node[key] ??= {};
    if (value === null) delete node[leaf];
    else node[leaf] = patch ? { ...(node[leaf] ?? {}), ...plain(value) } : plain(value);
  }
  const context = vm.createContext({ ...persistence, Date: FrozenDate, Intl, URL, URLSearchParams, TextEncoder, Uint8Array, ArrayBuffer, btoa, atob, Response, Request, Headers,
    console: {
      log(value) { attempts.push(value); if (spec.sinkThrows || (spec.dropEvery && attempts.length % spec.dropEvery === 0)) { if (spec.sinkThrows) throw Error("SENSITIVE_FIXTURE_LOG_SINK"); return; } diagnostic.push(value); },
      error(...a) { legacy.push(a.map(String)); }, warn(...a) { legacy.push(a.map(String)); },
    },
    async fetch(url, options = {}) {
      const u = new URL(url); if (u.hostname !== "fixture.invalid") throw Error("LIVE_NETWORK_FORBIDDEN");
      const path = decodeURIComponent(u.pathname.slice(1).replace(/\.json$/, ""));
      const method = options.method ?? "GET", body = options.body === undefined ? null : JSON.parse(options.body);
      const key = `${method} ${path}`; counts[key] = (counts[key] ?? 0) + 1;
      trace.push({ path, method, body, headers: { ...options.headers } });
      if (spec.fail === `${key}#${counts[key]}` || (spec.fail === "status-all" && path === "automationStatus")) return new Response("SENSITIVE_FIXTURE_FIREBASE", { status: 503 });
      if (method === "GET") {
        if (path === "users" && counts[key] === 2 && spec.freshDelete) delete db.users.owner.lists.list.members.member;
        return new Response(JSON.stringify(get(path)), { status: 200, headers: { ETag: '"fixture-etag"' } });
      }
      if (method === "PUT" && path.startsWith("workerStatsByGameId/") && spec.casConflict) return new Response("null", { status: 412 });
      put(path, method === "DELETE" ? null : body, method === "PATCH");
      return new Response(JSON.stringify(method === "DELETE" ? null : body));
    },
  });
  const withoutImport = source.slice(source.indexOf("const WORKER_CACHE_TTL_SECONDS")).replace("export default {", "globalThis.worker = {");
  vm.runInContext(withoutImport + ";globalThis.run=runScheduledAutomation;", context);
  context.mockToken = async () => { tokenCalls++; if (spec.oauthFailure) throw Error("SENSITIVE_FIXTURE_AUTH"); return "SENSITIVE_FIXTURE_TOKEN"; };
  context.mockProfile = async () => {
    profileCalls++; snapshots.push("fetchAwardSnapshot"); if (spec.sourceFailure) throw Error("SENSITIVE_FIXTURE_SOURCE");
    return { gameId: "SYNTHETIC_001", capturedAt: new Date(epoch).toISOString(), ewgfProfileRevisionAt: "2026-08-20T10:00:00Z", latestBattleAt: "2026-08-20T10:00:00Z", rankedCharacterStats: { Kazuya: { games: 12, wins: 7, losses: 5 } }, totalRankedGames: 12, characterRanks: { Kazuya: { rank: "Fujin" } }, statPentagon: { attack: 80 }, playerName: "SENSITIVE_FIXTURE_PLAYER" };
  };
  vm.runInContext("getFirebaseAccessToken=mockToken;fetchAwardSnapshot=mockProfile;", context);
  const env = { FIREBASE_SERVICE_ACCOUNT_JSON: "SENSITIVE_FIXTURE_SECRET", FIREBASE_DATABASE_URL: "https://fixture.invalid" };
  try {
    if (spec.http) await context.worker.fetch(new Request("https://fixture.invalid/", { method: "OPTIONS" }), env, {});
    else for (let i = 0; i < (spec.repeat ?? 1); i++) {
      let task; let waitCalls = 0;
      await context.worker.scheduled({}, env, { waitUntil(value) { waitCalls++; task = value; } });
      if (waitCalls !== 1) throw Error("waitUntil contract mismatch");
      await task;
    }
  } catch (e) { error = { name: e.name, message: e.message }; }
  return { trace: plain(trace), db: plain(db), tokenCalls, profileCalls, snapshots, error, diagnostic, attempts, legacy };
}
