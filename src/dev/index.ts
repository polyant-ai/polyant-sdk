// SPDX-License-Identifier: Apache-2.0

/**
 * `@polyant-ai/plugin-sdk/dev` — the client runtime for the engine's dev-mode
 * bridge: it connects a developer's local `*.tool.ts` files to a remote agent,
 * per turn, over the WebSocket protocol in {@link ./protocol.js}.
 *
 * Node-only entry point (it uses `node:crypto` / `node:fs`), separate from the
 * package root so the authoring contract stays runtime-agnostic and free of it.
 */

export { serveDevSession, toDeclarations, DEV_SOCKET_PATH, DEFAULT_DEV_SOCKET_URL } from "./session.js";
export type { ServeDevSessionOptions, DevSessionHandle, DevReconnectOptions } from "./session.js";

export { loadToolsFromPaths, isToolDefinition } from "./load-tools.js";
export type { LoadToolsOptions } from "./load-tools.js";

export { createCtxProxy } from "./ctx-proxy.js";
export type { CtxProxy, CtxRpc, DevToolContext } from "./ctx-proxy.js";

export { defaultWebSocketFactory } from "./websocket.js";
export type { DevWebSocketLike, DevWebSocketFactory, DevSocketEvent, DevSocketEventType } from "./websocket.js";

export type { DevSessionEvent, DevSessionEventHandler } from "./events.js";

export { SDK_VERSION } from "./sdk-version.js";

export {
  DEV_PROTOCOL_VERSION,
  CTX_OPS,
  clientFrameSchema,
  serverFrameSchema,
  parseServerFrame,
  serializeClientFrame,
} from "./protocol.js";
export type {
  ClientFrame,
  ServerFrame,
  CtxOp,
  DevToolDeclaration,
  InlineToolContext,
  StateWrite,
  AuditEntryPayload,
} from "./protocol.js";
