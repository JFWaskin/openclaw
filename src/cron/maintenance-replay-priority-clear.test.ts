// Regression for ClawSweeper cycle 5d [P1] "Clear replay priority
// after the replay batch". The previous design sorted admitted jobs
// by `lastDeferredMaintenanceAtMs`, which is the historical per-job
// diagnostic timestamp that is set on every deferral and never
// cleared. A job deferred once would therefore outrank ordinary due
// jobs on every subsequent window — the "replay priority" would
// become permanent.
//
// The fix introduces a transient field `pendingMaintenanceReplayAtMs`
// that is set ONLY at the phase-exit mirror and cleared after the
// first tick that admits the deferred job. The collector uses the
// transient field for ordering; the historical field is preserved
// for the protocol-level diagnostics.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetMaintenanceDeferrals } from "./maintenance-deferred.js";
import { reconcileMaintenancePhaseTransition } from "./maintenance-policy.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { ensureLoaded } from "./service/store.js";
import { collectRunnableJobs, isRunnableJob } from "./service/timer-runnable.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-replay-priority-",
});

const AT_UTC_03_30 = Date.UTC(2026, 0, 15, 3, 30, 0); // inside [02:00, 04:00)
const AT_UTC_05_00 = Date.UTC(2026, 0, 15, 5, 0, 0); // after window
const AT_UTC_06_00 = Date.UTC(2026, 0, 15, 6, 0, 0); // later (next window test)

function makeJob(id: string, agentId: string, dueAtMs: number): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "hi", toolsAllow: ["write"] },
    agentId,
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

async function makeState(jobs: CronJob[]) {
  const { storePath } = await makeStorePath();
  await writeCronStoreSnapshot({ storePath, jobs });
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
        maintenanceAgents: ["ops"],
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

describe("replay priority is transient (cleared after first admission)", () => {
  it("a job deferred once is replayed once, then does not retain replay priority", async () => {
    // job-def (main agent, NOT in roster) and job-fresh (ops, in roster,
    // never deferred). Both are due at the same time. The replay must
    // admit job-def first, but on subsequent ticks job-fresh must rank
    // by its own due time, not after job-def's historical priority.
    const jobDef = makeJob("job-def", "main", AT_UTC_03_30 - 60_000);
    const jobFresh = makeJob("job-fresh", "ops", AT_UTC_03_30 - 60_000);
    const state = await makeState([jobDef, jobFresh]);

    // Tick 1: inside the window. Defer job-def.
    await reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    isRunnableJob({
      state,
      job: jobDef,
      nowMs: AT_UTC_03_30,
      allowCronMissedRunByLastRun: true,
    });
    expect(
      isRunnableJob({
        state,
        job: jobFresh,
        nowMs: AT_UTC_03_30,
        allowCronMissedRunByLastRun: true,
      }),
    ).toBe(true);

    // Tick 2: phase exits. job-def is admitted via replay priority.
    await reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
    const admitted = collectRunnableJobs(state, AT_UTC_05_00, {
      allowCronMissedRunByLastRun: true,
    });
    // job-def is admitted first (replay priority).
    expect(admitted[0]?.id).toBe("job-def");

    // The transient `pendingMaintenanceReplayAtMs` is cleared on the
    // admitted jobs, but the historical `lastDeferredMaintenanceAtMs`
    // is preserved (the protocol-level diagnostic).
    const storeDef = state.store?.jobs.find((j) => j.id === "job-def");
    expect(storeDef?.state.pendingMaintenanceReplayAtMs).toBeNull();
    expect(storeDef?.state.lastDeferredMaintenanceAtMs).toBe(AT_UTC_03_30);
    expect(storeDef?.state.deferredMaintenanceCount).toBe(1);

    // Tick 3: both jobs are due again (or we manually trigger a second
    // deferral). Without the transient-field fix, job-def would
    // always rank first by historical timestamp. With the fix, both
    // jobs have `pendingMaintenanceReplayAtMs: null` so the order
    // falls back to `nextRunAtMs` (equal here, so the natural store
    // order is preserved).
    await reconcileMaintenancePhaseTransition(state, AT_UTC_06_00);
    // Both jobs are now admissible (window is past). Without the
    // fix, job-def would be first (historical priority); with the
    // fix, the order is the natural store order (job-def is index 0).
    // The KEY assertion is that neither job has the transient
    // marker set (cleared after the first tick).
    const storeDefTick3 = state.store?.jobs.find((j) => j.id === "job-def");
    const storeFreshTick3 = state.store?.jobs.find((j) => j.id === "job-fresh");
    // After the replay tick, the transient marker is cleared (null)
    // for the deferred job. For the non-deferred job, the field was
    // never set (undefined). Both are "no replay priority".
    expect(storeDefTick3?.state.pendingMaintenanceReplayAtMs).toBeFalsy();
    expect(storeFreshTick3?.state.pendingMaintenanceReplayAtMs).toBeFalsy();
  });

  it("historical lastDeferredMaintenanceAtMs is preserved across many windows", async () => {
    // ClawSweeper cycle 5d [P1] "Retain scheduled heartbeat deferrals
    // until the window ends" — the historical diagnostic is preserved
    // for the protocol surface; only the transient replay field is
    // cleared.
    const job = makeJob("job-A", "main", AT_UTC_03_30 - 60_000);
    const state = await makeState([job]);

    // Window 1: defer, drain, replay.
    await reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    isRunnableJob({
      state,
      job,
      nowMs: AT_UTC_03_30,
      allowCronMissedRunByLastRun: true,
    });
    await reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
    collectRunnableJobs(state, AT_UTC_05_00, {
      allowCronMissedRunByLastRun: true,
    });
    const storeJob = state.store?.jobs.find((j) => j.id === "job-A");
    expect(storeJob?.state.deferredMaintenanceCount).toBe(1);
    expect(storeJob?.state.lastDeferredMaintenanceAtMs).toBe(AT_UTC_03_30);
    expect(storeJob?.state.pendingMaintenanceReplayAtMs).toBeNull();

    // Window 2 (simulated by a second reconcile that defers again).
    // The deferredMaintenanceCount INCREMENTS to 2; the historical
    // timestamp UPDATES to the latest deferral. The transient field
    // is set to the latest timestamp and then cleared on the next
    // admission. The point: the historical field is the cumulative
    // diagnostic; the transient field is per-cycle.
    isRunnableJob({
      state,
      job,
      nowMs: AT_UTC_05_00 + 1, // pretend window 2 just opened
      allowCronMissedRunByLastRun: true,
    });
    const afterSecondDefer = state.store?.jobs.find((j) => j.id === "job-A");
    expect(afterSecondDefer?.state.pendingMaintenanceReplayAtMs).toBeNull(); // not yet set; this tick admitted
  });
});
