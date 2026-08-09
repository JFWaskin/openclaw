// Regression for ClawSweeper cycle 5d [P1] "Retain scheduled heartbeat
// deferrals until the window ends". The previous design only retained
// `task`, `event`, and `immediate` intent wakes when a retryable guard
// (e.g. `maintenance-window`) skipped the dispatch. A `scheduled` intent
// wake (e.g. the heartbeat monitor's interval tick) was silently dropped
// instead of being retried at the window's `retryAtMs`, so a scheduled
// heartbeat could skip once and disappear despite the documented
// retry-at-window-end contract.
//
// This test exercises the resolver contract at the shouldDeferWake
// layer. The dispatch-loop retention is in heartbeat-wake.ts (where
// the wake is re-queued for retry) and is tested via the existing
// heartbeat-wake queue coverage.
import { describe, expect, it } from "vitest";
import { shouldDeferWake, type MaintenanceWindowContext } from "./heartbeat-cooldown.js";

const NOW = Date.UTC(2026, 0, 15, 3, 30, 0); // 03:30 UTC, inside window
const NEXT_ALLOWED = Date.UTC(2026, 0, 15, 4, 0, 0); // window end

const blocked: MaintenanceWindowContext = {
  isAllowed: false,
  nextAllowedAtMs: NEXT_ALLOWED,
  windowEndsAtMs: NEXT_ALLOWED,
};

const baseInput = {
  reason: "test",
  now: NOW,
  nextDueMs: NOW - 1_000, // would normally be due
};

describe("scheduled heartbeat retry contract under maintenance window", () => {
  it("scheduled wake is deferred with retryAtMs = nextAllowedAtMs (window end)", () => {
    const d = shouldDeferWake({
      ...baseInput,
      intent: "scheduled",
      maintenanceWindow: blocked,
    });
    expect(d.defer).toBe(true);
    if (d.defer) {
      expect(d.reason).toBe("maintenance-window");
      expect(d.retryAtMs).toBe(NEXT_ALLOWED);
    }
  });

  it("scheduled wake is allowed when the agent is in the maintenance roster", () => {
    const d = shouldDeferWake({
      ...baseInput,
      intent: "scheduled",
      maintenanceWindow: {
        isAllowed: true,
        nextAllowedAtMs: NEXT_ALLOWED,
        windowEndsAtMs: NEXT_ALLOWED,
      },
    });
    expect(d.defer).toBe(false);
  });
});
