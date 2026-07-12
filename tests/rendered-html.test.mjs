import assert from "node:assert/strict";
import test from "node:test";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const env = {
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  },
};

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
};

test("server-renders the finished Bavi observatory", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    env,
    ctx,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>BAVI 2609 — Live Typhoon Observatory<\/title>/i);
  assert.match(html, /BAVI/);
  assert.match(html, /BEIJING IMPACT/);
  assert.match(html, /CMA \/ NMC/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("serves normalized typhoon history, forecast, and Beijing distance", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/typhoon/bavi"),
    env,
    ctx,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /max-age=300/);

  const payload = await response.json();
  assert.equal(payload.storm.id, "2609");
  assert.equal(payload.storm.name, "Bavi");
  assert.ok(payload.observed.length >= 60);
  assert.equal(payload.forecast.length, 6);
  assert.ok(payload.beijing.currentDistanceKm > 2_000);
  assert.ok(payload.beijing.minDistanceKm > 700);
  assert.ok(payload.beijing.minDistanceKm < 900);
});
