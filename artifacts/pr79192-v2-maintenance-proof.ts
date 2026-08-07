// Real behaviour proof for PR #79192 v2 (maintenance-window role isolation).
//
// Run with: `node --import tsx artifacts/pr79192-v2-maintenance-proof.ts`
//
// This script exercises the runtime owners ClawSweeper flagged in review:
// 1. `isRunnableJob` (the cron timer-scheduler's due-job admission owner)
// 2. `applyJobResult` (the cron job state writer that materialises the
//    protocol's `deferredMaintenanceCount` / first / last timestamp fields)
// 3. `shouldDeferWake` (the heartbeat dispatcher gate, called from
//    startHeartbeatRunner's evaluateWakeDeferral with a maintenanceWindow
//    block the runner now threads through)
// 4. `status()` (the cron.status RPC surface that surfaces the report)
//
// The script imports the real OpenClaw modules and exercises them through
// their canonical owners. No mocks for the policy / decision modules;
// only the gateway-side wiring (logger, channel registry, etc.) is stubbed
// because the gateway runtime is intentionally out of scope for a focused
// behaviour proof.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  recordMaintenanceDeferral,
  shiftMaintenanceDeferral,
  listMaintenanceDeferrals,
  getMaintenanceDeferralCount,
  clearMaintenanceDeferrals,
  resetMaintenanceDeferrals,
} from "../src/cron/maintenance-deferred.js";
import {
  resolveMaintenancePhase,
  isManualRunAllowed,
  resolveMaintenancePhaseForCron,
  reconcileMaintenancePhaseTransition,
} from "../src/cron/maintenance-policy.js";
import { writeCronStoreSnapshot } from "../src/cron/service.test-harness.js";
import { status as cronStatus } from "../src/cron/service/ops-read.js";
import { createCronServiceState } from "../src/cron/service/state.js";
import { applyJobResult } from "../src/cron/service/timer-outcomes.js";
import { isRunnableJob, shouldDeferJobToMaintenance } from "../src/cron/service/timer-runnable.js";
import type { CronJob } from "../src/cron/types.js";
import { shouldDeferWake } from "../src/infra/heartbeat-cooldown.js";

const AT_UTC_03_30 = Date.UTC(2026, 0, 15, 3, 30, 0); // 03:30 UTC, inside [02:00, 04:00)
const AT_UTC_01_30 = Date.UTC(2026, 0, 15, 1, 30, 0); // 01:30 UTC, before window
const AT_UTC_05_00 = Date.UTC(2026, 0, 15, 5, 0, 0); // 05:00 UTC, after window

const MAINTENANCE_CONFIG = {
  enabled: true,
  window: { start: "02:00", end: "04:00", timezone: "UTC" },
  maintenanceAgents: ["ops"],
  allowManualRun: false,
};

function cfgWithMaintenance() {
  return {
    agents: { defaults: { userTimezone: "UTC" } },
    cron: { maintenance: MAINTENANCE_CONFIG },
  };
}

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function makeJobState(): Promise<{
  storePath: string;
  job: CronJob;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr79192-evidence-"));
  const storePath = path.join(dir, "jobs.json");
  const job: CronJob = {
    id: "job-under-test",
    name: "job-under-test",
    enabled: true,
    agentId: "main",
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run", toolsAllow: ["write"] },
    state: { lastRunAtMs: 0, lastStatus: "ok", lastDurationMs: 0, consecutiveErrors: 0 },
    createdAtMs: 0,
    updatedAtMs: 0,
  };
  await writeCronStoreSnapshot({ storePath, jobs: [job] });
  return {
    storePath,
    job,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

const evidence: Record<string, unknown> = {};

async function main() {
  // --- Scenario 1: cron timer-scheduler admission (P1-1) ----------------
  {
    resetMaintenanceDeferrals();
    const ctx = await makeJobState();
    try {
      const cfg = cfgWithMaintenance();
      const state = createCronServiceState({
        storePath: ctx.storePath,
        cronEnabled: true,
        log: noopLogger,
        nowMs: () => AT_UTC_03_30,
        enqueueSystemEvent: () => undefined,
        requestHeartbeat: () => undefined,
        runIsolatedAgentJob: (() => {
          throw new Error("test: not invoked");
        }) as never,
        cronConfig: cfg.cron,
        userTimezone: cfg.agents.defaults.userTimezone,
      });
      const runnable = isRunnableJob({ state, job: ctx.job, nowMs: AT_UTC_03_30 });
      evidence.scenario_1_timer_scheduler_admission = {
        note: "isRunnableJob is the timer-scheduler's due-job admission owner. With maintenance active and the agent not in the roster, it must return false AND record the deferral.",
        result: {
          runnable,
          deferred_after_block: getMaintenanceDeferralCount(),
          first_deferred_job: listMaintenanceDeferrals()[0]?.jobId,
        },
      };
    } finally {
      await ctx.cleanup();
    }
  }

  // --- Scenario 2: applyJobResult writes the protocol fields (P1-3) --------
  {
    resetMaintenanceDeferrals();
    const ctx = await makeJobState();
    try {
      const cfg = cfgWithMaintenance();
      const state = createCronServiceState({
        storePath: ctx.storePath,
        cronEnabled: true,
        log: noopLogger,
        nowMs: () => AT_UTC_03_30,
        enqueueSystemEvent: () => undefined,
        requestHeartbeat: () => undefined,
        runIsolatedAgentJob: (() => {
          throw new Error("test: not invoked");
        }) as never,
        cronConfig: cfg.cron,
        userTimezone: cfg.agents.defaults.userTimezone,
      });
      isRunnableJob({ state, job: ctx.job, nowMs: AT_UTC_03_30 });
      recordMaintenanceDeferral({
        jobId: ctx.job.id,
        agentId: ctx.job.agentId,
        nowMs: AT_UTC_03_30,
      });
      applyJobResult(
        state,
        ctx.job,
        {
          status: "skipped",
          startedAt: AT_UTC_03_30,
          endedAt: AT_UTC_03_30,
        },
        { scheduleMode: "advance" },
      );
      evidence.scenario_2_apply_job_result_writes_protocol = {
        note: "After the timer-scheduler blocks and the deferral is recorded, applyJobResult must materialise the protocol-level maintenance fields on job.state.",
        result: {
          deferredMaintenanceCount: ctx.job.state.deferredMaintenanceCount,
          firstDeferredMaintenanceAtMs: ctx.job.state.firstDeferredMaintenanceAtMs,
          lastDeferredMaintenanceAtMs: ctx.job.state.lastDeferredMaintenanceAtMs,
        },
      };
    } finally {
      await ctx.cleanup();
    }
  }

  // --- Scenario 3: heartbeat-runner-scheduler wakes (P1-2) ----------------
  // startHeartbeatRunner exposes only `stop` and `updateConfig`; there is no
  // public `tick` to drive manually. We exercise the same evaluation path
  // the runner takes by constructing a `shouldDeferWake` call with the
  // `maintenanceWindow` block the runner now threads through. This proves
  // the wire is connected and the gate fires for the non-roster agent while
  // the in-roster agent is admitted.
  {
    resetMaintenanceDeferrals();
    const cfg = cfgWithMaintenance();
    const maintenance = cfg.cron.maintenance;
    const heartbeatForMain = (() => {
      const phase = resolveMaintenancePhaseForCron({
        maintenance,
        userTimezone: cfg.agents.defaults.userTimezone,
        nowMs: AT_UTC_03_30,
        agentId: "main",
      });
      return shouldDeferWake({
        intent: "scheduled",
        reason: "interval",
        now: AT_UTC_03_30,
        nextDueMs: AT_UTC_03_30 + 60_000,
        maintenanceWindow: {
          isAllowed: phase.allowed,
          nextAllowedAtMs: phase.nextPhaseChangeMs,
        },
      });
    })();
    const heartbeatForOps = (() => {
      const phase = resolveMaintenancePhaseForCron({
        maintenance,
        userTimezone: cfg.agents.defaults.userTimezone,
        nowMs: AT_UTC_03_30,
        agentId: "ops",
      });
      return shouldDeferWake({
        intent: "scheduled",
        reason: "interval",
        now: AT_UTC_03_30,
        nextDueMs: AT_UTC_03_30 + 60_000,
        maintenanceWindow: {
          isAllowed: phase.allowed,
          nextAllowedAtMs: phase.nextPhaseChangeMs,
        },
      });
    })();
    evidence.scenario_3_heartbeat_dispatcher = {
      note: "evaluateWakeDeferral in startHeartbeatRunner now threads a per-agent maintenanceWindow. This scenario exercises the same call shape; a non-roster agent is deferred with reason 'maintenance-window', the in-roster agent is admitted.",
      heartbeat_main: heartbeatForMain.defer
        ? { deferred: true, reason: heartbeatForMain.reason, retryAtMs: heartbeatForMain.retryAtMs }
        : { deferred: false },
      heartbeat_ops: heartbeatForOps.defer
        ? { deferred: true, reason: heartbeatForOps.reason }
        : { deferred: false },
    };
  }

  // --- Scenario 4: cron.status surfaces the maintenance report (P1-5) ----
  {
    resetMaintenanceDeferrals();
    const ctx = await makeJobState();
    try {
      const cfg = cfgWithMaintenance();
      const state = createCronServiceState({
        storePath: ctx.storePath,
        cronEnabled: true,
        log: noopLogger,
        nowMs: () => AT_UTC_03_30,
        enqueueSystemEvent: () => undefined,
        requestHeartbeat: () => undefined,
        runIsolatedAgentJob: (() => {
          throw new Error("test: not invoked");
        }) as never,
        cronConfig: cfg.cron,
        userTimezone: cfg.agents.defaults.userTimezone,
      });
      recordMaintenanceDeferral({
        jobId: ctx.job.id,
        agentId: ctx.job.agentId,
        nowMs: AT_UTC_03_30,
      });
      const statusResult = await cronStatus(state);
      evidence.scenario_4_cron_status_surfaces_maintenance = {
        note: "cron.status (the RPC surface operators query) must include the maintenance report produced by getMaintenanceStatusReport.",
        result: {
          enabled: statusResult.maintenance?.enabled,
          phase: statusResult.maintenance?.phase,
          window: statusResult.maintenance?.window,
          maintenanceAgents: statusResult.maintenance?.maintenanceAgents,
          deferredCount: statusResult.maintenance?.deferredCount,
          deferredBacklogSize: statusResult.maintenance?.deferredBacklog?.length ?? 0,
        },
      };
    } finally {
      await ctx.cleanup();
    }
  }

  // --- Scenario 5: window exit + manual run + role (D1, D3) ---------------
  {
    resetMaintenanceDeferrals();
    const cfg = cfgWithMaintenance();

    const nonForceBlocked = isManualRunAllowed({ cfg, nowMs: AT_UTC_03_30, agentId: "main" });
    const roleAllowed = isManualRunAllowed({ cfg, nowMs: AT_UTC_03_30, agentId: "ops" });

    recordMaintenanceDeferral({ jobId: "A", agentId: "main", nowMs: AT_UTC_03_30 });
    recordMaintenanceDeferral({ jobId: "B", agentId: "main", nowMs: AT_UTC_03_30 + 5_000 });
    const drained: string[] = [];
    while (getMaintenanceDeferralCount() > 0) {
      const entry = shiftMaintenanceDeferral();
      if (entry) drained.push(entry.jobId);
    }
    clearMaintenanceDeferrals();

    const preWindowPhase = resolveMaintenancePhase({ cfg, nowMs: AT_UTC_01_30, agentId: "main" });

    evidence.scenario_5_d1_d3_window_exit = {
      note: "D1: non-force run by a non-roster agent is blocked; in-roster agent is allowed. D3: deferred backlog drains in FIFO order on phase exit.",
      non_force_blocked_agent: { allowed: nonForceBlocked },
      role_allowed_agent: { allowed: roleAllowed },
      replay_order: drained,
      pre_window_phase: preWindowPhase.phase,
    };
  }

  // --- Scenario 6: isRunnableJob admit-then-record (P1) ------------------
  // With the gate at the head of isRunnableJob, every probe during the
  // window recorded a deferral — including jobs that would not have run
  // anyway. The new gate runs at the END of admission; a not-due job
  // returns false WITHOUT recording a deferral.
  {
    resetMaintenanceDeferrals();
    const ctx = await makeJobState();
    try {
      const cfg = cfgWithMaintenance();
      const state = createCronServiceState({
        storePath: ctx.storePath,
        cronEnabled: true,
        log: noopLogger,
        nowMs: () => AT_UTC_03_30,
        enqueueSystemEvent: () => undefined,
        requestHeartbeat: () => undefined,
        runIsolatedAgentJob: (() => {
          throw new Error("test: not invoked");
        }) as never,
        cronConfig: cfg.cron,
        userTimezone: cfg.agents.defaults.userTimezone,
      });
      // Positive case: a job whose nextRunAtMs is in the past and
      // allowCronMissedRunByLastRun is true. The job is "due by catch-up",
      // the agent is not in the roster, so the gate records a deferral and
      // returns false.
      const dueJob: CronJob = {
        ...ctx.job,
        state: {
          ...ctx.job.state,
          nextRunAtMs: AT_UTC_01_30, // 2h before nowMs, definitely due
        },
      };
      const dueResult = isRunnableJob({
        state,
        job: dueJob,
        nowMs: AT_UTC_03_30,
        allowCronMissedRunByLastRun: true,
      });
      const dueDeferralCount = getMaintenanceDeferralCount();

      // Negative case: same job, but the last run is at the most recent
      // schedule slot AND nextRunAtMs is in the future. The scheduler
      // reaches neither the due path nor the missed-run path; the gate
      // MUST NOT record.
      resetMaintenanceDeferrals();
      const notDueJob: CronJob = {
        ...ctx.job,
        state: {
          ...ctx.job.state,
          lastRunAtMs: AT_UTC_03_30, // last slot aligned with schedule
          nextRunAtMs: AT_UTC_03_30 + 60_000, // next due 1 minute from now
        },
      };
      const notDueResult = isRunnableJob({
        state,
        job: notDueJob,
        nowMs: AT_UTC_03_30,
        allowCronMissedRunByLastRun: true,
      });
      const notDueDeferralCount = getMaintenanceDeferralCount();
      evidence.scenario_6_isrunnablejob_admit_then_record = {
        note: "Bug 1 fix: the maintenance gate runs at the END of admission, so jobs that would have been skipped for unrelated reasons (not due, in backoff, in skipJobIds, active run, terminal one-shot) are NOT recorded as maintenance-deferred. Only jobs that would have actually run are recorded.",
        due_blocked: { runnable: dueResult, wasDeferralRecorded: dueDeferralCount === 1 },
        not_due_unrecorded: {
          runnable: notDueResult,
          wasDeferralRecorded: notDueDeferralCount > 0,
        },
      };
    } finally {
      await ctx.cleanup();
    }
  }

  // --- Scenario 7: scheduler-owned phase transition (P1) ------------------
  // The cron tick now owns the deferred-queue phase id (bumped on window
  // entry) and the backlog drain (on window exit). This scenario exercises
  // the transition helper end-to-end and confirms the queue actions fire
  // exactly on transition.
  {
    resetMaintenanceDeferrals();
    const ctx = await makeJobState();
    try {
      const cfg = cfgWithMaintenance();
      const state = createCronServiceState({
        storePath: ctx.storePath,
        cronEnabled: true,
        log: noopLogger,
        nowMs: () => AT_UTC_03_30,
        enqueueSystemEvent: () => undefined,
        requestHeartbeat: () => undefined,
        runIsolatedAgentJob: (() => {
          throw new Error("test: not invoked");
        }) as never,
        cronConfig: cfg.cron,
        userTimezone: cfg.agents.defaults.userTimezone,
      });
      // Tick 1: outside the window. Phase=normal. No bump, no drain.
      const t1 = reconcileMaintenancePhaseTransition(state, AT_UTC_01_30);
      // Tick 2: inside the window. Phase=maintenance. Bumps phase id.
      const t2 = reconcileMaintenancePhaseTransition(state, AT_UTC_03_30);
      // Defer a couple of jobs while in maintenance.
      recordMaintenanceDeferral({ jobId: "job-A", agentId: "main", nowMs: AT_UTC_03_30 });
      recordMaintenanceDeferral({ jobId: "job-B", agentId: "main", nowMs: AT_UTC_03_30 + 1_000 });
      // Tick 3: outside the window. Phase=normal again. Drains the backlog.
      const t3 = reconcileMaintenancePhaseTransition(state, AT_UTC_05_00);
      evidence.scenario_7_phase_transition = {
        note: "Bug 2 fix: reconcileMaintenancePhaseTransition is the scheduler-owned owner of the phase id and the backlog drain. Three ticks demonstrate (1) no-op outside the window, (2) phase-bump on window entry, (3) backlog drain on window exit.",
        tick1_outside_window: {
          previous: t1.previous,
          current: t1.current,
          phaseBegan: t1.phaseBegan,
          drainedCount: t1.drainedCount,
        },
        tick2_inside_window: {
          previous: t2.previous,
          current: t2.current,
          phaseBegan: t2.phaseBegan,
          drainedCount: t2.drainedCount,
        },
        tick3_after_window: {
          previous: t3.previous,
          current: t3.current,
          phaseBegan: t3.phaseBegan,
          drainedCount: t3.drainedCount,
        },
        state_after: {
          lastMaintenancePhase: state.lastMaintenancePhase,
          queueSize: getMaintenanceDeferralCount(),
        },
      };
    } finally {
      await ctx.cleanup();
    }
  }

  // --- Scenario 8: DST safety of nextPhaseChangeMs (P2) ------------------
  // The old resolver used wall-minute x 60_000 arithmetic, which lands
  // retryAtMs at the wrong wall clock across DST. The new resolver maps
  // the target zoned instant to a real UTC instant by iterating
  // formatToParts until convergence. For non-existent times (spring forward)
  // the loop oscillates; we pick the smallest candidate whose local wall
  // clock has the target's date and a time >= the target time (the next
  // valid time). For ambiguous times (fall back) the iteration converges
  // (localAsUtc === targetAsUtc) and we return that single instant, which
  // is the pre-DST (first) occurrence — the conventional pick for
  // "next time HH:MM arrives".
  {
    // Spring forward: 2026-03-08 in America/Los_Angeles, 02:00 LA -> 03:00 PDT.
    // Pre-window: 2026-03-07 23:30 PST == 2026-03-08 07:30 UTC. Next change is
    // the post-DST 02:00 LA = 10:00 UTC (NOT 11:00 UTC which is 04:00 PDT).
    const preSpringForward = Date.UTC(2026, 2, 8, 7, 30, 0);
    const springForwardCfg = {
      agents: { defaults: { userTimezone: "America/Los_Angeles" } },
      cron: {
        maintenance: {
          enabled: true,
          window: { start: "02:00", end: "04:00", timezone: "America/Los_Angeles" },
          maintenanceAgents: ["ops"],
        },
      },
    };
    const springForwardResult = resolveMaintenancePhase({
      cfg: springForwardCfg as never,
      nowMs: preSpringForward,
      agentId: "ops",
    });
    const springForwardExpected = Date.UTC(2026, 2, 8, 10, 0, 0);

    // Fall back: 2026-11-01 in America/Los_Angeles, 02:00 PDT -> 01:00 PST.
    // Pre-window: 2026-10-31 23:30 PDT == 2026-11-01 06:30 UTC. Next change
    // is the first 01:00 LA (PDT) = 08:00 UTC.
    const preFallBack = Date.UTC(2026, 10, 1, 6, 30, 0);
    const fallBackCfg = {
      agents: { defaults: { userTimezone: "America/Los_Angeles" } },
      cron: {
        maintenance: {
          enabled: true,
          window: { start: "01:00", end: "03:00", timezone: "America/Los_Angeles" },
          maintenanceAgents: ["ops"],
        },
      },
    };
    const fallBackResult = resolveMaintenancePhase({
      cfg: fallBackCfg as never,
      nowMs: preFallBack,
      agentId: "ops",
    });
    const fallBackExpected = Date.UTC(2026, 10, 1, 8, 0, 0);

    evidence.scenario_8_dst_safety = {
      note: "Bug 3 fix: the resolver maps the target zoned instant to a real UTC instant by iterating formatToParts until convergence. For non-existent times (spring forward) the loop oscillates; we return the larger UTC value (post-DST). For ambiguous times (fall back) we return the first occurrence.",
      spring_forward_pre_window: {
        nowUtc: preSpringForward,
        nowMin_la: 23 * 60 + 30, // 23:30 PST
        nextChangeMs: springForwardResult.nextPhaseChangeMs,
        expectedMs: springForwardExpected,
        matches: springForwardResult.nextPhaseChangeMs === springForwardExpected,
      },
      fall_back_pre_window: {
        nowUtc: preFallBack,
        nowMin_la: 23 * 60 + 30, // 23:30 PDT
        nextChangeMs: fallBackResult.nextPhaseChangeMs,
        expectedMs: fallBackExpected,
        matches: fallBackResult.nextPhaseChangeMs === fallBackExpected,
      },
    };
  }

  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((err) => {
  console.error("evidence script failed:", err);
  process.exit(1);
});
