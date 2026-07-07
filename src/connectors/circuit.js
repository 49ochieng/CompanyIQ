// Shared per-connector circuit breaker + timeout. After `failureThreshold`
// consecutive failures the connector is skipped for `cooldownMs` (the model is
// told it's unavailable); a success resets the count. Every delegation is
// audit-logged (connector, tool, latency, success) — never payloads.

const DEFAULTS = {
    failureThreshold: 3,
    cooldownMs: 5 * 60 * 1000,
    timeoutMs: 30 * 1000,
};

class CircuitBreaker {
    constructor(name, options = {}) {
        this.name = name;
        this.failureThreshold = options.failureThreshold ?? DEFAULTS.failureThreshold;
        this.cooldownMs = options.cooldownMs ?? DEFAULTS.cooldownMs;
        this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
        this.now = options.now ?? Date.now; // injectable for tests
        this.consecutiveFailures = 0;
        this.lastFailureAt = 0;
    }

    isOpen() {
        return (
            this.consecutiveFailures >= this.failureThreshold &&
            this.now() - this.lastFailureAt < this.cooldownMs
        );
    }

    status() {
        const open = this.isOpen();
        return {
            name: this.name,
            state: open ? "open" : "closed",
            consecutiveFailures: this.consecutiveFailures,
            retryInMs: open ? this.cooldownMs - (this.now() - this.lastFailureAt) : 0,
        };
    }

    /**
     * Run one delegation through the breaker with the connector timeout.
     * @param {string} toolLabel For the audit log only.
     * @param {(signal: AbortSignal) => Promise<any>} fn
     */
    async exec(toolLabel, fn) {
        const startedAt = this.now();
        try {
            const result = await fn(AbortSignal.timeout(this.timeoutMs));
            this.consecutiveFailures = 0;
            this.log(toolLabel, true, this.now() - startedAt);
            return result;
        } catch (error) {
            this.consecutiveFailures++;
            this.lastFailureAt = this.now();
            this.log(toolLabel, false, this.now() - startedAt, error);
            throw error;
        }
    }

    log(toolLabel, ok, latencyMs, error) {
        console.log(
            JSON.stringify({
                event: "delegation",
                connector: this.name,
                tool: toolLabel,
                ok,
                latencyMs,
                error: error ? String(error.message || error).slice(0, 200) : undefined,
                circuitState: this.isOpen() ? "open" : "closed",
            })
        );
    }
}

const circuits = new Map();

function getCircuit(name, options) {
    if (!circuits.has(name)) {
        circuits.set(name, new CircuitBreaker(name, options));
    }
    return circuits.get(name);
}

function allCircuitStatuses() {
    return [...circuits.values()].map((c) => c.status());
}

// The structured result a connector tool returns while its circuit is open;
// the model relays unavailability instead of retrying.
function unavailableResult(connectorName, retryInMs) {
    return {
        error: "connector_unavailable",
        message:
            `The '${connectorName}' connector is temporarily unavailable ` +
            `(too many recent failures; retry in about ${Math.ceil(retryInMs / 60000)} minute(s)). ` +
            "Tell the user this capability is temporarily down; do not retry now.",
    };
}

module.exports = { CircuitBreaker, getCircuit, allCircuitStatuses, unavailableResult, DEFAULTS };
