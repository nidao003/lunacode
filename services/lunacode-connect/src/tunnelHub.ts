import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";

import { sha256Base64Url } from "./crypto.ts";
import type { ConnectDatabase, EnvironmentRow } from "./db.ts";
import {
  computeWebSocketAccept,
  createWebSocketFrameDecoder,
  decodeTunnelFrame,
  encodeTunnelFrame,
  encodeWebSocketFrame,
  TUNNEL_FRAME,
} from "./tunnelProtocol.ts";

const HOP_BY_HOP_HTTP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface PendingHttpStream {
  readonly kind: "external_http";
  readonly res: NodeHttp.ServerResponse;
  headReceived: boolean;
  closed: boolean;
}

interface PendingInternalHttpStream {
  readonly kind: "internal_http";
  readonly chunks: Array<Buffer>;
  statusCode: number;
  headers: Record<string, string | Array<string>>;
  headReceived: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (value: {
    readonly statusCode: number;
    readonly headers: Record<string, string | Array<string>>;
    readonly body: Buffer;
  }) => void;
  readonly reject: (reason: Error) => void;
}

interface PendingWsStream {
  readonly kind: "ws";
  readonly socket: NodeStream.Duplex;
  acknowledged: boolean;
  closed: boolean;
}

type ActiveStream = PendingHttpStream | PendingInternalHttpStream | PendingWsStream;

export interface ProxyExternalOptions {
  readonly targetUrl?: string;
  readonly forwardedPrefix?: string;
  readonly forwardedProto?: string;
  readonly forwardedHost?: string;
}

interface TunnelConnection {
  readonly tunnelId: string;
  readonly socket: NodeStream.Duplex;
  nextStreamId: number;
  readonly streams: Map<number, ActiveStream>;
  readonly pingTimer: ReturnType<typeof setInterval>;
  closed: boolean;
}

export class TunnelHub {
  private readonly db: ConnectDatabase;
  private readonly tunnels = new Map<string, TunnelConnection>();
  private onTunnelConnected: ((env: EnvironmentRow) => void) | undefined;

  constructor(db: ConnectDatabase) {
    this.db = db;
  }

  setOnTunnelConnected(listener: ((env: EnvironmentRow) => void) | undefined): void {
    this.onTunnelConnected = listener;
  }

  hasActiveTunnel(tunnelId: string | null | undefined): boolean {
    if (!tunnelId) return false;
    const conn = this.tunnels.get(tunnelId);
    return (
      conn !== undefined && !conn.closed && !conn.socket.destroyed && !conn.socket.writableEnded
    );
  }

  resolveTunnelForHost(hostHeader: string | undefined): string | null {
    if (!hostHeader) return null;
    return this.db.findActiveTunnelIdByHost(hostHeader);
  }

  resolveTunnelForSlug(slug: string | undefined): string | null {
    if (!slug) return null;
    return this.db.findActiveTunnelIdBySlug(slug);
  }

  closeTunnel(tunnelId: string | null | undefined, reason = "Tunnel disconnected"): void {
    if (!tunnelId) return;
    const conn = this.tunnels.get(tunnelId);
    if (!conn) return;
    this.cleanupConnection(conn, reason);
  }

  closeAll(): void {
    for (const conn of Array.from(this.tunnels.values())) {
      this.cleanupConnection(conn, "Server shutting down");
    }
  }

  handleControlUpgrade(
    req: NodeHttp.IncomingMessage,
    socket: NodeStream.Duplex,
    head: Buffer,
  ): void {
    const reqUrl = new URL(req.url ?? "/_tunnel/connect", "http://localhost");
    const tunnelId =
      headerString(req.headers["x-lunacode-tunnel-id"]) ??
      reqUrl.searchParams.get("tunnelId")?.trim();
    const authHeader = headerString(req.headers.authorization);
    const bearer = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : reqUrl.searchParams.get("token")?.trim();
    const wsKey = headerString(req.headers["sec-websocket-key"]);

    if (!tunnelId || !bearer || !wsKey) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const env = this.db.findActiveEnvironmentByTunnelAuth(tunnelId, sha256Base64Url(bearer));
    if (!env) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const accept = computeWebSocketAccept(wsKey);
    const upgradeHeaders = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      `X-Tunnel-Public-Url: ${env.httpBaseUrl}`,
    ];
    try {
      const parsedPublic = new URL(env.httpBaseUrl);
      if (parsedPublic.pathname === "/") {
        upgradeHeaders.push(`X-Tunnel-Public-Host: ${parsedPublic.host}`);
      }
    } catch {
      // ignore malformed URL
    }
    upgradeHeaders.push("", "");
    socket.write(upgradeHeaders.join("\r\n"));

    const previous = this.tunnels.get(tunnelId);
    if (previous) {
      this.cleanupConnection(previous, "Replaced by newer tunnel connection");
    }

    const conn: TunnelConnection = {
      tunnelId,
      socket,
      nextStreamId: 1,
      streams: new Map(),
      pingTimer: setInterval(() => {
        if (!conn.closed) {
          this.sendTunnelFrame(conn, TUNNEL_FRAME.PING, 0, JSON.stringify({ ts: Date.now() }));
        }
      }, 25_000),
      closed: false,
    };
    conn.pingTimer.unref?.();
    this.tunnels.set(tunnelId, conn);

    const decode = createWebSocketFrameDecoder((wsFrame) => {
      if (conn.closed) return;
      if (wsFrame.opcode === 0x08) {
        this.cleanupConnection(conn, "Tunnel closed by environment");
        return;
      }
      if (wsFrame.opcode === 0x09) {
        socket.write(encodeWebSocketFrame({ opcode: 0x0a, payload: wsFrame.payload }));
        return;
      }
      if (wsFrame.opcode === 0x0a) {
        return;
      }
      if (wsFrame.opcode !== 0x02) {
        return;
      }
      const frame = decodeTunnelFrame(wsFrame.payload);
      if (!frame) return;
      this.handleIncomingTunnelFrame(conn, frame.type, frame.streamId, frame.payload);
    });

    socket.on("data", (chunk: Buffer) => {
      try {
        decode(chunk);
      } catch {
        this.cleanupConnection(conn, "Invalid tunnel WebSocket frame");
      }
    });
    socket.on("end", () => this.cleanupConnection(conn, "Tunnel socket ended"));
    socket.on("close", () => this.cleanupConnection(conn, "Tunnel socket closed"));
    socket.on("error", () => this.cleanupConnection(conn, "Tunnel socket error"));

    if (head.length > 0) {
      try {
        decode(head);
      } catch {
        this.cleanupConnection(conn, "Invalid initial tunnel frame");
      }
    }

    if (this.onTunnelConnected && !conn.closed) {
      const listener = this.onTunnelConnected;
      queueMicrotask(() => {
        if (!conn.closed && this.tunnels.get(tunnelId) === conn) {
          listener(env);
        }
      });
    }
  }

  proxyExternalHttp(
    tunnelId: string,
    req: NodeHttp.IncomingMessage,
    res: NodeHttp.ServerResponse,
    options?: ProxyExternalOptions,
  ): void {
    const conn = this.tunnels.get(tunnelId);
    if (!conn || conn.closed) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "environment_tunnel_offline" }));
      return;
    }

    const streamId = conn.nextStreamId++;
    const stream: PendingHttpStream = {
      kind: "external_http",
      res,
      headReceived: false,
      closed: false,
    };
    conn.streams.set(streamId, stream);

    const openPayload = JSON.stringify({
      method: req.method ?? "GET",
      url: options?.targetUrl ?? req.url ?? "/",
      headers: buildTunnelRequestHeaders(req.headers, false, options),
    });
    this.sendTunnelFrame(conn, TUNNEL_FRAME.OPEN_HTTP, streamId, openPayload);

    req.on("data", (chunk: Buffer) => {
      if (!stream.closed && !conn.closed) {
        this.sendTunnelFrame(conn, TUNNEL_FRAME.DATA, streamId, chunk);
      }
    });
    req.on("end", () => {
      if (!stream.closed && !conn.closed) {
        this.sendTunnelFrame(conn, TUNNEL_FRAME.END, streamId);
      }
    });
    req.on("error", () => {
      if (!stream.closed) {
        stream.closed = true;
        conn.streams.delete(streamId);
        this.sendTunnelFrame(
          conn,
          TUNNEL_FRAME.CLOSE,
          streamId,
          JSON.stringify({ error: "client_error" }),
        );
      }
    });
    res.on("close", () => {
      if (!res.writableEnded && !stream.closed) {
        stream.closed = true;
        conn.streams.delete(streamId);
        this.sendTunnelFrame(
          conn,
          TUNNEL_FRAME.CLOSE,
          streamId,
          JSON.stringify({ error: "client_closed" }),
        );
      }
    });
  }

  proxyExternalUpgrade(
    tunnelId: string,
    req: NodeHttp.IncomingMessage,
    socket: NodeStream.Duplex,
    head: Buffer,
    options?: ProxyExternalOptions,
  ): void {
    const conn = this.tunnels.get(tunnelId);
    if (!conn || conn.closed) {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const streamId = conn.nextStreamId++;
    const stream: PendingWsStream = {
      kind: "ws",
      socket,
      acknowledged: false,
      closed: false,
    };
    conn.streams.set(streamId, stream);
    socket.pause();

    this.sendTunnelFrame(
      conn,
      TUNNEL_FRAME.OPEN_WS,
      streamId,
      JSON.stringify({
        method: req.method ?? "GET",
        url: options?.targetUrl ?? req.url ?? "/",
        headers: buildTunnelRequestHeaders(req.headers, true, options),
      }),
    );
    if (head.length > 0) {
      this.sendTunnelFrame(conn, TUNNEL_FRAME.DATA, streamId, head);
    }

    socket.on("data", (chunk: Buffer) => {
      if (!stream.closed && !conn.closed) {
        this.sendTunnelFrame(conn, TUNNEL_FRAME.DATA, streamId, chunk);
      }
    });
    socket.on("end", () => {
      if (!stream.closed && !conn.closed) {
        this.sendTunnelFrame(conn, TUNNEL_FRAME.END, streamId);
      }
    });
    socket.on("close", () => {
      if (!stream.closed) {
        stream.closed = true;
        conn.streams.delete(streamId);
        this.sendTunnelFrame(conn, TUNNEL_FRAME.CLOSE, streamId);
      }
    });
    socket.on("error", () => {
      if (!stream.closed) {
        stream.closed = true;
        conn.streams.delete(streamId);
        this.sendTunnelFrame(conn, TUNNEL_FRAME.CLOSE, streamId);
      }
    });
  }

  dispatchInternalHttp(
    tunnelId: string,
    input: {
      readonly method: string;
      readonly url: string;
      readonly headers?: Record<string, string>;
      readonly body?: Buffer | string;
      readonly timeoutMs?: number;
    },
  ): Promise<{
    readonly statusCode: number;
    readonly headers: Record<string, string | Array<string>>;
    readonly body: Buffer;
  }> {
    const conn = this.tunnels.get(tunnelId);
    if (!conn || conn.closed) {
      return Promise.reject(new Error("Environment tunnel is offline."));
    }

    return new Promise((resolve, reject) => {
      const streamId = conn.nextStreamId++;
      const timer = setTimeout(() => {
        conn.streams.delete(streamId);
        this.sendTunnelFrame(
          conn,
          TUNNEL_FRAME.CLOSE,
          streamId,
          JSON.stringify({ error: "timeout" }),
        );
        reject(new Error("Tunnel HTTP request timed out."));
      }, input.timeoutMs ?? 15_000);
      timer.unref?.();

      const stream: PendingInternalHttpStream = {
        kind: "internal_http",
        chunks: [],
        statusCode: 502,
        headers: {},
        headReceived: false,
        timer,
        resolve,
        reject,
      };
      conn.streams.set(streamId, stream);

      this.sendTunnelFrame(
        conn,
        TUNNEL_FRAME.OPEN_HTTP,
        streamId,
        JSON.stringify({
          method: input.method,
          url: input.url,
          headers: input.headers ?? {},
        }),
      );
      if (input.body !== undefined && input.body.length > 0) {
        this.sendTunnelFrame(conn, TUNNEL_FRAME.DATA, streamId, input.body);
      }
      this.sendTunnelFrame(conn, TUNNEL_FRAME.END, streamId);
    });
  }

  async dispatchInternalRaw(
    tunnelId: string,
    input: {
      readonly method: string;
      readonly path: string;
      readonly headers?: Record<string, string | Array<string>>;
      readonly body?: Buffer;
      readonly timeoutMs?: number;
    },
  ): Promise<
    | {
        readonly ok: true;
        readonly status: number;
        readonly headers: Record<string, string | Array<string>>;
        readonly body: Buffer;
      }
    | {
        readonly ok: false;
        readonly failure: "tunnel_down" | "timeout" | "invalid_response";
        readonly error: string;
      }
  > {
    if (!this.hasActiveTunnel(tunnelId)) {
      return { ok: false, failure: "tunnel_down", error: "Environment tunnel is offline." };
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.headers ?? {})) {
      if (typeof value === "string") {
        headers[key] = value;
      } else if (Array.isArray(value) && value.length > 0) {
        headers[key] = value.join(", ");
      }
    }
    try {
      const res = await this.dispatchInternalHttp(tunnelId, {
        method: input.method,
        url: input.path,
        headers,
        body: input.body,
        timeoutMs: input.timeoutMs ?? 20_000,
      });
      return {
        ok: true,
        status: res.statusCode,
        headers: res.headers,
        body: res.body,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lowerMessage = message.toLowerCase();
      const failure = lowerMessage.includes("timed out")
        ? "timeout"
        : lowerMessage.includes("offline") ||
            lowerMessage.includes("closed") ||
            lowerMessage.includes("ended") ||
            lowerMessage.includes("disconnected")
          ? "tunnel_down"
          : "invalid_response";
      return { ok: false, failure, error: message };
    }
  }

  private handleIncomingTunnelFrame(
    conn: TunnelConnection,
    type: number,
    streamId: number,
    payload: Buffer,
  ): void {
    if (type === TUNNEL_FRAME.PING) {
      this.sendTunnelFrame(conn, TUNNEL_FRAME.PONG, 0, payload);
      return;
    }
    if (type === TUNNEL_FRAME.PONG) {
      return;
    }
    const stream = conn.streams.get(streamId);
    if (!stream) return;

    if (stream.kind === "external_http") {
      if (type === TUNNEL_FRAME.HTTP_HEAD) {
        const meta = safeParseJson(payload) as {
          statusCode?: number;
          statusMessage?: string;
          headers?: Record<string, string | Array<string>>;
        } | null;
        if (!meta || stream.headReceived) return;
        stream.headReceived = true;
        const headers = stripHopByHopResponseHeaders(meta.headers ?? {});
        stream.res.writeHead(meta.statusCode ?? 502, meta.statusMessage, headers);
        return;
      }
      if (type === TUNNEL_FRAME.DATA) {
        if (!stream.closed && payload.length > 0) {
          stream.res.write(payload);
        }
        return;
      }
      if (type === TUNNEL_FRAME.END) {
        stream.closed = true;
        conn.streams.delete(streamId);
        if (!stream.res.writableEnded) {
          stream.res.end();
        }
        return;
      }
      if (type === TUNNEL_FRAME.CLOSE) {
        stream.closed = true;
        conn.streams.delete(streamId);
        if (!stream.headReceived && !stream.res.headersSent) {
          stream.res.writeHead(502, { "content-type": "application/json" });
          stream.res.end(JSON.stringify({ error: "upstream_closed" }));
        } else if (!stream.res.writableEnded) {
          stream.res.destroy();
        }
        return;
      }
      return;
    }

    if (stream.kind === "internal_http") {
      if (type === TUNNEL_FRAME.HTTP_HEAD) {
        const meta = safeParseJson(payload) as {
          statusCode?: number;
          headers?: Record<string, string | Array<string>>;
        } | null;
        stream.headReceived = true;
        stream.statusCode = meta?.statusCode ?? 502;
        stream.headers = meta?.headers ?? {};
        return;
      }
      if (type === TUNNEL_FRAME.DATA) {
        if (payload.length > 0) {
          stream.chunks.push(Buffer.from(payload));
        }
        return;
      }
      if (type === TUNNEL_FRAME.END) {
        clearTimeout(stream.timer);
        conn.streams.delete(streamId);
        stream.resolve({
          statusCode: stream.statusCode,
          headers: stream.headers,
          body: Buffer.concat(stream.chunks),
        });
        return;
      }
      if (type === TUNNEL_FRAME.CLOSE) {
        clearTimeout(stream.timer);
        conn.streams.delete(streamId);
        if (stream.headReceived) {
          stream.resolve({
            statusCode: stream.statusCode,
            headers: stream.headers,
            body: Buffer.concat(stream.chunks),
          });
        } else {
          stream.reject(new Error("Tunnel closed HTTP stream prematurely."));
        }
        return;
      }
      return;
    }

    if (stream.kind === "ws") {
      if (type === TUNNEL_FRAME.WS_ACK) {
        if (stream.acknowledged) return;
        stream.acknowledged = true;
        const meta = safeParseJson(payload) as {
          statusCode?: number;
          statusMessage?: string;
          headers?: Record<string, string | Array<string>>;
        } | null;
        const statusCode = meta?.statusCode ?? 502;
        const statusMessage =
          meta?.statusMessage ?? (statusCode === 101 ? "Switching Protocols" : "Bad Gateway");
        const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`];
        for (const [key, value] of Object.entries(meta?.headers ?? {})) {
          if (Array.isArray(value)) {
            for (const entry of value) lines.push(`${key}: ${entry}`);
          } else if (value !== undefined) {
            lines.push(`${key}: ${value}`);
          }
        }
        lines.push("", "");
        stream.socket.write(lines.join("\r\n"));
        if (statusCode === 101) {
          stream.socket.resume();
        } else {
          stream.closed = true;
          conn.streams.delete(streamId);
          stream.socket.end();
        }
        return;
      }
      if (type === TUNNEL_FRAME.DATA) {
        if (!stream.closed && payload.length > 0) {
          stream.socket.write(payload);
        }
        return;
      }
      if (type === TUNNEL_FRAME.END) {
        stream.closed = true;
        conn.streams.delete(streamId);
        stream.socket.end();
        return;
      }
      if (type === TUNNEL_FRAME.CLOSE) {
        stream.closed = true;
        conn.streams.delete(streamId);
        stream.socket.destroy();
      }
    }
  }

  private sendTunnelFrame(
    conn: TunnelConnection,
    type: number,
    streamId: number,
    payload?: Buffer | string,
  ): void {
    if (conn.closed || conn.socket.destroyed) return;
    const framePayload = encodeTunnelFrame(type, streamId, payload);
    const wsBytes = encodeWebSocketFrame({ opcode: 0x02, payload: framePayload, mask: false });
    conn.socket.write(wsBytes);
  }

  private cleanupConnection(conn: TunnelConnection, reason: string): void {
    if (conn.closed) return;
    conn.closed = true;
    clearInterval(conn.pingTimer);
    if (this.tunnels.get(conn.tunnelId) === conn) {
      this.tunnels.delete(conn.tunnelId);
    }
    for (const [, stream] of conn.streams) {
      if (stream.kind === "external_http") {
        stream.closed = true;
        if (!stream.res.headersSent) {
          stream.res.writeHead(502, { "content-type": "application/json" });
          stream.res.end(JSON.stringify({ error: reason }));
        } else if (!stream.res.writableEnded) {
          stream.res.destroy();
        }
      } else if (stream.kind === "internal_http") {
        clearTimeout(stream.timer);
        stream.reject(new Error(reason));
      } else if (stream.kind === "ws") {
        stream.closed = true;
        stream.socket.destroy();
      }
    }
    conn.streams.clear();
    if (!conn.socket.destroyed) {
      conn.socket.destroy();
    }
  }
}

function headerString(value: string | Array<string> | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function buildTunnelRequestHeaders(
  headers: NodeHttp.IncomingHttpHeaders,
  preserveUpgrade: boolean,
  options?: ProxyExternalOptions,
): Record<string, string | Array<string>> {
  const result = normalizeHeadersForTunnel(headers, preserveUpgrade);
  if (options?.forwardedHost) {
    result.host = options.forwardedHost;
  }
  if (!result["x-forwarded-proto"] && options?.forwardedProto) {
    result["x-forwarded-proto"] = options.forwardedProto;
  }
  if (options?.forwardedPrefix) {
    result["x-forwarded-prefix"] = options.forwardedPrefix;
  }
  return result;
}

function normalizeHeadersForTunnel(
  headers: NodeHttp.IncomingHttpHeaders,
  preserveUpgrade: boolean,
): Record<string, string | Array<string>> {
  const result: Record<string, string | Array<string>> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HTTP_HEADERS.has(lower)) {
      if (!preserveUpgrade || (lower !== "upgrade" && lower !== "connection")) {
        continue;
      }
    }
    result[key] = value;
  }
  return result;
}

function stripHopByHopResponseHeaders(
  headers: Record<string, string | Array<string>>,
): Record<string, string | Array<string>> {
  const result: Record<string, string | Array<string>> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HTTP_HEADERS.has(key.toLowerCase())) continue;
    result[key] = value;
  }
  return result;
}

function safeParseJson(payload: Buffer): unknown {
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
}
