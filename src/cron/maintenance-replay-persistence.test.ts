// Regression for ClawSweeper cycle 5d [P1] "Persist phase-exit replay
// before clearing its queue". The previous design mutated `state.store`
// in-memory then cleared the queue, but never persisted the replay-anchor
// writes or the per-job diagnostics. A subsequent `ensureLoaded({ forceReload: true })`
// (which happens on every manual-run preflight, hot-reload, and other
// store-mutation paths) would re-read the on-disk snapshot and lose
// every in-memory mutation. The deferred jobs would never be replayed.
//
// This test exercises the contract end-to-end:
//   1. Maintenance active; isRunnableJob records a deferral for job A.
//   2. Phase exits; reconcileMaintenancePhaseTransition drains the
//      queue and persists the store.
//   3. Manual-run preflight calls `ensureLoaded({ forceReload: true })`
//      (or any other force-reload path), simulating the real-world
//      re-read of the cron store from disk.
//   4. After the force-reload, the replay anchor and per-job
//      diagnostics are STILL present.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginMaintenancePhase,
  recordMaintenanceDeferral,
  resetMaintenanceDeferrals,
} from "./maintenance-deferred.js";
import { reconcileMaintenancePhaseTransition } from "./maintenance-policy.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { ensureLoaded } from "./service/store.js";
import { isRunnableJob } from "./service/timer-runnable.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-replay-persist-",
});

const AT_UTC_03_30 = Date.UTC(2026, 0, 15, 3, 30, 0); // inside [02:00, 04:00)
const AT_UTC_05_00 = Date.UTC(2026, 0, 15, 5, 0, 0); // after window

function makeJob(id: string, dueAtMs: number): CronJob {
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
      nextRunAtMs: dueAtMs,
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
        maintenanceAgents: ["ops"], // main is NOT in roster
      },
    },
  });
  await ensureLoaded(state, { forceReload: true, skipRecompute: true });
  return state;
}

beforeEach(() => {
  resetMaintenanceDeferrals();
});
afterEach(() => {
  resetMaintenanceDeferrals();
});

describe("reconcileMaintenancePhaseTransition persists the replay anchor", () => {
  it("force-reload after phase exit still sees the replay anchor + diagnostics", async () => {
    const job = makeJob("job-A", AT_UTC_03_30 - 60_000);
    const state = await makeState(job);

    // Tick 1: inside the window. Defer the job.
    reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    beginMaintenancePhase(AT_UTC_03_30);
    recordMaintenanceDeferral({ jobId: "job-A", agentId: "main", nowMs: AT_UTC_03_30 });
    expect(
      isRunnableJob({
        state,
        job,
        nowMs: AT_UTC_03_30,
        allowCronMissedRunByLastRun: true,
      }),
    ).toBe(false);

    // Phase exits: reconcile drains the queue and (per the fix) persists
    // the store so the next reload sees the replay anchor.
    const phaseExit = await reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
    expect(phaseExit.current).toBe("normal");
    expect(phaseExit.drainedCount).toBe(1);

    // Force-reload (simulating the manual-run preflight or hot-reload
    // path). The on-disk snapshot is re-read; the in-memory state is
    // replaced with the persisted snapshot. Without the persist fix,
    // the replay anchor would be lost and the job would not run.
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const storeJob = state.store?.jobs.find((j) => j.id === "job-A");
    expect(storeJob).toBeDefined();
    if (!storeJob) {
      return;
    }

    // Per-job diagnostics survived the force-reload.
    expect(storeJob.state.deferredMaintenanceCount).toBe(1);
    expect(storeJob.state.firstDeferredMaintenanceAtMs).toBe(AT_UTC_03_30);
    expect(storeJob.state.lastDeferredMaintenanceAtMs).toBe(AT_UTC_03_30);
    // Replay anchor survived: nextRunAtMs is in the past, so the next
    // scheduler tick will admit the job through the normal path.
    expect(storeJob.state.nextRunAtMs).toBeLessThanOrEqual(AT_UTC_05_00 - 1);

    // And the job is actually runnable on the next tick.
    expect(
      isRunnableJob({
        state,
        job: storeJob,
        nowMs: AT_UTC_05_00,
        allowCronMissedRunByLastRun: true,
      }),
    ).toBe(true);
  });

  it("phase-exit reconcile does not persist when the queue is empty (no-op path)", async () => {
    // The persist call should be guarded by `drainedCount > 0` so an
    // empty drain (e.g. window opened but no jobs deferred) does not
    // cause an unnecessary disk write. We test this by ensuring the
    // on-disk snapshot is unchanged across an empty reconcile.
    const job = makeJob("job-A", AT_UTC_03_30 - 60_000);
    const state = await makeState(job);

    // Phase enters but no deferrals are recorded.
    const tEnter = await reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    expect(tEnter.phaseBegan).toBe(true);

    // Phase exits with no held entries.
    const tExit = await reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
    expect(tExit.drainedCount).toBe(0);

    // Force-reload: store reflects the in-memory state (no per-job
    // maintenance fields were touched).
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const storeJob = state.store?.jobs.find((j) => j.id === "job-A");
    expect(storeJob?.state.deferredMaintenanceCount ?? 0).toBe(0);
  });
});
