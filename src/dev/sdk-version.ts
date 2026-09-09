// SPDX-License-Identifier: Apache-2.0

/**
 * The `sdkVersion` the handshake reports. A literal, not a `package.json` read:
 * this entry point must stay importable from `dist/` with no filesystem access
 * and no JSON import assertion. `sdk-version.test.ts` fails the suite when it
 * drifts from `package.json`, so the duplication cannot rot.
 */
export const SDK_VERSION = "1.7.0";
