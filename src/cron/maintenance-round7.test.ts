// Round 7 fixes: runvouch-driven protocol fields + cycle 6 deferred
// P1/P2 fixes + doc-drift fix.
//
// Covers:
//   - lastDeferralReason is set at defer time AND phase-exit mirror
//   - missedScheduleTicksEstimate is computed per schedule kind
//   - save-before-clear ordering: queue is only cleared after save succeeds
//   - doc comments correctly describe cumulative semantics
//
// Schema tests (IANA timezone + 24:00) live in
// `src/config/maintenance-window-schema.test.ts`. Targeted-wake gate tests
// live in `src/infra/heartbeat-runner-scheduler.maintenance.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginMaintenancePhase,
  getMaintenanceDeferralCount,
  listMaintenanceDeferrals,
  recordMaintenanceDeferral,
  resetMaintenanceDeferrals,
} from "./maintenance-deferred.js";
import { reconcileMaintenancePhaseTransition } from "./maintenance-policy.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { shouldDeferJobToMaintenance } from "./service/timer-runnable.js";
import { saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-round7-",
});

const AT_UTC_03_30 = Date.UTC(2026, 0, 15, 3, 30, 0); // inside [02:00, 04:00)
const AT_UTC_05_00 = Date.UTC(2026, 0, 15, 5, 0, 0); // after window

function maintenanceConfig() {
  return {
    enabled: true,
    window: { start: "02:00", end: "04:00", timezone: "UTC" },
    maintenanceAgents: ["ops"],
  };
}

function makeEveryJob(id: string, agentId: string, everyMs: number): CronJob {
  return {
    id,
    agentId,
    name: id,
    enabled: true,
    schedule: { kind: "every", everyMs },
    payload: { kind: "systemEvent", text: "noop" },
    delivery: { mode: "none" },
    failureAlert: false,
    state: { nextRunAtMs: 0 },
    createdAtMs: AT_UTC_03_30,
    updatedAtMs: AT_UTC_03_30,
  } as CronJob;
}

function makeCronJob(id: string, agentId: string, expr: string): CronJob {
  return {
    id,
    agentId,
    name: id,
    enabled: true,
    schedule: { kind: "cron", expr },
    payload: { kind: "systemEvent", text: "noop" },
    delivery: { mode: "none" },
    failureAlert: false,
    state: { nextRunAtMs: 0 },
    createdAtMs: AT_UTC_03_30,
    updatedAtMs: AT_UTC_03_30,
  } as CronJob;
}

function makeAtJob(id: string, agentId: string, at: string): CronJob {
  return {
    id,
    agentId,
    name: id,
    enabled: true,
    schedule: { kind: "at", at },
    payload: { kind: "systemEvent", text: "noop" },
    delivery: { mode: "none" },
    failureAlert: false,
    state: { nextRunAtMs: Date.parse(at) },
    createdAtMs: AT_UTC_03_30,
    updatedAtMs: AT_UTC_03_30,
  } as CronJob;
}

async function makeState(maintenance = maintenanceConfig()) {
  const { storePath } = await makeStorePath();
  return createCronServiceState({
    storePath,
    cronEnabled: true,
    log: logger,
    defaultAgentId: "main",
    userTimezone: "UTC",
    cronConfig: { maintenance },
  });
}

/**
 * Record a hold for `jobId` that spans [firstMs, lastMs] by calling
 * `recordMaintenanceDeferral` once for the first timestamp (creates the
 * entry) and again for the last timestamp (refreshes `lastDeferredAtMs`).
 * Simulates what the maintenance gate would do across a multi-tick hold.
 */
function recordHold(jobId: string, agentId: string, firstMs: number, lastMs: number): void {
  recordMaintenanceDeferral({ jobId, agentId, nowMs: firstMs });
  recordMaintenanceDeferral({ jobId, agentId, nowMs: lastMs });
}

describe("round 7: lastDeferralReason", () => {
  beforeEach(() => {
    resetMaintenanceDeferrals();
  });
  afterEach(() => {
    resetMaintenanceDeferrals();
  });

  it("populates lastDeferralReason='maintenance_window' when a job is deferred", () => {
    const state = {
      deps: {
        cronConfig: { maintenance: maintenanceConfig() },
        defaultAgentId: "main",
        userTimezone: "UTC",
      },
    } as unknown as Parameters<typeof shouldDeferJobToMaintenance>[0];

    const job = makeEveryJob("job-A", "main", 60_000);
    const deferred = shouldDeferJobToMaintenance(state, job, AT_UTC_03_30);
    expect(deferred).toBe(true);
    expect(job.state.lastDeferralReason).toBe("maintenance_window");
  });

  it("does not set lastDeferralReason when the agent is in the maintenance roster", () => {
    const state = {
      deps: {
        cronConfig: { maintenance: maintenanceConfig() },
        defaultAgentId: "main",
        userTimezone: "UTC",
      },
    } as unknown as Parameters<typeof shouldDeferJobToMaintenance>[0];

    // "ops" is in maintenanceAgents; the gate allows it through.
    const job = makeEveryJob("job-ops", "ops", 60_000);
    const deferred = shouldDeferJobToMaintenance(state, job, AT_UTC_03_30);
    expect(deferred).toBe(false);
    expect(job.state.lastDeferralReason).toBeUndefined();
  });

  it("preserves lastDeferralReason across the phase-exit mirror", async () => {
    const state = await makeState();
    state.store = {
      version: 1,
      jobs: [makeEveryJob("job-A", "main", 60_000)],
    };
    // First tick: records previous=maintenance.
    await reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    beginMaintenancePhase(AT_UTC_03_30);
    recordHold("job-A", "main", AT_UTC_03_30, AT_UTC_03_30 + 60_000);

    // Second tick: maintenance -> normal transition drains the queue.
    await reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
    expect(state.store.jobs[0].state!.lastDeferralReason).toBe("maintenance_window");
  });
});

describe("round 7: missedScheduleTicksEstimate", () => {
  beforeEach(() => {
    resetMaintenanceDeferrals();
  });
  afterEach(() => {
    resetMaintenanceDeferrals();
  });

  it("exact count for {kind: 'every'} schedules (15-min job held 3h -> 12 missed)", async () => {
    const state = await makeState();
    const job = makeEveryJob("job-A", "main", 15 * 60_000);
    state.store = { version: 1, jobs: [job] };
    // First tick at 03:30: previous=maintenance, queue empty so no drain.
    await reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    beginMaintenancePhase(AT_UTC_03_30);
    // Hold from 03:00 to 06:00 UTC (180 minutes = 12 fifteen-minute slots).
    recordHold("job-A", "main", Date.UTC(2026, 0, 15, 3, 0, 0), Date.UTC(2026, 0, 15, 6, 0, 0));

    // Second tick at 06:00: previous=maintenance, current=normal -> drain.
    await reconcileMaintenancePhaseTransition(state, Date.UTC(2026, 0, 15, 6, 0, 0));
    expect(job.state!.missedScheduleTicksEstimate).toBe(12);
    expect(job.state!.missedScheduleTicksEstimateIsApproximate).toBe(false);
  });

  it("conservative count for {kind: 'cron'} schedules (3h hold -> ~180 with approximate flag)", async () => {
    const state = await makeState();
    const job = makeCronJob("job-A", "main", "*/15 * * * *");
    state.store = { version: 1, jobs: [job] };
    await reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    beginMaintenancePhase(AT_UTC_03_30);
    recordHold("job-A", "main", Date.UTC(2026, 0, 15, 3, 0, 0), Date.UTC(2026, 0, 15, 6, 0, 0));

    await reconcileMaintenancePhaseTransition(state, Date.UTC(2026, 0, 15, 6, 0, 0));
    expect(job.state!.missedScheduleTicksEstimate).toBe(180);
    expect(job.state!.missedScheduleTicksEstimateIsApproximate).toBe(true);
  });

  it("one-shot at-schedule: count=1 with approximate flag", async () => {
    const state = await makeState();
    const atMs = Date.UTC(2026, 0, 15, 3, 30, 0);
    const job = makeAtJob("job-A", "main", new Date(atMs).toISOString());
    state.store = { version: 1, jobs: [job] };
    await reconcileMaintenancePhaseTransition(state, atMs);
    beginMaintenancePhase(atMs);
    recordHold("job-A", "main", atMs, atMs);

    await reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
    expect(job.state!.missedScheduleTicksEstimate).toBe(1);
    expect(job.state!.missedScheduleTicksEstimateIsApproximate).toBe(true);
  });
});

describe("round 7: save-before-clear ordering", () => {
  beforeEach(() => {
    resetMaintenanceDeferrals();
  });
  afterEach(() => {
    resetMaintenanceDeferrals();
  });

  it("on save success, the deferred queue is cleared", async () => {
    const state = await makeState();
    state.store = {
      version: 1,
      jobs: [makeEveryJob("job-A", "main", 60_000)],
    };
    // First tick: previous=maintenance.
    await reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    beginMaintenancePhase(AT_UTC_03_30);
    recordHold("job-A", "main", AT_UTC_03_30, AT_UTC_03_30 + 60_000);
    expect(getMaintenanceDeferralCount()).toBe(1);

    // Second tick at 05:00: maintenance -> normal. Save succeeds.
    await reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
    expect(getMaintenanceDeferralCount()).toBe(0);
  });

  it("on save failure, the deferred queue is RETAINED for retry", async () => {
    const state = await makeState();
    state.store = {
      version: 1,
      jobs: [makeEveryJob("job-A", "main", 60_000)],
    };
    // First tick: previous=maintenance.
    await reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
    beginMaintenancePhase(AT_UTC_03_30);
    recordHold("job-A", "main", AT_UTC_03_30, AT_UTC_03_30 + 60_000);
    expect(getMaintenanceDeferralCount()).toBe(1);

    // Force the save to fail. We spy on saveCronStore and have it throw;
    // the implementation catches and retains the in-memory queue.
    const saveSpy = vi
      .spyOn(await import("./store.js"), "saveCronStore")
      .mockRejectedValueOnce(new Error("forced save failure for round 7 test"));

    // Second tick at 05:00: maintenance -> normal. Save throws.
    await reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
    // Save failed -> queue retained for the next reconciliation tick.
    expect(getMaintenanceDeferralCount()).toBe(1);
    const held = listMaintenanceDeferrals();
    expect(held).toHaveLength(1);
    expect(held[0].jobId).toBe("job-A");
    saveSpy.mockRestore();
  });
});
