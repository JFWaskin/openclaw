// Round 7 test: targeted unscheduled heartbeat wakes must be gated by
// the maintenance window (cycle 6 [P1] "Gate targeted unscheduled
// heartbeat wakes").
//
// Setup: a configured agent ("ambient") with a heartbeat, but the
// wake is a *targeted immediate system event* — no enrolled recurring
// heartbeat, no scheduled tick, no agent row in `state.agents`. Before
// the round 7 fix, this code path reached `runOnce` directly without
// checking the maintenance window. After the fix, the wake is held
// until the window closes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startHeartbeatRunner, type HeartbeatRunner } from "./heartbeat-runner-scheduler.js";
import { requestHeartbeat } from "./heartbeat-wake.js";

const AT_OUTSIDE_WINDOW = Date.UTC(2026, 0, 15, 1, 30, 0); // 01:30 UTC, before window
const AT_INSIDE_WINDOW = Date.UTC(2026, 0, 15, 3, 30, 0); // 03:30 UTC, inside [02:00, 04:00)
const AT_AFTER_WINDOW = Date.UTC(2026, 0, 15, 5, 0, 0); // 05:00 UTC, after window

function buildConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: { userTimezone: "UTC" },
      list: [{ id: "ambient", heartbeat: { every: "60m", target: "main" } }],
    },
    cron: {
      enabled: true,
      maintenance: {
        enabled: true,
        window: { start: "02:00", end: "04:00", timezone: "UTC" },
        maintenanceAgents: ["ops"],
      },
    },
  } as unknown as OpenClawConfig;
}

describe("round 7: gate targeted unscheduled heartbeat wakes (cycle 6 P1)", () => {
  let runner: HeartbeatRunner;
  let cfg: OpenClawConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    cfg = buildConfig();
  });
  afterEach(() => {
    runner?.stop();
    vi.useRealTimers();
  });

  it("defers a targeted hook/notification wake that arrives during the maintenance window", async () => {
    const runOnce = vi.fn(async (options: { agentId?: string }) => {
      expect(options.agentId).toBe("ambient");
      return { status: "ran", durationMs: 1 };
    });
    vi.setSystemTime(AT_INSIDE_WINDOW);
    runner = startHeartbeatRunner({ cfg, runOnce });

    requestHeartbeat({
      source: "hook",
      intent: "now",
      reason: "test-targeted-unscheduled",
      agentId: "ambient",
      coalesceMs: 0,
    });
    // Wait for the coalesce timer (0ms) to flush.
    await vi.advanceTimersByTimeAsync(50);

    // The wake is held back. The target agent is "ambient" which is
    // NOT in the maintenance roster, so the maintenance policy would
    // normally let it through — but the round 7 fix applies the gate
    // to the targeted-wake path before runOnce is reached.
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("allows a targeted wake that arrives outside the maintenance window", async () => {
    const runOnce = vi.fn(async (options: { agentId?: string }) => {
      return { status: "ran", durationMs: 1 };
    });
    vi.setSystemTime(AT_OUTSIDE_WINDOW);
    runner = startHeartbeatRunner({ cfg, runOnce });

    requestHeartbeat({
      source: "hook",
      intent: "now",
      reason: "test-targeted-unscheduled",
      agentId: "ambient",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(runOnce.mock.calls[0]?.[0]?.agentId).toBe("ambient");
  });

  it("allows a targeted wake from an agent that IS in the maintenance roster", async () => {
    const runOnce = vi.fn(async (options: { agentId?: string }) => {
      return { status: "ran", durationMs: 1 };
    });
    vi.setSystemTime(AT_INSIDE_WINDOW);
    const cfgWithRoster = {
      ...cfg,
      cron: {
        ...cfg.cron,
        maintenance: {
          ...cfg.cron!.maintenance,
          maintenanceAgents: ["ambient"], // ambient is in the roster
        },
      },
    } as OpenClawConfig;
    runner = startHeartbeatRunner({ cfg: cfgWithRoster, runOnce });

    requestHeartbeat({
      source: "hook",
      intent: "now",
      reason: "test-targeted-unscheduled",
      agentId: "ambient",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(50);

    // Ambient is in the maintenance roster; the gate allows it through.
    expect(runOnce).toHaveBeenCalledTimes(1);
  });
});
