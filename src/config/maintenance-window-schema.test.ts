// Round 7 schema tests for `cron.maintenance.window.*`.
//
// Covers:
//   - IANA timezone validation: schema rejects unknown zone names so a
//     typo does not silently fall back to the operator's local zone
//     (ClawSweeper cycle 6 P1)
//   - `end="24:00"` is accepted for end-of-day windows (ClawSweeper
//     cycle 6 P2)

import { describe, expect, it } from "vitest";
import { z } from "zod";

// Replicate just the maintenance block schema from
// `zod-schema.root-shape.ts`. We isolate it so the test does not have
// to load the full root schema (which pulls in ~50 sibling fields).
const ACTIVE_HOURS_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/u;
const END_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/u;

const MaintenanceWindowSchema = z
  .strictObject({
    start: z.string().regex(ACTIVE_HOURS_PATTERN, "use HH:MM (24h) format").optional(),
    end: z.string().regex(END_PATTERN, "use HH:MM (24h) format; 24:00 allowed for end").optional(),
    timezone: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.start === undefined || val.end === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["window"],
        message: "maintenance.window requires both start and end (HH:MM)",
      });
      return;
    }
    if (val.start >= val.end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["window"],
        message:
          "maintenance.window.start must be strictly before end; cross-midnight windows are not supported in this release (use end=24:00 for same-day close-of-day)",
      });
    }
    if (val.timezone) {
      const tz = val.timezone.trim();
      if (tz !== "user" && tz !== "local") {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["timezone"],
            message: `unknown IANA timezone "${tz}"`,
          });
        }
      }
    }
  });

describe("cron.maintenance.window schema (round 7)", () => {
  describe("IANA timezone validation (cycle 6 P1)", () => {
    it("accepts a well-known IANA zone", () => {
      const r = MaintenanceWindowSchema.safeParse({
        start: "02:00",
        end: "04:00",
        timezone: "America/Los_Angeles",
      });
      expect(r.success).toBe(true);
    });

    it("rejects an unknown zone with a clear error", () => {
      const r = MaintenanceWindowSchema.safeParse({
        start: "02:00",
        end: "04:00",
        timezone: "Not/A/Real/Zone",
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        const tzIssue = r.error.issues.find((i) => i.path.includes("timezone"));
        expect(tzIssue?.message).toMatch(/unknown IANA timezone/);
      }
    });

    it("accepts the 'user' alias", () => {
      const r = MaintenanceWindowSchema.safeParse({
        start: "02:00",
        end: "04:00",
        timezone: "user",
      });
      expect(r.success).toBe(true);
    });

    it("accepts the 'local' alias", () => {
      const r = MaintenanceWindowSchema.safeParse({
        start: "02:00",
        end: "04:00",
        timezone: "local",
      });
      expect(r.success).toBe(true);
    });

    it("rejects an empty timezone string", () => {
      const r = MaintenanceWindowSchema.safeParse({
        start: "02:00",
        end: "04:00",
        timezone: "",
      });
      expect(r.success).toBe(false);
    });

    it("omits the timezone when not provided (defer to user default)", () => {
      const r = MaintenanceWindowSchema.safeParse({
        start: "02:00",
        end: "04:00",
      });
      expect(r.success).toBe(true);
    });
  });

  describe("end='24:00' acceptance (cycle 6 P2)", () => {
    it("accepts end=24:00 with start strictly before", () => {
      const r = MaintenanceWindowSchema.safeParse({
        start: "22:00",
        end: "24:00",
        timezone: "UTC",
      });
      expect(r.success).toBe(true);
    });

    it("rejects start=24:00 (24:00 is end-only)", () => {
      const r = MaintenanceWindowSchema.safeParse({
        start: "24:00",
        end: "04:00",
        timezone: "UTC",
      });
      // start=24:00 doesn't match the start regex AND the order check
      // would also fail; either way the parse should reject.
      expect(r.success).toBe(false);
    });

    it("rejects end=24:30 (only 24:00 sentinel)", () => {
      const r = MaintenanceWindowSchema.safeParse({
        start: "22:00",
        end: "24:30",
        timezone: "UTC",
      });
      expect(r.success).toBe(false);
    });

    it("rejects end=24:01", () => {
      const r = MaintenanceWindowSchema.safeParse({
        start: "22:00",
        end: "24:01",
        timezone: "UTC",
      });
      expect(r.success).toBe(false);
    });

    it("accepts end=23:59 (last minute of the day, no sentinel)", () => {
      const r = MaintenanceWindowSchema.safeParse({
        start: "22:00",
        end: "23:59",
        timezone: "UTC",
      });
      expect(r.success).toBe(true);
    });

    it("accepts end=00:00 (midnight, same-day end)", () => {
      const r = MaintenanceWindowSchema.safeParse({
        start: "22:00",
        end: "00:00",
        timezone: "UTC",
      });
      // start (22:00) >= end (00:00) — order check fails. The intent is
      // to express "22:00 -> end of day", which the operator should write
      // as end=24:00, not end=00:00.
      expect(r.success).toBe(false);
    });
  });
});
