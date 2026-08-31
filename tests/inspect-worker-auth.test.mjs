import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { authHeadersFromWranglerJson, authHeadersFromWranglerOutput } from "../tools/inspect-worker.mjs";

const inspectSource = readFileSync(new URL("../tools/inspect-worker.mjs", import.meta.url), "utf8");
const syntheticOauth = ["synthetic", "oauth", "credential"].join("-");
const syntheticApiToken = ["synthetic", "api", "token", "credential"].join("-");
const syntheticApiKey = ["synthetic", "api", "key", "credential"].join("-");
const syntheticEmail = ["synthetic", "example.invalid"].join("@");
const syntheticSecret = ["synthetic", "secret", "value"].join("-");

test("Wrangler OAuth JSON becomes a Bearer header", () => {
  assert.deepEqual(
    authHeadersFromWranglerOutput(JSON.stringify({ type: "oauth", token: syntheticOauth })),
    { Authorization: ["Bearer", syntheticOauth].join(" ") },
  );
});

test("Wrangler API token JSON becomes a Bearer header", () => {
  assert.deepEqual(
    authHeadersFromWranglerJson({ type: "api_token", token: syntheticApiToken }),
    { Authorization: ["Bearer", syntheticApiToken].join(" ") },
  );
});

test("Wrangler API key JSON becomes X-Auth headers", () => {
  assert.deepEqual(
    authHeadersFromWranglerJson({ type: "api_key", email: syntheticEmail, key: syntheticApiKey }),
    { "X-Auth-Email": syntheticEmail, "X-Auth-Key": syntheticApiKey },
  );
});

test("malformed or missing Wrangler credentials fail closed without credential output", () => {
  const malformed = authHeadersFromWranglerOutput(["not-json", syntheticSecret].join(" "), 0);
  const missing = authHeadersFromWranglerJson({ type: "oauth" });
  const failed = authHeadersFromWranglerOutput(JSON.stringify({ type: "oauth", token: syntheticSecret }), 1);

  assert.equal(malformed, null);
  assert.equal(missing, null);
  assert.equal(failed, null);
  assert.match("Cloudflare read-only authentication is unavailable", /authentication is unavailable/);
  assert.doesNotMatch("Cloudflare read-only authentication is unavailable", new RegExp(syntheticSecret));
  assert.match(inspectSource, /"node_modules"/);
  assert.match(inspectSource, /wrangler(?:\\.cmd)?/);
  assert.match(inspectSource, /\["auth", "token", "--json"\]/);
  assert.doesNotMatch(inspectSource, /oauth_token\s*=/);
  assert.doesNotMatch(inspectSource, /console\.(log|error).*?(token|key|email)/i);
});
