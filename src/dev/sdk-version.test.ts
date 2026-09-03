// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "./sdk-version.js";

describe("SDK_VERSION", () => {
  it("matches package.json — the handshake reports it, so it must not drift", async () => {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it("fits the handshake's 32-character field", () => {
    expect(SDK_VERSION.length).toBeLessThanOrEqual(32);
  });
});
