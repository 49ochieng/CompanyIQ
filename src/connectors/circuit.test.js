const { test } = require("node:test");
const assert = require("node:assert");
const { CircuitBreaker, unavailableResult } = require("./circuit");

function makeClock(start = 0) {
    let t = start;
    return { now: () => t, advance: (ms) => (t += ms) };
}

test("opens after 3 consecutive failures and reports open status", async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker("test", { now: clock.now, timeoutMs: 1000 });

    for (let i = 0; i < 3; i++) {
        await assert.rejects(() => breaker.exec("t", async () => { throw new Error("boom"); }));
    }
    assert.strictEqual(breaker.isOpen(), true);
    assert.strictEqual(breaker.status().state, "open");
    assert.ok(breaker.status().retryInMs > 0);
});

test("stays closed below the threshold and resets on success", async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker("test", { now: clock.now });

    await assert.rejects(() => breaker.exec("t", async () => { throw new Error("boom"); }));
    await assert.rejects(() => breaker.exec("t", async () => { throw new Error("boom"); }));
    assert.strictEqual(breaker.isOpen(), false);

    const result = await breaker.exec("t", async () => "ok");
    assert.strictEqual(result, "ok");
    assert.strictEqual(breaker.consecutiveFailures, 0);
});

test("closes again after the cooldown elapses (half-open trial)", async () => {
    const clock = makeClock();
    const breaker = new CircuitBreaker("test", { now: clock.now, cooldownMs: 300000 });

    for (let i = 0; i < 3; i++) {
        await assert.rejects(() => breaker.exec("t", async () => { throw new Error("boom"); }));
    }
    assert.strictEqual(breaker.isOpen(), true);

    clock.advance(300001);
    assert.strictEqual(breaker.isOpen(), false);

    // A failing trial re-opens immediately
    await assert.rejects(() => breaker.exec("t", async () => { throw new Error("still down"); }));
    assert.strictEqual(breaker.isOpen(), true);

    // A successful trial fully closes
    clock.advance(300001);
    await breaker.exec("t", async () => "recovered");
    assert.strictEqual(breaker.isOpen(), false);
    assert.strictEqual(breaker.consecutiveFailures, 0);
});

test("unavailableResult tells the model not to retry", () => {
    const result = unavailableResult("foundry:test", 240000);
    assert.strictEqual(result.error, "connector_unavailable");
    assert.match(result.message, /temporarily unavailable/);
    assert.match(result.message, /do not retry/i);
});
