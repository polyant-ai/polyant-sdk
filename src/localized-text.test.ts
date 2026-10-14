// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { assertLocalizedText } from "./localized-text.js";
import { defineTool, normalizeRequiredSecrets, oauthRequiredSecrets } from "./contract.js";
import { defineHook } from "./hooks.js";

describe("assertLocalizedText", () => {
  it("accepts a plain string and a map of canonical tags", () => {
    expect(() => assertLocalizedText("Order lookup", "x")).not.toThrow();
    expect(() => assertLocalizedText({ "en-US": "Order lookup", "it-IT": "Cerca ordine", "zh-Hant-TW": "查詢" }, "x")).not.toThrow();
    expect(() => assertLocalizedText({ it: "Cerca ordine" }, "x")).not.toThrow();
  });

  it("rejects what the engine would reject", () => {
    expect(() => assertLocalizedText("", "x")).toThrow(/empty string/);
    expect(() => assertLocalizedText({}, "x")).toThrow(/at least one locale/);
    expect(() => assertLocalizedText({ it_IT: "Ciao" }, "x")).toThrow(/BCP 47/);
    expect(() => assertLocalizedText({ "en-us": "Hi" }, "x")).toThrow(/BCP 47/);
    expect(() => assertLocalizedText({ "en-US": "" }, "x")).toThrow(/non-empty/);
    expect(() => assertLocalizedText(["Hi"], "x")).toThrow(/map of BCP 47/);
  });
});

describe("localized text on tools, hooks and secrets", () => {
  it("carries a tool's summary through, absent when unset", () => {
    const tool = defineTool({
      name: "lookup",
      description: "Look up an order by its number.",
      summary: { "en-US": "Looks up an order.", "it-IT": "Cerca un ordine." },
      parameters: z.object({ n: z.string() }),
      execute: async () => ({}),
    });
    expect(tool.summary).toEqual({ "en-US": "Looks up an order.", "it-IT": "Cerca un ordine." });
    expect(tool.description).toBe("Look up an order by its number.");
    const plain = defineTool({ name: "p", description: "d", parameters: z.object({}), execute: async () => ({}) });
    expect(plain.summary).toBeUndefined();
  });

  it("fails at load on a malformed summary", () => {
    expect(() =>
      defineTool({ name: "bad", description: "d", summary: { "it_IT": "x" }, parameters: z.object({}), execute: async () => ({}) }),
    ).toThrow(/Tool "bad": summary/);
    expect(() => defineHook({ name: "h", description: "d", summary: "", handler: () => undefined })).toThrow(/Hook "h": summary/);
  });

  it("carries a hook's summary through", () => {
    const hook = defineHook({ name: "h", description: "d", summary: { "en-US": "Greets.", "it-IT": "Saluta." }, handler: () => undefined });
    expect(hook.summary).toEqual({ "en-US": "Greets.", "it-IT": "Saluta." });
  });

  it("accepts localized secret labels and descriptions and rejects malformed ones", () => {
    const [spec] = normalizeRequiredSecrets([
      { key: "api_key", type: "text", label: { "en-US": "API key", "it-IT": "Chiave API" }, description: { "en-US": "From Settings.", "it-IT": "Da Impostazioni." } },
    ]);
    expect(spec.label).toEqual({ "en-US": "API key", "it-IT": "Chiave API" });
    expect(() => normalizeRequiredSecrets([{ key: "k", type: "text", label: { EN: "x" } }], "t")).toThrow(/"k" label/);
    expect(() => normalizeRequiredSecrets([{ key: "k", type: "text", description: "" }], "t")).toThrow(/"k" description/);
  });

  it("labels the OAuth client fields in English and Italian", () => {
    const [id, secret] = oauthRequiredSecrets("acme");
    expect(id.label).toEqual({ "en-US": "acme OAuth client ID", "it-IT": "Client ID OAuth acme" });
    expect(secret.label).toEqual({ "en-US": "acme OAuth client secret", "it-IT": "Client secret OAuth acme" });
  });
});
