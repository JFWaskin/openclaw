// Regression: the deferred-queue-to-job.state mirroring in applyJobResult
// is supposed to set deferredMaintenanceCount when a deferred job eventually
// runs. The phase-exit drain in reconcileMaintenancePhaseTransition clears
// the queue, so applyJobResult's `listMaintenanceDeferrals().find(...)` lookup
// never matches the job that was deferred. The count would stay at 0.
//
// This test exercises the full lifecycle:
//   1. Maintenance active; isRunnableJob records a deferral for job A.
//   2. Phase exits; reconcileMaintenancePhaseTransition drains the queue.
//   3. Next tick; isRunnableJob admits job A (we are now in normal phase).
//   4. applyJobResult runs; the mirroring should set
//      job.state.deferredMaintenanceCount to at least 1.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetMaintenanceDeferrals } from "./maintenance-deferred.js";
import { reconcileMaintenancePhaseTransition } from "./maintenance-policy.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { ensureLoaded } from "./service/store.js";
import { applyJobResult } from "./service/timer-outcomes.js";
import { isRunnableJob } from "./service/timer-runnable.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-mirror-",
});

const AT_UTC_03_30 = Date.UTC(2026, 0, 15, 3, 30, 0); // inside [02:00, 04:00)
const AT_UTC_05_00 = Date.UTC(2026, 0, 15, 5, 0, 0); // after window

function makeJob(id: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "hi", toolsAllow: ["write"] },
    agentId: "main",
    state: {
      lastRunAtMs: 0,
      lastStatus: "ok",
      lastDurationMs: 0,
      consecutiveErrors: 0,
      nextRunAtMs: AT_UTC_03_30 - 60 * 60_000, // due by AT_UTC_03_30
    },
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

async function makeState(job: CronJob) {
  const { storePath } = await makeStorePath();
  await writeCronStoreSnapshot({ storePath, jobs: [job] });
  const state = createCronServiceState({
    storePath,
    cronEnabled: true,
    log: logger,
    defaultAgentId: "main",
    userTimezone: "UTC",
    cronConfig: {
      maintenance: {
        enabled: true,
        window: { start: "02:00", end: "04:00", timezone: "UTC" },
        maintenanceAgents: ["ops"], // main is not in the roster
      },
    },
  });
  // Load the job store from disk so reconcileMaintenancePhaseTransition
  // can find the job in state.store.jobs.
  await ensureLoaded(state, { forceReload: true, skipRecompute: true });
  return state;
}

beforeEach(() => {
  resetMaintenanceDeferrals();
});
afterEach(() => {
  resetMaintenanceDeferrals();
});

describe("applyJobResult mirrors maintenance deferral to job.state", () => {
  it("sets deferredMaintenanceCount when a deferred job eventually runs", async () => {
    const job = makeJob("job-A");
    const state = await makeState(job);

    // Tick 1: inside the maintenance window. Job A is blocked, deferral
    // is recorded.
    reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    const blocked = isRunnableJob({
      state,
      job,
      nowMs: AT_UTC_03_30,
      allowCronMissedRunByLastRun: true,
    });
    expect(blocked).toBe(false);
    // The store deserializes the job into a new object; reference the
    // store's copy to inspect the mirrored state.
    const storeJob = state.store?.jobs.find((j) => j.id === "job-A");
    expect(storeJob?.state.deferredMaintenanceCount ?? 0).toBe(0);

    // Phase exits; the next reconciliation mirrors the backlog into
    // job.state and clears the queue.
    const phaseExit = reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
    expect(phaseExit.current).toBe("normal");
    expect(phaseExit.drainedCount).toBe(1);
    // The mirror is now in effect: the count is set before applyJobResult.
    expect(storeJob?.state.deferredMaintenanceCount ?? 0).toBeGreaterThan(0);

    // Tick 2: outside the window. Job A is now admissible.
    const admitted = isRunnableJob({
      state,
      job,
      nowMs: AT_UTC_05_00,
      allowCronMissedRunByLastRun: true,
    });
    expect(admitted).toBe(true);

    // applyJobResult is called when the run completes. The queue is
    // already drained (the mirror happened at phase exit), so the
    // applyJobResult lookup misses and does not double-count. The
    // count from the phase-exit mirror persists.
    applyJobResult(
      state,
      job,
      { status: "ok", startedAt: AT_UTC_05_00, endedAt: AT_UTC_05_00 + 100 },
      { scheduleMode: "advance" },
    );
    expect(storeJob?.state.deferredMaintenanceCount ?? 0).toBeGreaterThan(0);
  });
});
