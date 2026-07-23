// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { defineHook } from "./hooks.js";

describe("hook regenerate contract", () => {
  it("accepts a handler that reads regenerationCount and returns regenerate", () => {
    const def = defineHook({
      name: "regen-contract",
      description: "type-level contract exercise",
      mutatesResponse: true,
      handler: (ctx) => {
        const { text, regenerationCount } = ctx.payload.response!;
        if (text.length === 0) return;
        return regenerationCount < 2
          ? { regenerate: { reason: "exercise" } }
          : { replaceResponse: { message: "gave up" } };
      },
    });
    expect(def.name).toBe("regen-contract");
    expect(def.mutatesResponse).toBe(true);
  });
});
