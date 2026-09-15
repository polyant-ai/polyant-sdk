// SPDX-License-Identifier: Apache-2.0

/**
 * Collect local hook functions from the filesystem, with the route each one
 * takes into the agent's pipeline.
 *
 * The same TypeScript caveat as `load-tools.ts` applies: importing a
 * `*.hook.ts` needs the host process to have been started with a loader.
 *
 * A hook file says how it wants to run through a NAMED export beside its
 * default one:
 *
 *     export default defineHook({ name: "guard", ... });
 *     export const dev = devHook({ bindTo: { event: "message_received" } });
 *
 * Beside, and not inside the definition, because the definition is the
 * published authoring contract shared with shipped hooks — where "run this on
 * message_received for the length of my session" has no meaning. A file without
 * the export still loads, and the engine says it will never be invoked.
 */

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { HookFunctionDefinition } from "../hooks.js";
import type { DevHookEvent } from "./protocol.js";

const HOOK_FILE = /\.hook\.(ts|mts|cts|js|mjs|cjs)$/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".git"]);

/** How a local hook asks to enter the pipeline. Exactly one of the two. */
export type DevHookRoute =
  | { overrides: string; bindTo?: never }
  | {
      bindTo: { event: DevHookEvent; position?: number; timeoutMs?: number };
      overrides?: never;
    };

/** A local hook plus its route. What `serveDevSession` takes as `hooks`. */
export interface DevHook {
  definition: HookFunctionDefinition;
  route?: DevHookRoute;
}

/** Type-only helper so a hook file's `dev` export is checked where it is written,
 *  not where it is read. */
export function devHook(route: DevHookRoute): DevHookRoute {
  return route;
}

export interface LoadHooksOptions {
  /** Same cache-busting caveat as `loadToolsFromPaths`: Node's ESM cache has no
   *  invalidation, so without this a reload re-serves the original module. */
  cacheBust?: boolean;
}

/**
 * Import every `*.hook.*` file reachable from `paths` and return the definitions
 * with their declared route.
 *
 * Throws on a default export that is not a hook definition, and on a `dev`
 * export that is not a valid route — a typo in either is exactly the mistake
 * that must not degrade into "your hook silently never ran".
 */
export async function loadHooksFromPaths(
  paths: readonly string[],
  opts: LoadHooksOptions = {},
): Promise<DevHook[]> {
  const files: string[] = [];
  for (const path of paths) files.push(...(await collectHookFiles(resolve(path))));

  const hooks: DevHook[] = [];
  for (const [index, file] of files.sort().entries()) {
    const specifier = pathToFileURL(file).href + (opts.cacheBust ? `?reload=${Date.now()}-${index}` : "");
    const mod = (await import(specifier)) as { default?: unknown; dev?: unknown };
    if (!isHookDefinition(mod.default)) {
      throw new Error(
        `${file}: default export is not a hook definition. A hook file must ` +
          "`export default defineHook({ name, description, handler })`.",
      );
    }
    hooks.push({ definition: mod.default, route: parseRoute(file, mod.dev) });
  }
  return hooks;
}

/** A default export is a hook definition when it carries a handler — the same
 *  duck-typing the engine's own loader uses. */
export function isHookDefinition(value: unknown): value is HookFunctionDefinition {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { handler?: unknown }).handler === "function" &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

function parseRoute(file: string, value: unknown): DevHookRoute | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new Error(`${file}: the "dev" export must be an object built with devHook({ ... }).`);
  }
  const route = value as { overrides?: unknown; bindTo?: unknown };
  const hasOverrides = typeof route.overrides === "string" && route.overrides.length > 0;
  const hasBindTo = !!route.bindTo && typeof route.bindTo === "object";
  if (hasOverrides && hasBindTo) {
    throw new Error(
      `${file}: the "dev" export declares both "overrides" and "bindTo". A substitution inherits its ` +
        "event and position from the configured rows; a binding brings its own. Pick one.",
    );
  }
  if (!hasOverrides && !hasBindTo) {
    throw new Error(`${file}: the "dev" export declares neither "overrides" nor "bindTo".`);
  }
  return value as DevHookRoute;
}

async function collectHookFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return HOOK_FILE.test(path) ? [path] : [];
  const found: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      found.push(...(await collectHookFiles(join(path, entry.name))));
    } else if (HOOK_FILE.test(entry.name)) {
      found.push(join(path, entry.name));
    }
  }
  return found;
}
