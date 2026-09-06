// Resolves the maintenance phase for a given (config, time, agent).
//
// Maintenance is the inverse of active-hours: when the local wall clock is inside
// `cron.maintenance.window`, only agents listed in `cron.maintenance.maintenanceAgents`
// may run scheduled and manual cron jobs. Heartbeat wakes for non-maintenance agents
// are deferred through the `shouldDeferWake` maintenance branch.
//
// v2 scope (deliberate, not a bug):
//   * Single-day windows only (`start < end`). Cross-midnight windows are rejected
//     by the zod schema; this module does not defend against them defensively.
//   * `maintenanceAgents` empty / missing => all agents are deferred during the
//     window. Opt-in list semantics, not opt-out.
//   * `allowManualRun` (default false) toggles whether `cron run` / `automations run`
//     may bypass the gate. Scheduled and heartbeat runs are never affected by
//     this flag.
//
// Helpers are intentionally duplicated from `heartbeat-active-hours` (a copy of
// `parseActiveHoursTime` and a small wall-clock minute resolver) because the
// semantics differ enough to share a single module would invert the call site's
// meaning. The duplication is bounded and called out in the module header.
import { resolveUserTimezone } from "../agents/date-time.js";
import type { CronMaintenanceConfig } from "../config/types.cron.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";

const ACTIVE_HOURS_TIME_PATTERN = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;

export type MaintenancePhase = "normal" | "maintenance";

export type MaintenancePhaseDecision = {
  /** Current phase based on the resolved window. */
  phase: MaintenancePhase;
  /**
   * Whether the supplied agent is allowed to run in the current phase. Always
   * `true` when the phase is `normal`; for `maintenance` it reflects role
   * membership in `maintenanceAgents`.
   */
  allowed: boolean;
  /**
   * Wall-clock instant at which the phase will next change. `undefined` when
   * the maintenance block is disabled or the window cannot be resolved.
   */
  nextPhaseChangeMs?: number;
  /**
   * Short reason string for logs / status reports. Stable; safe to surface in
   * the public `cron.status` JSON.
   */
  reason?: string;
};

/** Parse "HH:MM" (24h) into minutes since midnight, or null on invalid input. */
function parseMaintenanceTime(raw?: string): number | null {
  if (!raw || !ACTIVE_HOURS_TIME_PATTERN.test(raw)) {
    return null;
  }
  const [hourStr, minuteStr] = raw.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  if (hour === 24) {
    // 24:00 is "next-day midnight" — interpret as 1440 minutes; the comparison
    // math below treats end-exclusive semantics, so 24:00 == end of day.
    return minute === 0 ? 24 * 60 : null;
  }
  return hour * 60 + minute;
}

function resolveMaintenanceTimezone(cfg: OpenClawConfig, raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "user") {
    return resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
  }
  if (trimmed === "local") {
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return host?.trim() || "UTC";
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
  }
}

function resolveMinutesInTimeZone(nowMs: number, formatter: Intl.DateTimeFormat): number | null {
  try {
    const parts = formatter.formatToParts(new Date(nowMs));
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        map[part.type] = part.value;
      }
    }
    const hour = Number(map.hour);
    const minute = Number(map.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

function getMaintenanceConfig(cfg: OpenClawConfig): CronMaintenanceConfig | undefined {
  return cfg.cron?.maintenance;
}

/** A maintenance role roster normalised to the lowercase agent id form. */
function normaliseRoster(roster: readonly string[] | undefined): Set<string> | null {
  if (!roster) {
    return null;
  }
  return new Set(roster.map((id) => normalizeAgentId(id)));
}

function isAgentInRoster(agentId: string, roster: Set<string> | null): boolean {
  if (roster === null) {
    return false; // null means "no roster configured"; caller decides what that implies
  }
  return roster.has(normalizeAgentId(agentId));
}

/**
 * Build a function that, given a wall-clock instant, returns the minutes-of-day
 * in the configured maintenance timezone. The Intl.DateTimeFormat is cached
 * because schedule probes call this thousands of times per heartbeat tick.
 */
function buildMinutesFormatter(timezone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return null;
  }
}

/**
 * Resolve the (year, month, day) of `nowMs` in the supplied IANA timezone, or
 * `null` if the formatter cannot answer (invalid timezone, etc.). The result is
 * the wall-clock calendar day, not the UTC date.
 */
function resolveDateInTimezone(
  nowMs: number,
  timezone: string,
): { year: number; month: number; day: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(nowMs));
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        map[part.type] = part.value;
      }
    }
    const year = Number(map.year);
    const month = Number(map.month);
    const day = Number(map.day);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return null;
    }
    return { year, month, day };
  } catch {
    return null;
  }
}

/**
 * Convert a (year, month, day, hour, minute) tuple interpreted as a wall-clock
 * instant in the supplied IANA `timezone` to the equivalent epoch ms. Returns
 * `null` on formatter failure.
 *
 * DST handling: the offset depends on the resolved UTC instant, so the resolver
 * iterates from a naive-UTC guess until the formatted local wall clock matches
 * the target. For non-existent times (spring-forward gap) the loop oscillates
 * between the pre- and post-transition UTC values; we then return the larger of
 * the two, which corresponds to the post-DST wall clock (i.e. the first valid
 * `>= target` instant). For ambiguous times (fall-back overlap) the two values
 * are the two real occurrences of the wall clock; the larger is the
 * post-transition (= first occurrence, before the clock is wound back) one,
 * which is the conventional pick for "next time HH:MM arrives".
 */
function zonedDateTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number | null {
  try {
    const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
    const visited = new Set<number>([targetAsUtc]);
    let candidate = targetAsUtc;
    for (let i = 0; i < 4; i++) {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(candidate));
      const map: Record<string, string> = {};
      for (const part of parts) {
        if (part.type !== "literal") {
          map[part.type] = part.value;
        }
      }
      const localAsUtc = Date.UTC(
        Number(map.year),
        Number(map.month) - 1,
        Number(map.day),
        Number(map.hour),
        Number(map.minute),
      );
      // Convergence: the local wall clock at `candidate` matches the target.
      if (localAsUtc === targetAsUtc) {
        return candidate;
      }
      const offsetMs = localAsUtc - candidate;
      const next = targetAsUtc - offsetMs;
      if (visited.has(next)) {
        // Oscillating: the target wall clock is non-existent (spring forward)
        // or ambiguous (fall back). The naive guess (`targetAsUtc`) and the
        // iteration candidates may land on different *dates* in the target
        // timezone, so a pure max-in-UTC comparison can pick the wrong
        // instant when the naive guess crosses a day boundary in a positive
        // UTC-offset timezone (e.g. southern-hemisphere spring forward:
        // naive 02:00 UTC == 13:00 AEDT the NEXT day, well past the window).
        //
        // For a non-existent time, the "next valid" candidate is the one whose
        // local wall clock has the target's *date* and a time >= the target
        // time. We pick the smallest such candidate; the targetAsUtc itself
        // is excluded if its formatted date does not match.
        const totalTargetMin = hour * 60 + minute;
        let best: number | null = null;
        for (const candidateMs of visited) {
          const cParts = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).formatToParts(new Date(candidateMs));
          const cMap: Record<string, string> = {};
          for (const p of cParts) {
            if (p.type !== "literal") {
              cMap[p.type] = p.value;
            }
          }
          if (
            Number(cMap.year) !== year ||
            Number(cMap.month) !== month ||
            Number(cMap.day) !== day
          ) {
            continue;
          }
          const cTotal = Number(cMap.hour) * 60 + Number(cMap.minute);
          if (cTotal < totalTargetMin) {
            continue;
          }
          if (best === null || candidateMs < best) {
            best = candidateMs;
          }
        }
        if (best !== null) {
          return best;
        }
        // Fallback for the ambiguous-but-not-non-existent case: pick the
        // largest UTC value, which is the pre-DST (first) occurrence.
        let max = targetAsUtc;
        for (const v of visited) {
          if (v > max) {
            max = v;
          }
        }
        return max;
      }
      visited.add(next);
      candidate = next;
    }
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Compute the next epoch ms at which the wall-clock in `timezone` reaches
 * `targetMin` minutes-of-day. If today's target has already passed, returns
 * tomorrow's target. Falls back to "24h from now" on any formatter failure so
 * the caller never blocks forever on a bad config.
 *
 * DST-safe: this does NOT use wall-minute × 60_000 arithmetic, which can be
 * off by an hour when the wall clock skips forward or back. The instant is
 * always resolved as a real zoned boundary and then mapped to UTC.
 */
function computeNextChangeMs(nowMs: number, targetMin: number, timezone: string): number {
  const safeFallback = nowMs + 24 * 60 * 60 * 1000;
  const date = resolveDateInTimezone(nowMs, timezone);
  if (!date) {
    return safeFallback;
  }
  const targetHour = Math.floor(targetMin / 60);
  const targetMinute = targetMin % 60;
  let target = zonedDateTimeToUtcMs(
    date.year,
    date.month,
    date.day,
    targetHour,
    targetMinute,
    timezone,
  );
  if (target === null || target <= nowMs) {
    // Roll to tomorrow. UTC arithmetic on the calendar date is safe because
    // we are advancing the day, not computing a clock face minute.
    const tomorrow = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
    target = zonedDateTimeToUtcMs(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      targetHour,
      targetMinute,
      timezone,
    );
    if (target === null) {
      return safeFallback;
    }
  }
  return target;
}

/**
 * Resolve the maintenance phase and role decision for one agent at one moment.
 *
 * Default behaviour (when `cron.maintenance` is not configured or `enabled` is
 * false): returns `{phase: 'normal', allowed: true}` with no `nextPhaseChangeMs`.
 * Operators can opt into maintenance by setting `cron.maintenance.enabled = true`
 * and a valid `window`. A window with malformed times is treated as "not
 * configured" — same fallback as active-hours — so a bad config never blocks
 * work, only a deliberate one does.
 */
export function resolveMaintenancePhase(params: {
  cfg: OpenClawConfig;
  nowMs: number;
  agentId: string;
}): MaintenancePhaseDecision {
  const maintenance = getMaintenanceConfig(params.cfg);
  if (!maintenance?.enabled) {
    return { phase: "normal", allowed: true };
  }
  const window = maintenance.window;
  if (!window?.start || !window?.end) {
    // Permissive fallback: a half-configured window cannot block anything.
    return { phase: "normal", allowed: true, reason: "maintenance.window.incomplete" };
  }
  const startMin = parseMaintenanceTime(window.start);
  const endMin = parseMaintenanceTime(window.end);
  if (startMin === null || endMin === null) {
    return { phase: "normal", allowed: true, reason: "maintenance.window.invalid" };
  }
  // Defensive: schema already rejects start >= end, but if anything slips
  // through (e.g. doctor migrating old config) we treat it as not-maintenance.
  if (startMin >= endMin) {
    return { phase: "normal", allowed: true, reason: "maintenance.window.invalid-range" };
  }
  const timezone = resolveMaintenanceTimezone(params.cfg, window.timezone);
  const formatter = buildMinutesFormatter(timezone);
  if (!formatter) {
    return { phase: "normal", allowed: true, reason: "maintenance.timezone.invalid" };
  }
  const nowMin = resolveMinutesInTimeZone(params.nowMs, formatter);
  if (nowMin === null) {
    return { phase: "normal", allowed: true, reason: "maintenance.now.unresolvable" };
  }

  const inWindow = nowMin >= startMin && nowMin < endMin;
  if (!inWindow) {
    return {
      phase: "normal",
      allowed: true,
      nextPhaseChangeMs: computeNextChangeMs(params.nowMs, startMin, timezone),
    };
  }

  const roster = normaliseRoster(maintenance.maintenanceAgents);
  const inRoster = isAgentInRoster(params.agentId, roster);
  // Per D4: empty / missing roster => all agents deferred.
  const allowed = roster !== null && inRoster;
  return {
    phase: "maintenance",
    allowed,
    nextPhaseChangeMs: computeNextChangeMs(params.nowMs, endMin, timezone),
    reason: allowed ? "maintenance.role-allowed" : "maintenance.role-blocked",
  };
}

/** Convenience: returns just the phase string for callers that don't need details. */
export function getMaintenancePhase(cfg: OpenClawConfig, nowMs: number): MaintenancePhase {
  // Use a sentinel agent id because phase-only callers don't care about role.
  // main is a stable choice because it's always a valid agent id and the
  // default roster never includes it.
  return resolveMaintenancePhase({ cfg, nowMs, agentId: "__phase_probe__" }).phase;
}

/** Whether the supplied agent may run *manual* cron/automation runs at this instant. */
export function isManualRunAllowed(params: {
  cfg: OpenClawConfig;
  nowMs: number;
  agentId: string;
}): boolean {
  const decision = resolveMaintenancePhase(params);
  if (decision.phase === "normal") {
    return true;
  }
  // D1: allowManualRun toggles the gate for manual runs only.
  return Boolean(params.cfg.cron?.maintenance?.allowManualRun) || decision.allowed;
}

/**
 * Cron-service-flavoured wrapper. Accepts the minimum the cron service has
 * (a `CronConfig`-shaped maintenance block plus an explicit userTimezone)
 * without forcing the gateway to thread a full `OpenClawConfig` through
 * `CronServiceDeps`. Use this from inside the cron service modules.
 */
export function resolveMaintenancePhaseForCron(params: {
  maintenance: CronMaintenanceConfig | undefined;
  userTimezone: string | undefined;
  nowMs: number;
  agentId: string;
}): MaintenancePhaseDecision {
  if (!params.maintenance) {
    return { phase: "normal", allowed: true };
  }
  return resolveMaintenancePhase({
    cfg: {
      agents: { defaults: { userTimezone: params.userTimezone } },
      cron: { maintenance: params.maintenance },
    } as OpenClawConfig,
    nowMs: params.nowMs,
    agentId: params.agentId,
  });
}

// ---------------------------------------------------------------------------
// Scheduler-owned phase transition reconciliation.
//
// The maintenance phase can change between two cron ticks (e.g. the window
// opens at 02:00 LA, the next tick after 02:00 sees phase=maintenance for the
// first time; the tick after 04:00 LA sees phase=normal again). The deferred
// queue has two pieces of state that depend on which phase we are in:
//
//   * active phase id: bumped every time the window opens, so a backfilled
//     deferral can be distinguished from a fresh one.
//   * backlog entries: cleared when the window closes, so a stale entry from
//     a previous window does not leak into the next.
//
// The cron timer tick owns both transitions; without it, `beginMaintenancePhase`
// and `clearMaintenanceDeferrals` would never be called, and the deferred
// queue's contract would be violated silently. `reconcileMaintenancePhaseTransition`
// is idempotent: calling it on every tick is cheap, and only the *transition*
// (previous != current) does work.

import {
  beginMaintenancePhase,
  clearMaintenanceDeferrals,
  listMaintenanceDeferrals,
} from "./maintenance-deferred.js";
import type { CronServiceState } from "./service/state.js";
import { saveCronStore } from "./store.js";

export type MaintenancePhaseTransition = {
  previous: MaintenancePhase | undefined;
  current: MaintenancePhase;
  /** Number of entries drained on a maintenance -> normal transition. */
  drainedCount: number;
  /** True if a normal -> maintenance transition bumped the phase id. */
  phaseBegan: boolean;
};

/**
 * Inspect the maintenance phase at `nowMs`, compare to the state's last known
 * phase, and apply the appropriate queue action:
 *
 *   - undefined -> anything: just record the current phase.
 *   - normal -> maintenance: bump the phase id so subsequent deferrals bind
 *     to the new window.
 *   - maintenance -> normal: drain the deferred backlog in FIFO order, then
 *     clear the queue. The scheduler's next tick re-evaluates the job store
 *     and admits any due jobs naturally.
 *   - same -> same: no-op.
 */
export async function reconcileMaintenancePhaseTransition(
  state: CronServiceState,
  nowMs: number,
): Promise<MaintenancePhaseTransition> {
  const decision = resolveMaintenancePhaseForCron({
    maintenance: state.deps.cronConfig?.maintenance,
    userTimezone: state.deps.userTimezone,
    nowMs,
    agentId: "__phase_probe__",
  });
  const current: MaintenancePhase = decision.phase;
  const previous = state.lastMaintenancePhase;

  let drainedCount = 0;
  let phaseBegan = false;

  if (previous !== current) {
    if (current === "maintenance") {
      // normal (or undefined) -> maintenance: bump the phase id so subsequent
      // deferrals bind to the new window, and record the wall-clock instant
      // the phase began. The phase-exit reconciler uses this to compute the
      // actual hold duration for each held job.
      beginMaintenancePhase(nowMs);
      state.maintenancePhaseEnteredAtMs = nowMs;
      phaseBegan = true;
    } else if (previous === "maintenance") {
      // maintenance -> normal: replay the held-backlog in FIFO order.
      //
      // For each held entry we:
      //   1. Mirror the maintenance diagnostics (deferredMaintenanceCount
      //      and the first/lastDeferred timestamps) into job.state. The
      //      mirror is the canonical producer — applyJobResult does NOT
      //      re-mirror the queue, so a job that runs on the exit tick is
      //      counted exactly once.
      //   2. Reset `nextRunAtMs` to `Math.max(entry.lastDeferredAtMs, nowMs - 1)`
      //      so the next scheduler tick admits the job through the normal
      //      admission path. The `lastDeferredAtMs` anchor preserves FIFO
      //      order across the replay (jobs deferred earlier are admitted
      //      earlier; jobs deferred later have a strictly greater anchor).
      //   3. `collectRunnableJobs` sorts by `lastDeferredMaintenanceAtMs`
      //      ascending so the FIFO replay order is enforced even when the
      //      store's natural order would differ.
      //
      // The mirror MUST happen BEFORE the queue clear so the per-job
      // fields reflect the work that was held. We deliberately do NOT
      // drain on `undefined -> normal`: a stale entry that survived a
      // service restart is the responsibility of the restart recovery,
      // not the phase transition.
      const held = listMaintenanceDeferrals();
      drainedCount = held.length;
      if (state.store) {
        for (const entry of held) {
          const job = state.store.jobs.find((j) => j.id === entry.jobId);
          if (!job) {
            continue;
          }
          if (!job.state) {
            job.state = {};
          }
          job.state.deferredMaintenanceCount = (job.state.deferredMaintenanceCount ?? 0) + 1;
          job.state.firstDeferredMaintenanceAtMs = entry.firstDeferredAtMs;
          job.state.lastDeferredMaintenanceAtMs = entry.lastDeferredAtMs;
          // Closed-enum reason so external monitors can distinguish
          // "deferred by maintenance policy" from "silently dead" (a
          // schedule that has gone stale and no longer fires). The
          // timestamp-only protocol cannot tell the two apart without
          // this field — every deferral reason is recorded here.
          job.state.lastDeferralReason = "maintenance_window";
          // Estimated number of schedule ticks owed while this job was
          // held. For `{kind: "every"}` schedules we can compute an
          // exact estimate; for cron-syntax or event-driven schedules
          // we fall back to a conservative ballpark and flag it. This
          // is what an external monitor actually wants when it asks
          // "did 12 ticks get skipped?".
          //
          // The hold duration is the intersection of the maintenance
          // window and the job's deferral history. We use the larger of
          // (entry.lastDeferredAtMs - entry.firstDeferredAtMs) and
          // (nowMs - state.maintenancePhaseEnteredAtMs) so a job
          // deferred once at the start of a 3-hour window reports the
          // full 3 hours, not 0. The `phaseEnteredAtMs` field is
          // recorded when the phase begins and cleared when it exits
          // (see the `previous === "maintenance"` branch above).
          const phaseEnteredAtMs = state.maintenancePhaseEnteredAtMs;
          const holdMs = Math.max(
            0,
            entry.lastDeferredAtMs - entry.firstDeferredAtMs,
            phaseEnteredAtMs !== null && phaseEnteredAtMs !== undefined
              ? nowMs - phaseEnteredAtMs
              : 0,
          );
          const estimate = estimateMissedScheduleTicks(job.schedule, holdMs);
          if (estimate !== undefined) {
            job.state.missedScheduleTicksEstimate = estimate.count;
            job.state.missedScheduleTicksEstimateIsApproximate = estimate.approximate;
            // Coalesced count: how many of the missed ticks were
            // intentionally suppressed without replay. The held queue
            // is deduped (one entry per job per phase) and the replay
            // anchor below is `lastDeferredAtMs`, so a held job is
            // admitted exactly once at phase exit. Therefore:
            //   coalesced = max(0, estimate.count - 1) for periodic
            //               jobs whose schedule fires repeatedly
            //               (the replay absorbs one of the owed slots)
            //   coalesced = 0 for `at` jobs (the estimate is 1, the
            //               replay either runs the at-once or
            //               supersedes the missed target instant;
            //               either way one slot is consumed by the
            //               replay and the rest were never owed
            //               because `at` only fires once)
            //
            // The `at`-is-always-1 case is why `estimate.count - 1`
            // is safe: for `at` schedules the estimate is 1 (one owed
            // slot), the replay consumes that slot, and the
            // coalesced count is 0 — matching the fact that the
            // replay covered the only owed work.
            //
            // See `src/cron/maintenance-coalescing.test.ts` for the
            // tri-fold coverage (functional, edge, regression).
            job.state.lastMaintenanceCoalescedCount = Math.max(0, estimate.count - 1);
          }
          // Transient replay priority: the collector uses this field
          // (NOT the persistent `lastDeferredMaintenanceAtMs`) for the
          // FIFO replay sort. The field is cleared after the deferred
          // job is admitted so a recurring job deferred once does not
          // outrank ordinary due jobs on later windows. See
          // `collectRunnableJobs` in `service/timer-runnable.ts`.
          job.state.pendingMaintenanceReplayAtMs = entry.lastDeferredAtMs;
          // Replay anchor: ensure the job is due so the next scheduler
          // tick admits it through the normal admission path. We use
          // `lastDeferredAtMs` as the floor (not `firstDeferredAtMs`) so
          // the natural admission sort is stable across the replay.
          const replayAnchor = Math.max(entry.lastDeferredAtMs, nowMs - 1);
          if (typeof job.state.nextRunAtMs !== "number" || job.state.nextRunAtMs > replayAnchor) {
            job.state.nextRunAtMs = replayAnchor;
          }
        }
      }
      // Note: do NOT clear the deferred queue here. The queue is
      // cleared AFTER the durable save succeeds (see below) so a save
      // failure can be retried from the in-memory queue rather than
      // relying on the on-disk snapshot to be authoritative. Closes
      // cycle 6 [P1] "Clear deferred work only after its durable save
      // succeeds".
    }
    // undefined -> normal: no-op (no bump, no drain). The first tick just
    // records the current phase.
  }

  state.lastMaintenancePhase = current;
  // Clear the phase-entered sentinel so a stale value cannot leak into
  // the next maintenance phase. Set again on the next normal ->
  // maintenance transition (the `current === "maintenance"` branch
  // above).
  if (previous === "maintenance" && current === "normal") {
    state.maintenancePhaseEnteredAtMs = null;
  }

  // ClawSweeper cycle 5d [P1] "Persist phase-exit replay before clearing
  // its queue": the replay-anchor writes and the per-job diagnostics must
  // survive the next store reload. Without this, a manual-run preflight
  // or hot-reload that triggers `ensureLoaded({ forceReload: true })`
  // would re-read the on-disk snapshot, lose the in-memory mutations,
  // and the deferred jobs would never be replayed. The cron store is
  // authoritative across reloads.
  //
  // Closes cycle 6 [P1] "Clear deferred work only after its durable save
  // succeeds" by ordering the save FIRST and the queue clear SECOND.
  // On save failure, the in-memory queue is retained and a future tick
  // can re-attempt the drain; on save success, the queue is cleared.
  if (drainedCount > 0 && previous === "maintenance") {
    if (state.store && state.deps.storePath) {
      let saveSucceeded = false;
      try {
        await saveCronStore(state.deps.storePath, state.store);
        saveSucceeded = true;
      } catch (err) {
        // Persist failure is non-fatal for the in-memory state: the
        // scheduler still has the mutations in `state.store.jobs` and the
        // diagnostics are already applied. A future force-reload may
        // re-load the pre-replay snapshot, but the queue is still
        // populated so the next reconciliation tick can re-mirror. Log
        // and continue.
        state.deps.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "cron: maintenance phase-exit persist failed; in-memory state retained, queue NOT cleared",
        );
      }
      if (saveSucceeded) {
        // Save succeeded — the on-disk snapshot is now the
        // authoritative record of the replay anchors and per-job
        // diagnostics. The in-memory queue is no longer the source of
        // truth and can be cleared.
        clearMaintenanceDeferrals();
      }
    } else {
      // No durable store — in-memory only. The in-memory queue is the
      // only copy and is no longer the source of truth once the
      // job.state mutations are applied above. Clear it.
      clearMaintenanceDeferrals();
    }
  }

  return { previous, current, drainedCount, phaseBegan };
}

/**
 * Estimate how many schedule ticks the job missed during a hold of
 * `holdMs` milliseconds. Returns `undefined` if the schedule is
 * event-driven (no time axis) and no conservative estimate is
 * possible.
 *
 * Semantic: "missed" = number of due slots in the open interval
 * covering the hold. The minimum is 1 — a hold of any length
 * means at least the first due slot was missed.
 *
 *   - `{kind: "every"}` schedules: exact — `max(1, floor(holdMs / everyMs))`.
 *     For a 2-hour hold on a 15-minute job this returns 8: the 8 due
 *     slots within the hold.
 *   - `{kind: "cron"}` schedules: conservative — `max(1,
 *     floor(holdMs / 60_000))` (one tick per minute is the most-frequent
 *     realistic cron interval). Marked approximate.
 *   - `{kind: "at"}` one-shots: the held entry covers the one tick
 *     that was due. Default to 1, marked approximate.
 *   - `{kind: "on-exit"}` / `{kind: "stream"}` event-driven: undefined
 *     — no time axis means "missed ticks" is meaningless.
 *
 * The phase-exit reconciler passes the larger of (held-entry span) and
 * (nowMs - maintenancePhaseEnteredAtMs) as the hold duration so a job
 * deferred once at the start of a 3-hour window still reports the
 * full 3 hours, not 0.
 */
function estimateMissedScheduleTicks(
  schedule: import("./types.js").CronSchedule,
  holdMs: number,
): { count: number; approximate: boolean } | undefined {
  const safeHoldMs = Math.max(0, holdMs);
  switch (schedule.kind) {
    case "every": {
      const everyMs = Math.max(1, schedule.everyMs);
      const count = Math.max(1, Math.floor(safeHoldMs / everyMs));
      return { count, approximate: false };
    }
    case "cron": {
      // Conservative: a cron job fires at most once per minute. The
      // estimate is `max(1, floor(holdMs / 60s))` so a 2-hour hold on
      // a 5-minute cron job reports ~24 missed ticks.
      const count = Math.max(1, Math.floor(safeHoldMs / 60_000));
      return { count, approximate: true };
    }
    case "at": {
      // One-shot at a specific instant. The held entry either covers
      // that instant (count = 1) or the job was deferred after the
      // instant already passed (count = 0 — the job was missed).
      // We can't tell from the held entry alone, so default to 1 and
      // mark approximate so an external monitor can refine.
      return { count: 1, approximate: true };
    }
    case "on-exit":
    case "stream":
    default:
      return undefined;
  }
}
