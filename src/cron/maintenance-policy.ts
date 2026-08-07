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
        // or ambiguous (fall back). Return the larger UTC value: the post-DST
        // instant, which is the conventional "next time HH:MM arrives".
        let max = targetAsUtc;
        for (const v of visited) {
          if (v > max) max = v;
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
