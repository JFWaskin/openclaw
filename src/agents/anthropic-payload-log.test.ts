import crypto from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { createAnthropicPayloadLogger } from "./anthropic-payload-log.js";

describe("createAnthropicPayloadLogger", () => {
  it("returns null when diagnostics payload logging is disabled", () => {
    const logger = createAnthropicPayloadLogger({
      cfg: {} as OpenClawConfig,
      env: {},
      modelApi: "anthropic-messages",
    });

    expect(logger).toBeNull();
  });

  it("returns null when model api is not anthropic", () => {
    const logger = createAnthropicPayloadLogger({
      cfg: {
        diagnostics: {
          anthropicPayloadLog: {
            enabled: true,
          },
        },
      },
      env: {},
      modelApi: "openai",
      writer: {
        filePath: "memory",
        write: () => undefined,
      },
    });

    expect(logger).toBeNull();
  });

  it("honors diagnostics config and expands file paths", () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      cfg: {
        diagnostics: {
          anthropicPayloadLog: {
            enabled: true,
            filePath: "~/.openclaw/logs/anthropic-payload.jsonl",
          },
        },
      },
      env: {},
      modelApi: "anthropic-messages",
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    expect(logger).not.toBeNull();
    expect(logger?.filePath).toBe(resolveUserPath("~/.openclaw/logs/anthropic-payload.jsonl"));

    logger?.recordUsage([
      {
        role: "assistant",
        usage: {
          input: 12,
        },
      } as never,
    ]);

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("usage");
    expect(event.usage).toEqual({ input: 12 });
  });

  it("skips usage when no new assistant message was added", () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      cfg: {
        diagnostics: {
          anthropicPayloadLog: {
            enabled: true,
          },
        },
      },
      env: {},
      modelApi: "anthropic-messages",
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    logger?.recordUsage(
      [
        {
          role: "assistant",
          usage: {
            input: 1,
          },
        } as never,
      ],
      undefined,
      1,
    );

    expect(lines.length).toBe(0);
  });

  it("records request payloads and forwards onPayload", async () => {
    const lines: string[] = [];
    let forwarded: unknown;
    const logger = createAnthropicPayloadLogger({
      cfg: {
        diagnostics: {
          anthropicPayloadLog: {
            enabled: true,
          },
        },
      },
      env: {},
      modelApi: "anthropic-messages",
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    const streamFn = (async (_: unknown, __: unknown, options?: { onPayload?: (p: unknown) => void }) => {
      options?.onPayload?.({ hello: "world" });
      return {} as never;
    }) as unknown as StreamFn;

    const wrapped = logger?.wrapStreamFn(streamFn);
    await wrapped?.(
      { api: "anthropic-messages" } as never,
      {} as never,
      {
        onPayload: (payload) => {
          forwarded = payload;
        },
      },
    );

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("request");
    expect(event.payload).toEqual({ hello: "world" });
    expect(event.payloadDigest).toBeTruthy();
    expect(forwarded).toEqual({ hello: "world" });
  });

  it("records errors when usage is missing", () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      cfg: {
        diagnostics: {
          anthropicPayloadLog: {
            enabled: true,
          },
        },
      },
      env: {},
      modelApi: "anthropic-messages",
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    logger?.recordUsage([], new Error("boom"));

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("usage");
    expect(event.error).toContain("boom");
  });

  it("redacts image base64 payload data before writing logs", async () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1" },
      modelApi: "anthropic-messages",
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });
    expect(logger).not.toBeNull();

    const payload = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
            },
          ],
        },
      ],
    };
    const streamFn: StreamFn = ((_, __, options) => {
      options?.onPayload?.(payload);
      return {} as never;
    }) as StreamFn;

    const wrapped = logger?.wrapStreamFn(streamFn);
    await wrapped?.({ api: "anthropic-messages" } as never, { messages: [] } as never, {});

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    const message = ((event.payload as { messages?: unknown[] } | undefined)?.messages ??
      []) as Array<Record<string, unknown>>;
    const source = (((message[0]?.content as Array<Record<string, unknown>> | undefined) ?? [])[0]
      ?.source ?? {}) as Record<string, unknown>;
    expect(source.data).toBe("<redacted>");
    expect(source.bytes).toBe(4);
    expect(source.sha256).toBe(crypto.createHash("sha256").update("QUJDRA==").digest("hex"));
    expect(event.payloadDigest).toBeDefined();
  });
});
