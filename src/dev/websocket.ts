// SPDX-License-Identifier: Apache-2.0

/**
 * The minimal WebSocket surface this runtime needs, and the default factory.
 *
 * Typed as the WHATWG (`addEventListener`) shape, not the `ws` EventEmitter one,
 * for two reasons: it is what Node's own global `WebSocket` exposes, so the
 * default costs this package NO new runtime dependency; and it is what `ws`
 * ALSO exposes, so injecting `(url) => new WS(url)` works unchanged on a Node
 * that has no global WebSocket.
 */

/** An event as delivered to one of the four listeners below. */
export interface DevSocketEvent {
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
  readonly message?: string;
}

export type DevSocketEventType = "open" | "message" | "close" | "error";

export interface DevWebSocketLike {
  /** 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED. */
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: DevSocketEventType, listener: (event: DevSocketEvent) => void): void;
}

/** Builds a socket for `url`. Injected to run without a global WebSocket. */
export type DevWebSocketFactory = (url: string) => DevWebSocketLike;

/**
 * The default factory: Node's global `WebSocket`, available unflagged from Node
 * 22. On Node 20/21 there is none, and the error says exactly what to inject
 * instead of failing as `WebSocket is not a constructor`.
 */
export function defaultWebSocketFactory(): DevWebSocketFactory {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof ctor !== "function") {
    throw new Error(
      "no global WebSocket in this runtime (Node 22+ provides one). Pass `webSocketImpl: (url) => new WebSocket(url)` " +
        'from a WebSocket implementation such as `ws`, e.g. `import WS from "ws"`.',
    );
  }
  const Ctor = ctor as new (url: string) => DevWebSocketLike;
  return (url: string) => new Ctor(url);
}
