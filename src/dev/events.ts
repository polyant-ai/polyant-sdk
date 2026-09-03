// SPDX-License-Identifier: Apache-2.0

/**
 * Structured session events. A library must not print: whoever wraps this
 * runtime (the Polyant CLI, a test, an editor task) owns the presentation, so
 * everything the runtime would have logged is emitted here instead.
 */

import type { CtxOp } from "./protocol.js";

export type DevSessionEvent =
  | { type: "connecting"; url: string; attempt: number }
  | { type: "connected"; sessionId: string; engineVersion: string; warnings: readonly string[]; tools: readonly string[] }
  /** The engine refused the handshake (bad token, unknown agent, protocol mismatch). Never retried. */
  | { type: "handshake_rejected"; reason: string }
  | { type: "invoke"; callId: string; tool: string }
  | { type: "result"; callId: string; tool: string; ok: boolean; durationMs: number; error?: string }
  | { type: "aborted"; callId: string; tool: string }
  | { type: "ctx_request"; callId: string; op: CtxOp }
  /**
   * A `tools.update` was ADOPTED — the engine now serves `tools` and is the
   * only source of truth for that: this fires only once the confirmation
   * (`tools.update.result` with `ok: true`, or a fresh `hello.ok` after a
   * reconnect) has arrived, never merely because the frame was sent.
   * `warnings` is the same strict-mode lint as `connected.warnings`.
   */
  | { type: "tools_updated"; tools: readonly string[]; warnings: readonly string[] }
  /**
   * A `tools.update` was REJECTED (e.g. two names that collide after
   * sanitization). The engine kept — and this runtime kept serving — the
   * PREVIOUS declarations, listed in `tools`: nothing the update attempted to
   * change is live. `reason` is the engine's explanation.
   */
  | { type: "tools_update_rejected"; reason: string; tools: readonly string[] }
  | { type: "disconnected"; code?: number; reason: string; willReconnect: boolean; retryInMs?: number }
  /** A non-fatal fault: an unparseable frame, a send on a dead socket, a listener that threw. */
  | { type: "error"; message: string }
  | { type: "closed"; reason: string };

export type DevSessionEventHandler = (event: DevSessionEvent) => void;
