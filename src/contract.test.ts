// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTool, toJsonSchema, normalizeRequiredSecrets } from "./contract.js";
import type { ToolContext } from "./context-types.js";

const stubCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
  instanceId: "inst" as ToolContext["instanceId"],
  audit: { log() {} },
  ...over,
});

describe("defineTool — serialized boundary", () => {
  const tool = defineTool({
    name: "demo",
    description: "d",
    category: "test",
    requiredSecrets: ["api_key", { key: "mode", type: "select", choices: ["a", "b"] }],
    parameters: z.object({ q: z.string(), n: z.number().nullable() }),
    execute: async (input, ctx) => `${input.q}:${ctx.instanceId}`,
  });

  it("serializes parameters to a plain JSON Schema (no live Zod instance)", () => {
    expect(tool.inputSchema.type).toBe("object");
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props.q).toBeDefined();
    expect(props.n).toBeDefined();
    // A plain data object, not a Zod schema.
    expect("_def" in (tool.inputSchema as object)).toBe(false);
    expect("safeParse" in (tool.inputSchema as object)).toBe(false);
    // $schema metadata is stripped.
    expect("$schema" in tool.inputSchema).toBe(false);
  });

  it("emits a strict-mode-friendly object schema (all keys required, bounded additionalProperties)", () => {
    const s = tool.inputSchema as { required?: string[]; additionalProperties?: unknown; properties?: object };
    expect(s.required).toEqual(expect.arrayContaining(["q", "n"]));
    // z.object → additionalProperties:false (OpenAI strict-mode).
    expect(s.additionalProperties).toBe(false);
  });

  it("normalizes requiredSecrets (string → text/masked, select → readable)", () => {
    expect(tool.requiredSecrets).toEqual([
      { key: "api_key", type: "text", sensitive: true },
      { key: "mode", type: "select", choices: ["a", "b"], sensitive: false },
    ]);
  });

  it("execute receives (input, ctx) — ctx is a parameter, not a closure", async () => {
    const out = await tool.execute({ q: "hi" }, stubCtx({ instanceId: "acme" as ToolContext["instanceId"] }));
    expect(out).toBe("hi:acme");
  });
});

describe("normalizeRequiredSecrets guards", () => {
  it("rejects empty string keys", () => {
    expect(() => normalizeRequiredSecrets([""], "t")).toThrow(/empty string/);
  });
  it("rejects select without choices", () => {
    expect(() => normalizeRequiredSecrets([{ key: "k", type: "select" }], "t")).toThrow(/requires non-empty 'choices'/);
  });
});

describe("toJsonSchema", () => {
  it("maps .nullable() to a null-inclusive type (strict-mode opcionality)", () => {
    const js = toJsonSchema(z.object({ x: z.string().nullable() })) as {
      properties: { x: { type?: unknown } };
    };
    // zod-to-json-schema emits either type: ["string","null"] or anyOf; accept either.
    const x = js.properties.x;
    const asString = JSON.stringify(x);
    expect(asString).toContain("null");
  });
});
