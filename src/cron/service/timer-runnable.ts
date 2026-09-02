import { recordMaintenanceDeferral } from "../maintenance-deferred.js";
import { resolveMaintenancePhaseForCron } from "../maintenance-policy.js";
import { parseAbsoluteTimeMs } from "../parse.js";
import type { CronJob } from "../types.js";
import {
  computeJobPreviousRunAtOrBeforeMs,
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  hasActiveCronRun,
  hasScheduledNextRunAtMs,
  isJobEnabled,
  resolveJobErrorBackoffUntilMs,
  resolveJobLastRunStatus,
} from "./jobs.js";
import type { CronServiceState } from "./state.js";
import { isScheduledTerminalOneShotRetry } from "./timer-trigger.js";

/**
 * Reports whether a cron job's last completed run is older than its previous
 * effective slot, which is how restart catch-up detects a missed run once
 * nextRunAtMs has already advanced past it.
 */
export function hasMissedCronSlotSinceLastRun(job: CronJob, nowMs: number): boolean {
  const lastRunAtMs = job.state.lastRunAtMs;
  // Only replay a "missed slot" when there is concrete run history.
  if (typeof lastRunAtMs !== "number" || !Number.isFinite(lastRunAtMs)) {
    return false;
  }
  let previousRunAtMs: number | undefined;
  try {
    previousRunAtMs = computeJobPreviousRunAtOrBeforeMs(job, nowMs);
  } catch {
    return false;
  }
  if (
    typeof previousRunAtMs !== "number" ||
    !Number.isFinite(previousRunAtMs) ||
    previousRunAtMs <= lastRunAtMs
  ) {
    return false;
  }
  // Slots computed from freshly edited scheduling inputs never existed before
  // those inputs took effect, so they are not missed runs. lastRunAtMs belongs
  // to the retired schedule and would otherwise stay stale forever (#91944).
  const activatedAtMs = job.state.scheduleActivatedAtMs;
  if (typeof activatedAtMs !== "number" || !Number.isFinite(activatedAtMs)) {
    return true;
  }
  return previousRunAtMs > activatedAtMs;
}

/**
 * Returns `true` and records a maintenance deferral when the supplied job
 * would have run *but* its agent is currently blocked by an active maintenance
 * window. Returns `false` for jobs that are not maintenance-blocked (either
 * because the window is inactive, the agent is in the maintenance roster, or
 * the maintenance block is not configured at all).
 *
 * This is intentionally a *post-admission* check: the caller has already
 * verified the job is enabled, due, not skipped, not already running, and
 * not in error backoff. Recording a deferral only when the job would
 * otherwise have run keeps the diagnostics and replay queue aligned with the
 * set of work that was actually held, instead of being polluted by jobs
 * that would have been skipped for unrelated reasons.
 */
export function shouldDeferJobToMaintenance(
  state: CronServiceState,
  job: CronJob,
  nowMs: number,
): boolean {
  const maintenance = state.deps.cronConfig?.maintenance;
  if (!maintenance?.enabled) {
    return false;
  }
  const agentId = job.agentId ?? state.deps.defaultAgentId ?? "main";
  const phase = resolveMaintenancePhaseForCron({
    maintenance,
    userTimezone: state.deps.userTimezone,
    nowMs,
    agentId,
  });
  if (phase.phase === "maintenance" && !phase.allowed) {
    recordMaintenanceDeferral({ jobId: job.id, agentId, nowMs });
    // Mirror the reason onto the job's persisted state immediately so an
    // external monitor can read `lastDeferralReason` during the hold,
    // not just after the phase exits. The phase-exit mirror in
    // `reconcileMaintenancePhaseTransition` will overwrite this with the
    // same value, so there's no double-write hazard.
    if (!job.state) {
      job.state = {};
    }
    job.state.lastDeferralReason = "maintenance_window";
    return true;
  }
  return false;
}

export function isRunnableJob(params: {
  state: CronServiceState;
  job: CronJob;
  nowMs: number;
  skipJobIds?: ReadonlySet<string>;
  skipAtIfAlreadyRan?: boolean;
  allowCronMissedRunByLastRun?: boolean;
}): boolean {
  const { job, nowMs } = params;
  if (!job.state) {
    job.state = {};
  }
  if (!isJobEnabled(job)) {
    return false;
  }
  if (params.skipJobIds?.has(job.id)) {
    return false;
  }
  if (hasActiveCronRun(job)) {
    return false;
  }
  const lastRunStatus = resolveJobLastRunStatus(job);
  if (params.skipAtIfAlreadyRan && job.schedule.kind === "at" && lastRunStatus) {
    const lastRun = job.state.lastRunAtMs;
    const nextRun = job.state.nextRunAtMs;
    // Terminal history belongs to the old occurrence. A matching newer
    // one-shot still owns its scheduled catch-up after a restart.
    if (
      typeof lastRun === "number" &&
      typeof nextRun === "number" &&
      nextRun > lastRun &&
      parseAbsoluteTimeMs(job.schedule.at) === nextRun
    ) {
      if (shouldDeferJobToMaintenance(params.state, job, nowMs)) {
        return false;
      }
      return nowMs >= nextRun;
    }
    // Other terminal one-shots stay consumed unless their owner explicitly
    // scheduled a failed/skipped retry (#24355, #91775).
    if (isScheduledTerminalOneShotRetry(job, lastRunStatus, lastRun, nextRun)) {
      if (shouldDeferJobToMaintenance(params.state, job, nowMs)) {
        return false;
      }
      return typeof nextRun === "number" && nowMs >= nextRun;
    }
    return false;
  }
  const next = job.state.nextRunAtMs;
  if (isErrorBackoffPending(params.state, job, nowMs)) {
    // Error retry windows are anchored at run end; persisted start-based
    // retry timestamps from older state must not bypass active backoff.
    return false;
  }
  if (hasScheduledNextRunAtMs(next) && nowMs >= next) {
    const lastRunAtMs = job.state.lastRunAtMs;
    // Startup loads persisted state before maintenance recompute. Suppress a
    // completed stale slot, but still replay a newer slot due by restart time.
    const alreadyCompletedDueCronSlot =
      params.allowCronMissedRunByLastRun &&
      job.schedule.kind === "cron" &&
      (lastRunStatus === "ok" || lastRunStatus === "skipped") &&
      typeof lastRunAtMs === "number" &&
      Number.isFinite(lastRunAtMs) &&
      lastRunAtMs >= next;
    if (!alreadyCompletedDueCronSlot) {
      if (shouldDeferJobToMaintenance(params.state, job, nowMs)) {
        return false;
      }
      return true;
    }
    let latestRunAtMs: number | undefined;
    try {
      latestRunAtMs = computeJobPreviousRunAtOrBeforeMs(job, nowMs);
    } catch {
      return false;
    }
    if (typeof latestRunAtMs === "number" && latestRunAtMs > lastRunAtMs) {
      if (shouldDeferJobToMaintenance(params.state, job, nowMs)) {
        return false;
      }
      return true;
    }
    return false;
  }
  if (!params.allowCronMissedRunByLastRun || job.schedule.kind !== "cron") {
    return false;
  }
  if (!hasMissedCronSlotSinceLastRun(job, nowMs)) {
    return false;
  }
  if (shouldDeferJobToMaintenance(params.state, job, nowMs)) {
    return false;
  }
  return true;
}

function isErrorBackoffPending(_state: CronServiceState, job: CronJob, nowMs: number): boolean {
  if (job.schedule.kind === "at" || resolveJobLastRunStatus(job) !== "error") {
    return false;
  }
  const backoffUntilMs = resolveJobErrorBackoffUntilMs(job, DEFAULT_ERROR_BACKOFF_SCHEDULE_MS);
  return backoffUntilMs !== undefined && nowMs < backoffUntilMs;
}

export function collectRunnableJobs(
  state: CronServiceState,
  nowMs: number,
  opts?: {
    skipJobIds?: ReadonlySet<string>;
    skipAtIfAlreadyRan?: boolean;
    allowCronMissedRunByLastRun?: boolean;
  },
): CronJob[] {
  if (!state.store) {
    return [];
  }
  const admitted = state.store.jobs.filter((job) =>
    isRunnableJob({
      state,
      job,
      nowMs,
      skipJobIds: opts?.skipJobIds,
      skipAtIfAlreadyRan: opts?.skipAtIfAlreadyRan,
      allowCronMissedRunByLastRun: opts?.allowCronMissedRunByLastRun,
    }),
  );
  // FIFO replay ordering: jobs deferred by the maintenance window have
  // `pendingMaintenanceReplayAtMs` set by the phase-exit mirror. The
  // replay MUST preserve the deferral order so the contract advertised
  // in the operator docs is honoured. The replay is a ONE-SHOT —
  // `pendingMaintenanceReplayAtMs` is cleared on the first tick that
  // admits the deferred job (here), so a recurring job deferred once
  // does not outrank ordinary due jobs on later windows. The
  // historical `lastDeferredMaintenanceAtMs` (which is the per-job
  // diagnostic count anchor) is NEVER used for ordering; using it
  // here would make the field permanent replay priority, which is
  // the cycle 5d [P1] regression.
  const hasReplay = admitted.some(
    (job) => typeof job.state?.pendingMaintenanceReplayAtMs === "number",
  );
  if (hasReplay) {
    const sorted = [...admitted].toSorted((a, b) => {
      const aDef = a.state?.pendingMaintenanceReplayAtMs;
      const bDef = b.state?.pendingMaintenanceReplayAtMs;
      const aHas = typeof aDef === "number";
      const bHas = typeof bDef === "number";
      if (aHas && bHas) {
        return (aDef as number) - (bDef as number);
      }
      if (aHas) {
        return -1;
      }
      if (bHas) {
        return 1;
      }
      return (a.state?.nextRunAtMs ?? 0) - (b.state?.nextRunAtMs ?? 0);
    });
    // Clear the transient replay priority on every admitted job, so
    // the next tick uses ordinary `nextRunAtMs` ordering. The
    // historical diagnostics (`lastDeferredMaintenanceAtMs`,
    // `deferredMaintenanceCount`) are preserved.
    for (const job of sorted) {
      if (typeof job.state?.pendingMaintenanceReplayAtMs === "number") {
        job.state.pendingMaintenanceReplayAtMs = null;
      }
    }
    return sorted;
  }
  return admitted;
}
