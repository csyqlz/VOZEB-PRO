import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import { resolveGenerationWorkerOrigin } from "./generation-runtime.mjs";
import { nextGenerationWorkerPollPolicy } from "./generation-worker-policy.mjs";

const token = process.env.VOZEB_PRO_WORKER_TOKEN?.trim() || "";
const origin = resolveGenerationWorkerOrigin();
const workerId = (process.env.VOZEB_PRO_GENERATION_WORKER_ID?.trim() || `generation-worker:${hostname()}:${process.pid}:${randomUUID()}`).slice(0, 150);
const idleDelayMs = boundedNumber(process.env.VOZEB_PRO_GENERATION_WORKER_INTERVAL_MS, 2_000, 500, 30_000);
const lanes = boundedNumber(process.env.VOZEB_PRO_GENERATION_WORKER_LANES, 2, 1, 8);
const heartbeatIntervalMs = boundedNumber(process.env.VOZEB_PRO_GENERATION_WORKER_HEARTBEAT_MS, 15_000, 5_000, 60_000);
let stopping = false;
let heartbeatPending = false;

if (token.length < 32) throw new Error("VOZEB_PRO_WORKER_TOKEN must contain at least 32 characters");

process.once("SIGTERM", stop);
process.once("SIGINT", stop);

console.log(`Generation worker started: ${workerId}`);
void sendHeartbeat();
const heartbeatTimer = setInterval(() => void sendHeartbeat(), heartbeatIntervalMs);
await Promise.all([...Array.from({ length: lanes }, (_, index) => runLane(index + 1)), runRefundLane()]);
clearInterval(heartbeatTimer);
console.log("Generation worker stopped");

async function runLane(index) {
    const laneId = `${workerId}:lane-${index}`;
    let consecutiveErrors = 0;
    let idleBatches = 0;
    while (!stopping) {
        try {
            const response = await fetch(`${origin}/api/maintenance/generation-tasks/run`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    "x-vozeb-pro-worker-id": laneId,
                },
                signal: AbortSignal.timeout(40 * 60_000),
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok) throw new Error(payload?.msg || `Worker endpoint returned HTTP ${response.status}`);
            consecutiveErrors = 0;
            const claimed = Number(payload?.data?.claimed || 0);
            const policy = nextGenerationWorkerPollPolicy({ claimed, idleBatches, baseIdleDelayMs: idleDelayMs, nextDueAt: payload?.data?.nextDueAt, now: Date.now() });
            idleBatches = policy.idleBatches;
            await delay(policy.delayMs);
        } catch (error) {
            if (stopping) break;
            consecutiveErrors += 1;
            const retryMs = Math.min(60_000, 1_000 * 2 ** Math.min(consecutiveErrors - 1, 6));
            console.error(`Generation worker lane ${index} batch failed`, error instanceof Error ? error.message : error, `retrying in ${retryMs}ms`);
            await delay(retryMs);
        }
    }
}

async function sendHeartbeat() {
    if (stopping || heartbeatPending) return;
    heartbeatPending = true;
    try {
        const response = await fetch(`${origin}/api/maintenance/generation-tasks/heartbeat`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-vozeb-pro-worker-id": workerId,
            },
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => null);
            throw new Error(payload?.msg || `Heartbeat endpoint returned HTTP ${response.status}`);
        }
    } catch (error) {
        if (!stopping) console.error("Generation worker heartbeat failed", error instanceof Error ? error.message : error);
    } finally {
        heartbeatPending = false;
    }
}

async function runRefundLane() {
    const refundWorkerId = `${workerId}:billing-refunds`;
    let consecutiveErrors = 0;
    while (!stopping) {
        try {
            const response = await fetch(`${origin}/api/maintenance/billing-refunds/run`, {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "x-vozeb-pro-worker-id": refundWorkerId },
                signal: AbortSignal.timeout(2 * 60_000),
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok) throw new Error(payload?.msg || `Refund worker endpoint returned HTTP ${response.status}`);
            consecutiveErrors = 0;
            await delay(Number(payload?.data?.claimed || 0) > 0 ? 1_000 : 10_000);
        } catch (error) {
            if (stopping) break;
            consecutiveErrors += 1;
            const retryMs = Math.min(60_000, 2_000 * 2 ** Math.min(consecutiveErrors - 1, 5));
            console.error("Billing refund worker failed", error instanceof Error ? error.message : error, `retrying in ${retryMs}ms`);
            await delay(retryMs);
        }
    }
}

function boundedNumber(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

function delay(ms) {
    if (stopping) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function stop() {
    stopping = true;
}
