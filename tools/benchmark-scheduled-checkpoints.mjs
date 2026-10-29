// Offline only. No credentials, real URLs, outbound fetch, or production runtime.
import fs from "node:fs/promises";
import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { baseline, candidate } from "../tests/helpers/scheduled-checkpoint-harness.mjs";

function script(source, due) {
  const section = source.slice(source.indexOf("const FIREBASE_AWARD_SCOPE"), source.indexOf("\nexport default"));
  const instrumented = source.includes("function createScheduledCheckpoints()");
  return `
const NativeDate=Date; const epoch=1793232000000;
globalThis.Date=class extends NativeDate{constructor(...a){super(...(a.length?a:[epoch]));}static now(){return epoch;}};
let STATS_SCHEMA="fixture",buildBackgroundSourceSnapshots=()=>({fixture:{}});
let createFirebaseStatsTransport=()=>({}),dedupeStatsTargetPaths=x=>x;
let persistCanonicalStatsAndViews=async options=>({status:"noop",targets:options.targetPaths.map(()=>({status:"noop"}))});
${section}
getFirebaseAccessToken=async()=>"fixture-token";
fetchAwardSnapshot=async()=>({});
const users='{"owner":{"lists":{"list":{"shareId":"SYNTHETIC_SHARE_1234","members":{"member":{"gameId":"SYNTHETIC_001"}}}}}}';
firebaseRequest=async(_env,_token,path,options={})=>{
 if(options.method)return options.body??null;
 if(path==="users")return JSON.parse(users);
 if(path==="backgroundSyncState")return {SYNTHETIC_001:{schema:BACKGROUND_SYNC_SCHEMA,lastSyncedAt:${due ? 0 : "epoch"},nextRetryAt:0}};
 if(path==="awardSchedules")return {owner:{list:{enabled:true}}};
 return {};
};
export default {async fetch(request){const n=Number(new URL(request.url).searchParams.get("n")??1);for(let i=0;i<n;i++)await runScheduledAutomation({FIREBASE_SERVICE_ACCOUNT_JSON:"fixture"}${instrumented ? ",createScheduledCheckpoints()" : ""});return new Response("ok");}};
`;
}
const stats = values => { const v = [...values].sort((a, b) => a - b); return { n: v.length, median: v[Math.floor(v.length / 2)], p90: v[Math.min(v.length - 1, Math.ceil(v.length * .9) - 1)], max: v.at(-1) }; };
const output = { runtime: { node: process.version, miniflare: "5.20260820.0-alpha", compatibilityDate: "2026-07-23" }, units: "host monotonic wall ms via local workerd requests; not provider CPU; cold includes compilation/IPC", methodology: "Exact scheduled orchestration/checkpoint/helper code; synthetic auth/Firebase/profile/CAS no-ops, no outbound network. Real console API, Miniflare host log level NONE. 8 cold isolates per variant/path; warm alternating batches of 250 ticks. Synthetic small payload, not full app performance.", paths: {} };
for (const due of [false, true]) {
  const workers = [];
  for (let i = 0; i < 8; i++) for (const [name, source] of [["baseline", baseline], ["instrumented", candidate]]) workers.push({ name: `${name}${i}`, modules: true, compatibilityDate: "2026-07-23", script: script(source, due), outboundService: () => new Response("OFFLINE_NETWORK_BLOCKED", { status: 503 }) });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers, log: new Log(LogLevel.NONE) }));
  const cold = { baseline: [], instrumented: [] }, warm = { baseline: [], instrumented: [] };
  try {
    await mf.ready;
    for (let i = 0; i < 8; i++) for (const name of (i % 2 ? ["instrumented", "baseline"] : ["baseline", "instrumented"])) {
      const worker = await mf.getWorker(`${name}${i}`); const start = performance.now();
      const response = await worker.fetch("http://fixture.invalid/?n=1"); if (await response.text() !== "ok") throw Error("Cold fixture failed");
      cold[name].push(performance.now() - start);
    }
    for (let i = 0; i < 10; i++) for (const name of (i % 2 ? ["instrumented", "baseline"] : ["baseline", "instrumented"])) {
      const worker = await mf.getWorker(`${name}0`); const start = performance.now();
      const response = await worker.fetch("http://fixture.invalid/?n=250"); if (await response.text() !== "ok") throw Error("Warm fixture failed");
      warm[name].push((performance.now() - start) / 250);
    }
    output.paths[due ? "due" : "idle"] = { cold_wall_ms: Object.fromEntries(Object.entries(cold).map(([k, v]) => [k, stats(v)])), warm_wall_ms_per_tick: Object.fromEntries(Object.entries(warm).map(([k, v]) => [k, stats(v)])) };
  } finally { await mf.dispose(); }
}
// Isolate just the checkpoint emitter for Node process CPU and transient heap.
const helper = candidate.slice(candidate.indexOf("const SCHEDULED_CHECKPOINT_STAGES"), candidate.indexOf("\nfunction base64Url"));
const context = vm.createContext({ console: { log() {} } });
vm.runInContext(helper + ";globalThis.create=createScheduledCheckpoints", context);
global.gc?.(); const heap = process.memoryUsage().heapUsed, cpu = process.cpuUsage(), t = performance.now();
for (let i = 0; i < 200000; i++) { const cp = context.create(); for (let n = 0; n < 11; n++) cp.emit("status", "done"); }
const c = process.cpuUsage(cpu);
output.node_emitter = { invocations: 200000, events_per_invocation: 12, cpu_ms_per_invocation: (c.user + c.system) / 1000 / 200000, wall_ms_per_invocation: (performance.now() - t) / 200000, heap_used_delta_bytes: process.memoryUsage().heapUsed - heap, heap_limit: "Node process net heap after batch, not peak/per-invocation or workerd heap; GC-dependent. No checkpoint event retained by closure. At most 12 strings <100 UTF-8 bytes each are sent to console; platform log buffering is outside this bound." };
global.gc?.(); output.node_emitter.retained_heap_after_gc_delta_bytes = process.memoryUsage().heapUsed - heap;
output.node_cold = {};
for (const [name, source] of [["baseline", baseline], ["instrumented", candidate]]) {
  global.gc?.(); const start = performance.now(), beforeCpu = process.cpuUsage();
  for (let i = 0; i < 200; i++) {
    const section = source.slice(source.indexOf("const FIREBASE_AWARD_SCOPE"), source.indexOf("\nexport default"));
    const coldContext = vm.createContext({ console: { log() {} } });
    new vm.Script(section + (name === "instrumented" ? ';createScheduledCheckpoints();' : '')).runInContext(coldContext);
  }
  const delta = process.cpuUsage(beforeCpu);
  output.node_cold[name] = { iterations: 200, cpu_ms_per_context: (delta.user + delta.system) / 1000 / 200, wall_ms_per_context: (performance.now() - start) / 200, limitation: "Node fresh VM context and declarations/helper creation only; not full cold Scheduled handler or workerd CPU" };
}
output.ready_overhead_gate = Object.values(output.paths).every(p => p.warm_wall_ms_per_tick.instrumented.median - p.warm_wall_ms_per_tick.baseline.median < .5) && output.node_emitter.cpu_ms_per_invocation < .5;
await fs.mkdir(new URL("../docs/diagnostics/", import.meta.url), { recursive: true });
await fs.writeFile(new URL("../docs/diagnostics/scheduled-checkpoint-overhead.json", import.meta.url), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output));
if (!output.ready_overhead_gate) process.exitCode = 1;
