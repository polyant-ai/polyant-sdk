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
  | { type: "tools_updated"; tools: readonly string[] }
  | { type: "disconnected"; code?: number; reason: string; willReconnect: boolean; retryInMs?: number }
  /** A non-fatal fault: an unparseable frame, a send on a dead socket, a listener that threw. */
  | { type: "error"; message: string }
  | { type: "closed"; reason: string };

export type DevSessionEventHandler = (event: DevSessionEvent) => void;
