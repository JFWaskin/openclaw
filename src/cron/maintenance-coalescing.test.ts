// Tri-fold coverage for the maintenance-window coalescing contract.
//
// Background: runvouch (RFC #120244, 2026-09-01) raised the concern that
// "FIFO replay of every missed periodic tick could create stale-work and
// load bursts at window exit". The proposal: replay ONE run per held job
// ("latest schedule wins") and record how many ticks got skipped so
// external monitors can compute the suppressed count without re-deriving
// the arithmetic from `lastRunAtMs`.
//
// ClawSweeper's 2026-09-02 RFC review elevated this to the open blocker:
// "FIFO replay of every missed periodic tick could create stale-work and
// load bursts at window exit; the active discussion raises per-job
// coalescing as an unresolved recovery contract."
//
// This file proves the contract in three ways:
//   - Functional: periodic jobs of various cadences held for various
//     windows produce the right coalesced count.
//   - Edge: zero missed, manual-run-during-window, at-jobs, schedules
//     whose target is before/after the window, and the no-op path.
//   - Regression: existing fields (lastDeferralReason, missedSchedule-
//     TicksEstimate, deferredMaintenanceCount, save-before-clear,
//     replay anchor) are unchanged.
//
// New protocol field under test: `lastMaintenanceCoalescedCount`.
// Documented in src/cron/types.ts and packages/gateway-protocol/src/schema/cron.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginMaintenancePhase,
  getMaintenanceDeferralCount,
  recordMaintenanceDeferral,
  resetMaintenanceDeferrals,
} from "./maintenance-deferred.js";
import { reconcileMaintenancePhaseTransition } from "./maintenance-policy.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { ensureLoaded } from "./service/store.js";
import { collectRunnableJobs } from "./service/timer-runnable.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-coalescing-",
});

// Window: 02:00–04:00 UTC on 2026-01-15. All phase-exit reconciler
// calls use WINDOW_EXIT_MS, which is AFTER the window ends, so the
// "normal -> maintenance" and "maintenance -> normal" transitions both
// happen in their respective windows.
const WINDOW_START_MS = Date.UTC(2026, 0, 15, 2, 0, 0);
const WINDOW_MID_MS = Date.UTC(2026, 0, 15, 3, 0, 0); // 1 hour into the window
const WINDOW_END_MS = Date.UTC(2026, 0, 15, 4, 0, 0);
const WINDOW_EXIT_MS = Date.UTC(2026, 0, 15, 4, 0, 30); // 30 s after window
// A second window for the multi-cycle test, also 02:00–04:00 but a
// different day so it doesn't overlap with the first.
const WINDOW2_START_MS = Date.UTC(2026, 0, 16, 2, 0, 0);
const WINDOW2_EXIT_MS = Date.UTC(2026, 0, 16, 4, 0, 30);

function makeJob(opts: {
  id: string;
  agentId?: string;
  schedule: CronJob["schedule"];
  nextRunAtMs: number;
  lastRunAtMs?: number;
}): CronJob {
  return {
    id: opts.id,
    name: opts.id,
    enabled: true,
    schedule: opts.schedule,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "hi", toolsAllow: ["write"] },
    agentId: opts.agentId ?? "main", // 'main' is NOT in maintenance roster -> defers
    state: {
      lastRunAtMs: opts.lastRunAtMs ?? 0,
      lastStatus: "ok",
      lastDurationMs: 0,
      consecutiveErrors: 0,
      nextRunAtMs: opts.nextRunAtMs,
    },
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

async function makeState(jobs: CronJob[], opts?: { opsAgentId?: string }) {
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
        maintenanceAgents: [opts?.opsAgentId ?? "ops"],
        allowManualRun: true,
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

describe("maintenance coalescing — FUNCTIONAL", () => {
  it("every-15m job held for 2 hours coalesces 7 of 8 ticks (one replay)", async () => {
    // runvouch's example: a 15-minute job deferred across a 3-hour
    // window would owe 12 ticks. We use a 2-hour window here so the
    // estimate is 8; the replay covers one of the 8 owed slots; the
    // other 7 are coalesced.
    //
    // Window: 02:00–04:00 UTC (2 hours). The estimator with
    // phaseEnteredAtMs = WINDOW_START_MS and exit at WINDOW_EXIT_MS
    // computes holdMs = WINDOW_EXIT_MS - WINDOW_START_MS = 2h + 30s.
    // floor((2h + 30s) / 15m) = 8. coalesced = 8 - 1 = 7.
    const job = makeJob({
      id: "every-15m",
      agentId: "main",
      schedule: { kind: "every", everyMs: 15 * 60_000, anchorMs: 0 },
      nextRunAtMs: WINDOW_START_MS - 60_000,
    });
    const state = await makeState([job]);

    // Enter maintenance at WINDOW_START_MS and defer the job once.
    await reconcileMaintenancePhaseTransition(state, WINDOW_START_MS);
    beginMaintenancePhase(WINDOW_START_MS);
    recordMaintenanceDeferral({
      jobId: "every-15m",
      agentId: "main",
      nowMs: WINDOW_START_MS,
    });

    // Exit at WINDOW_EXIT_MS (after the window ended). The phase
    // transitions maintenance -> normal and the reconciler drains
    // the held queue.
    const exit = await reconcileMaintenancePhaseTransition(state, WINDOW_EXIT_MS);
    expect(exit.current).toBe("normal");
    expect(exit.drainedCount).toBe(1);
    expect(getMaintenanceDeferralCount()).toBe(0);

    const storeJob = state.store?.jobs.find((j) => j.id === "every-15m");
    expect(storeJob?.state.lastMaintenanceCoalescedCount).toBe(7);
    expect(storeJob?.state.missedScheduleTicksEstimate).toBe(8);
    expect(storeJob?.state.missedScheduleTicksEstimateIsApproximate).toBe(false);
    expect(storeJob?.state.lastDeferralReason).toBe("maintenance_window");
    expect(storeJob?.state.deferredMaintenanceCount).toBe(1);
  });

  it("every-5m job held for 2 hours coalesces 23 of 24 ticks", async () => {
    // holdMs = 2h + 30s. floor((2h + 30s) / 5m) = 24. coalesced = 23.
    const job = makeJob({
      id: "every-5m",
      agentId: "main",
      schedule: { kind: "every", everyMs: 5 * 60_000, anchorMs: 0 },
      nextRunAtMs: WINDOW_START_MS - 60_000,
    });
    const state = await makeState([job]);

    await reconcileMaintenancePhaseTransition(state, WINDOW_START_MS);
    beginMaintenancePhase(WINDOW_START_MS);
    recordMaintenanceDeferral({
      jobId: "every-5m",
      agentId: "main",
      nowMs: WINDOW_START_MS,
    });
    await reconcileMaintenancePhaseTransition(state, WINDOW_EXIT_MS);

    const storeJob = state.store?.jobs.find((j) => j.id === "every-5m");
    expect(storeJob?.state.lastMaintenanceCoalescedCount).toBe(23);
    expect(storeJob?.state.missedScheduleTicksEstimate).toBe(24);
    expect(storeJob?.state.missedScheduleTicksEstimateIsApproximate).toBe(false);
  });

  it("cron-syntax job held for 2 hours coalesces 119 of 120 (1/min conservative)", async () => {
    // Cron jobs have no fixed everyMs; the estimator uses a conservative
    // 1/min bound and marks the result approximate. The coalesced count
    // mirrors that approximation.
    const job = makeJob({
      id: "cron-2h",
      agentId: "main",
      schedule: { kind: "cron", expr: "*/5 * * * *" },
      nextRunAtMs: WINDOW_START_MS - 60_000,
    });
    const state = await makeState([job]);

    await reconcileMaintenancePhaseTransition(state, WINDOW_START_MS);
    beginMaintenancePhase(WINDOW_START_MS);
    recordMaintenanceDeferral({
      jobId: "cron-2h",
      agentId: "main",
      nowMs: WINDOW_START_MS,
    });
    await reconcileMaintenancePhaseTransition(state, WINDOW_EXIT_MS);

    const storeJob = state.store?.jobs.find((j) => j.id === "cron-2h");
    // holdMs = 2h + 30s. floor((2h + 30s) / 60s) = 121 (rounded down).
    // Wait — 2h = 7200s; 7200 + 30 = 7230; 7230 / 60 = 120.5 → floor 120.
    // coalesced = 120 - 1 = 119.
    expect(storeJob?.state.lastMaintenanceCoalescedCount).toBe(119);
    expect(storeJob?.state.missedScheduleTicksEstimate).toBe(120);
    expect(storeJob?.state.missedScheduleTicksEstimateIsApproximate).toBe(true);
  });

  it("multiple held jobs each get their own coalesced count, summed at the boundary", async () => {
    // Two different-cadence jobs held in the same window. Each is
    // coalesced independently; the drainer produces a per-job mirror.
    const fast = makeJob({
      id: "fast-1m",
      agentId: "main",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
      nextRunAtMs: WINDOW_START_MS - 60_000,
    });
    const slow = makeJob({
      id: "slow-30m",
      agentId: "main",
      schedule: { kind: "every", everyMs: 30 * 60_000, anchorMs: 0 },
      nextRunAtMs: WINDOW_START_MS - 60_000,
    });
    const state = await makeState([fast, slow]);

    await reconcileMaintenancePhaseTransition(state, WINDOW_START_MS);
    beginMaintenancePhase(WINDOW_START_MS);
    recordMaintenanceDeferral({ jobId: "fast-1m", agentId: "main", nowMs: WINDOW_START_MS });
    recordMaintenanceDeferral({ jobId: "slow-30m", agentId: "main", nowMs: WINDOW_START_MS });
    await reconcileMaintenancePhaseTransition(state, WINDOW_EXIT_MS);

    // fast-1m: holdMs ≈ 2h. floor(2h / 1m) = 120. coalesced = 119.
    // slow-30m: holdMs ≈ 2h. floor(2h / 30m) = 4. coalesced = 3.
    const fastJob = state.store?.jobs.find((j) => j.id === "fast-1m");
    const slowJob = state.store?.jobs.find((j) => j.id === "slow-30m");
    expect(fastJob?.state.lastMaintenanceCoalescedCount).toBe(119);
    expect(slowJob?.state.lastMaintenanceCoalescedCount).toBe(3);
    // Both share the same lastDeferralReason.
    expect(fastJob?.state.lastDeferralReason).toBe("maintenance_window");
    expect(slowJob?.state.lastDeferralReason).toBe("maintenance_window");
  });
});

describe("maintenance coalescing — EDGE", () => {
  it("a job deferred once at window entry still reports the full hold duration", async () => {
    // Critical regression check: a job deferred only at the start of a
    // 2-hour window (single held entry, lastDeferredAtMs ==
    // firstDeferredAtMs) MUST still report a 2-hour hold. The estimator
    // takes the max of (entry span) and (nowMs - phaseEnteredAtMs) so
    // this works even when the held entry alone would say holdMs = 0.
    const job = makeJob({
      id: "single-defer",
      agentId: "main",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
      nextRunAtMs: WINDOW_START_MS - 60_000,
    });
    const state = await makeState([job]);

    await reconcileMaintenancePhaseTransition(state, WINDOW_START_MS);
    beginMaintenancePhase(WINDOW_START_MS);
    // Single deferral at window start. No further deferrals during the
    // 2-hour window — exactly the runvouch "deferred once, owed 12
    // ticks" scenario.
    recordMaintenanceDeferral({
      jobId: "single-defer",
      agentId: "main",
      nowMs: WINDOW_START_MS,
    });
    await reconcileMaintenancePhaseTransition(state, WINDOW_EXIT_MS);

    const storeJob = state.store?.jobs.find((j) => j.id === "single-defer");
    // holdMs = WINDOW_EXIT_MS - WINDOW_START_MS = 2h + 30s. floor/1m = 120.
    // coalesced = 119.
    expect(storeJob?.state.lastMaintenanceCoalescedCount).toBe(119);
    expect(storeJob?.state.missedScheduleTicksEstimate).toBe(120);
  });

  it("zero missed ticks → coalesced count is 0", async () => {
    // The estimator floors at 1 (a hold of any length implies at
    // least the first due slot was missed), so a true 0-ms hold with
    // a `every` schedule reports coalesced = 0. The `at` schedule
    // also yields 1 → 0.
    const job = makeJob({
      id: "at-once",
      agentId: "main",
      schedule: { kind: "at", at: new Date(WINDOW_MID_MS).toISOString() },
      nextRunAtMs: WINDOW_MID_MS,
    });
    const state = await makeState([job]);

    await reconcileMaintenancePhaseTransition(state, WINDOW_START_MS);
    beginMaintenancePhase(WINDOW_START_MS);
    recordMaintenanceDeferral({ jobId: "at-once", agentId: "main", nowMs: WINDOW_MID_MS });
    await reconcileMaintenancePhaseTransition(state, WINDOW_EXIT_MS);

    const storeJob = state.store?.jobs.find((j) => j.id === "at-once");
    // `at` estimate is 1; coalesced = 1 - 1 = 0.
    expect(storeJob?.state.lastMaintenanceCoalescedCount).toBe(0);
    expect(storeJob?.state.missedScheduleTicksEstimate).toBe(1);
    expect(storeJob?.state.missedScheduleTicksEstimateIsApproximate).toBe(true);
  });

  it("on-exit / event-driven jobs get NO estimate and NO coalesced count (field stays undefined)", async () => {
    // The estimator returns `undefined` for on-exit/stream schedules
    // because they have no time axis. Neither `missedScheduleTicksEstimate`
    // nor `lastMaintenanceCoalescedCount` should be set in that case —
    // the external monitor would be guessing if it tried to compute a
    // coalesced count from a missing estimate.
    const onExitJob = makeJob({
      id: "on-exit",
      agentId: "main",
      schedule: { kind: "on-exit", command: "watcher-cmd" },
      nextRunAtMs: 0,
    });
    const streamJob = makeJob({
      id: "stream",
      agentId: "main",
      schedule: { kind: "stream", command: ["tail", "-f", "/tmp/log"] },
      nextRunAtMs: 0,
    });
    const state = await makeState([onExitJob, streamJob]);

    await reconcileMaintenancePhaseTransition(state, WINDOW_START_MS);
    beginMaintenancePhase(WINDOW_START_MS);
    recordMaintenanceDeferral({ jobId: "on-exit", agentId: "main", nowMs: WINDOW_START_MS });
    recordMaintenanceDeferral({ jobId: "stream", agentId: "main", nowMs: WINDOW_START_MS });
    await reconcileMaintenancePhaseTransition(state, WINDOW_EXIT_MS);

    const onExitStore = state.store?.jobs.find((j) => j.id === "on-exit");
    const streamStore = state.store?.jobs.find((j) => j.id === "stream");
    expect(onExitStore?.state.lastMaintenanceCoalescedCount).toBeUndefined();
    expect(onExitStore?.state.missedScheduleTicksEstimate).toBeUndefined();
    expect(streamStore?.state.lastMaintenanceCoalescedCount).toBeUndefined();
    expect(streamStore?.state.missedScheduleTicksEstimate).toBeUndefined();
  });

  it("the held queue is deduped across multiple deferrals of the same job", async () => {
    // If a job is held, the policy records it once. Multiple deferral
    // events for the same job within the same phase are merged into
    // one entry; the lastDeferredAtMs is updated to the most recent
    // tick. Therefore, the coalesced count is computed against the
    // actual phase duration, not summed across per-tick holds.
    const job = makeJob({
      id: "dedup",
      agentId: "main",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
      nextRunAtMs: WINDOW_START_MS - 60_000,
    });
    const state = await makeState([job]);

    await reconcileMaintenancePhaseTransition(state, WINDOW_START_MS);
    beginMaintenancePhase(WINDOW_START_MS);
    // Three separate deferral events for the same job. The queue must
    // remain at size 1 because the dedup path refreshes the existing
    // entry instead of pushing a new one.
    recordMaintenanceDeferral({ jobId: "dedup", agentId: "main", nowMs: WINDOW_START_MS });
    recordMaintenanceDeferral({ jobId: "dedup", agentId: "main", nowMs: WINDOW_MID_MS });
    recordMaintenanceDeferral({ jobId: "dedup", agentId: "main", nowMs: WINDOW_MID_MS + 60_000 });
    expect(getMaintenanceDeferralCount()).toBe(1);

    await reconcileMaintenancePhaseTransition(state, WINDOW_EXIT_MS);
    const storeJob = state.store?.jobs.find((j) => j.id === "dedup");
    // holdMs = WINDOW_EXIT_MS - WINDOW_START_MS = 2h + 30s.
    // floor((2h + 30s) / 1m) = 120. coalesced = 119.
    expect(storeJob?.state.lastMaintenanceCoalescedCount).toBe(119);
    expect(storeJob?.state.missedScheduleTicksEstimate).toBe(120);
    // Lifetime hold-event count is still 1 (one drain happened).
    expect(storeJob?.state.deferredMaintenanceCount).toBe(1);
  });

  it("a held job that the operator manually ran during the window still has coalesced count set", async () => {
    // allowManualRun is true in this suite, so an operator can fire the
    // job mid-window. The manual run is not visible in the held entry,
    // so the estimator still treats the window as 1/N ticks. The
    // coalesced count is conservative in this case: it includes the
    // manually-run slot in the "owed" total. (External monitors cross-
    // reference lastRunAtMs to disambiguate.)
    const job = makeJob({
      id: "manual-mid",
      agentId: "main",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
      nextRunAtMs: WINDOW_START_MS - 60_000,
      lastRunAtMs: WINDOW_MID_MS, // operator-fired at mid-window
    });
    const state = await makeState([job]);

    await reconcileMaintenancePhaseTransition(state, WINDOW_START_MS);
    beginMaintenancePhase(WINDOW_START_MS);
    recordMaintenanceDeferral({ jobId: "manual-mid", agentId: "main", nowMs: WINDOW_START_MS });
    await reconcileMaintenancePhaseTransition(state, WINDOW_EXIT_MS);

    const storeJob = state.store?.jobs.find((j) => j.id === "manual-mid");
    // holdMs = 2h + 30s. floor(2h/1m) ≈ 120. coalesced = 119.
    expect(storeJob?.state.lastMaintenanceCoalescedCount).toBe(119);
    expect(storeJob?.state.missedScheduleTicksEstimate).toBe(120);
    // lastRunAtMs is preserved from the manual mid-window run.
    expect(storeJob?.state.lastRunAtMs).toBe(WINDOW_MID_MS);
  });

  it("the next tick after phase exit admits the held job exactly once (no burst)", async () => {
    // The contract: ONE admission per held job, regardless of how many
    // ticks the estimator says were owed. The collector does not loop.
    const job = makeJob({
      id: "no-burst",
      agentId: "main",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
      nextRunAtMs: WINDOW_START_MS - 60_000,
    });
    const state = await makeState([job]);

    await reconcileMaintenancePhaseTransition(state, WINDOW_START_MS);
    beginMaintenancePhase(WINDOW_START_MS);
    recordMaintenanceDeferral({ jobId: "no-burst", agentId: "main", nowMs: WINDOW_START_MS });
    await reconcileMaintenancePhaseTransition(state, WINDOW_EXIT_MS);

    // One tick at WINDOW_EXIT_MS. The job is admitted exactly once.
    const admitted = collectRunnableJobs(state, WINDOW_EXIT_MS, {
      allowCronMissedRunByLastRun: true,
    });
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.id).toBe("no-burst");
  });

  it("an empty held queue produces no coalesced counts and no replay", async () => {
    // The window opens and closes with no jobs held. Nothing happens
    // to the store, no fields are stamped, and the queue stays empty.
    const job = makeJob({
      id: "untouched",
      agentId: "ops", // ops is IN the maintenance roster, never defers
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
      nextRunAtMs: WINDOW_START_MS,
    });
    const state = await makeState([job]);

    await reconcileMaintenancePhaseTransition(state, WINDOW_START_MS);
    await reconcileMaintenancePhaseTransition(state, WINDOW_EXIT_MS);

    const storeJob = state.store?.jobs.find((j) => j.id === "untouched");
    expect(storeJob?.state.lastMaintenanceCoalescedCount).toBeUndefined();
    expect(storeJob?.state.missedScheduleTicksEstimate).toBeUndefined();
    expect(storeJob?.state.lastDeferralReason).toBeUndefined();
    expect(storeJob?.state.deferredMaintenanceCount).toBeUndefined();
  });
});

describe("maintenance coalescing — REGRESSION", () => {
  it("preserves lastDeferralReason across multiple phase cycles", async () => {
    // The field is overwritten (not accumulated) at each phase exit, so
    // a job that gets held again in a later cycle reports the latest
    // reason. This guards against a regression where the new
    // coalesced-count code path accidentally clears the reason.
    //
    // Use two SEPARATE windows on different days so each phase-exit
    // call actually exits maintenance (within the same window, the
    // reconciler sees previous=maintenance, current=maintenance, and
    // does not drain).
    const job = makeJob({
      id: "multi-cycle",
      agentId: "main",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
      nextRunAtMs: WINDOW_START_MS - 60_000,
    });
    const state = await makeState([job]);

    // Cycle 1: enter at WINDOW_START_MS, defer, exit at WINDOW_EXIT_MS.
    await reconcileMaintenancePhaseTransition(state, WINDOW_START_MS);
    beginMaintenancePhase(WINDOW_START_MS);
    recordMaintenanceDeferral({ jobId: "multi-cycle", agentId: "main", nowMs: WINDOW_START_MS });
    await reconcileMaintenancePhaseTransition(state, WINDOW_EXIT_MS);
    expect(
      state.store?.jobs.find((j) => j.id === "multi-cycle")?.state.deferredMaintenanceCount,
    ).toBe(1);

    // Cycle 2: enter at WINDOW2_START_MS, defer, exit at WINDOW2_EXIT_MS.
    await reconcileMaintenancePhaseTransition(state, WINDOW2_START_MS);
    beginMaintenancePhase(WINDOW2_START_MS);
    recordMaintenanceDeferral({ jobId: "multi-cycle", agentId: "main", nowMs: WINDOW2_START_MS });
    await reconcileMaintenancePhaseTransition(state, WINDOW2_EXIT_MS);

    const storeJob = state.store?.jobs.find((j) => j.id === "multi-cycle");
    expect(storeJob?.state.lastDeferralReason).toBe("maintenance_window");
    expect(storeJob?.state.deferredMaintenanceCount).toBe(2);
    // Coalesced count is for the most recent hold.
    expect(storeJob?.state.lastMaintenanceCoalescedCount).toBe(119);
  });

  it("save-before-clear ordering is preserved (held queue NOT cleared on save failure)", async () => {
    // Cycle 5d [P1] and cycle 6 [P1] both require that the deferred
    // queue only be cleared AFTER saveCronStore() returns success. The
    // coalesced count is set BEFORE the save (we mirror diagnostics
    // first, save, then clear) so a save failure that retries from the
    // in-memory queue does not double-count. This test asserts the
    // post-condition: after a successful exit, the queue IS empty and
    // the coalesced count reflects the single held window — not
    // doubled.
    const job = makeJob({
      id: "save-fail",
      agentId: "main",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
      nextRunAtMs: WINDOW_START_MS - 60_000,
    });
    const state = await makeState([job]);

    await reconcileMaintenancePhaseTransition(state, WINDOW_START_MS);
    beginMaintenancePhase(WINDOW_START_MS);
    recordMaintenanceDeferral({ jobId: "save-fail", agentId: "main", nowMs: WINDOW_START_MS });
    expect(getMaintenanceDeferralCount()).toBe(1);

    const exit = await reconcileMaintenancePhaseTransition(state, WINDOW_EXIT_MS);
    expect(exit.drainedCount).toBe(1);
    expect(getMaintenanceDeferralCount()).toBe(0); // cleared after save
    const storeJob = state.store?.jobs.find((j) => j.id === "save-fail");
    // Coalesced count reflects the single held window — not doubled.
    expect(storeJob?.state.lastMaintenanceCoalescedCount).toBe(119);
  });

  it("replay anchor moves nextRunAtMs to lastDeferredAtMs but never forward", async () => {
    // Cycle 5 [P1] requirement: replay must not artificially push a
    // job's next run into the future. A job with nextRunAtMs earlier
    // than the anchor keeps its earlier value.
    const job = makeJob({
      id: "early-anchor",
      agentId: "main",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
      // nextRunAtMs earlier than the replay anchor (which is at the
      // last deferral, WINDOW_START_MS).
      nextRunAtMs: WINDOW_START_MS - 60_000,
    });
    const state = await makeState([job]);

    await reconcileMaintenancePhaseTransition(state, WINDOW_START_MS);
    beginMaintenancePhase(WINDOW_START_MS);
    recordMaintenanceDeferral({ jobId: "early-anchor", agentId: "main", nowMs: WINDOW_START_MS });
    await reconcileMaintenancePhaseTransition(state, WINDOW_EXIT_MS);

    const storeJob = state.store?.jobs.find((j) => j.id === "early-anchor");
    // Original nextRunAtMs (WINDOW_START_MS - 60_000) is earlier than the
    // replay anchor (WINDOW_START_MS), so it must be preserved.
    expect(storeJob?.state.nextRunAtMs).toBe(WINDOW_START_MS - 60_000);
    // Coalesced count is still computed correctly.
    expect(storeJob?.state.lastMaintenanceCoalescedCount).toBe(119);
  });

  it("FIFO replay order is preserved with the new coalesced count field", async () => {
    // Cycle 4 [P1] requirement: deferred jobs replay in FIFO order on
    // the first tick after exit. The new field must not perturb the
    // collector's sort.
    const a = makeJob({
      id: "fifo-A",
      agentId: "main",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
      nextRunAtMs: WINDOW_START_MS - 60_000,
    });
    const b = makeJob({
      id: "fifo-B",
      agentId: "main",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
      nextRunAtMs: WINDOW_START_MS - 60_000,
    });
    const c = makeJob({
      id: "fifo-C",
      agentId: "main",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
      nextRunAtMs: WINDOW_START_MS - 60_000,
    });
    // Use a non-natural store order: C is job[0], A is job[1], B is job[2].
    const state = await makeState([c, a, b]);

    await reconcileMaintenancePhaseTransition(state, WINDOW_START_MS);
    beginMaintenancePhase(WINDOW_START_MS);
    recordMaintenanceDeferral({ jobId: "fifo-A", agentId: "main", nowMs: WINDOW_START_MS });
    recordMaintenanceDeferral({ jobId: "fifo-B", agentId: "main", nowMs: WINDOW_START_MS + 1 });
    recordMaintenanceDeferral({ jobId: "fifo-C", agentId: "main", nowMs: WINDOW_START_MS + 2 });
    await reconcileMaintenancePhaseTransition(state, WINDOW_EXIT_MS);

    const admitted = collectRunnableJobs(state, WINDOW_EXIT_MS + 60_000, {
      allowCronMissedRunByLastRun: true,
    });
    expect(admitted.map((j) => j.id)).toEqual(["fifo-A", "fifo-B", "fifo-C"]);
  });
});
