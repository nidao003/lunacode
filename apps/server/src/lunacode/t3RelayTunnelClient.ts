// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Zero-dependency RFC 6455 binary tunnel socket client runs outside Effect fibers.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import * as NodeTls from "node:tls";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const TUNNEL_FRAME = {
  OPEN_HTTP: 0x01,
  HTTP_HEAD: 0x02,
  DATA: 0x03,
  END: 0x04,
  CLOSE: 0x05,
  OPEN_WS: 0x06,
  WS_ACK: 0x07,
  PING: 0x08,
  PONG: 0x09,
} as const;

export interface T3RelayTunnelHandle {
  readonly originUrl: string;
  readonly ready: Promise<void>;
  readonly exited: Promise<void>;
  readonly isReady: () => boolean;
  readonly isRunning: () => boolean;
  readonly publicHost: () => string | null;
  readonly publicUrl: () => string | null;
  readonly close: () => void;
}

function extractHeaderFromHttpHead(headText: string, targetName: string): string | null {
  const targetLower = targetName.toLowerCase();
  const lines = headText.split("\r\n");
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() === targetLower) {
      const value = line.slice(colon + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

interface WsFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

interface ActiveLocalStream {
  readonly kind: "http" | "ws";
  req?: NodeHttp.ClientRequest;
  tcp?: NodeNet.Socket;
  tcpConnected?: boolean;
  pendingData?: Array<Buffer>;
  pendingEnd?: boolean;
}

function encodeTunnelFrame(type: number, streamId: number, payload?: Buffer | string): Buffer {
  const body =
    payload === undefined
      ? Buffer.alloc(0)
      : typeof payload === "string"
        ? Buffer.from(payload, "utf8")
        : payload;
  const out = Buffer.allocUnsafe(5 + body.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(streamId >>> 0, 1);
  if (body.length > 0) {
    body.copy(out, 5);
  }
  return out;
}

function decodeTunnelFrame(buf: Buffer) {
  if (buf.length < 5) return null;
  return {
    type: buf.readUInt8(0),
    streamId: buf.readUInt32BE(1),
    payload: buf.subarray(5),
  };
}

function encodeWebSocketFrame(opcode: number, payload?: Buffer): Buffer {
  const body = payload ?? Buffer.alloc(0);
  const len = body.length;
  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) headerLen += 2;
  else if (len > 0xffff) headerLen += 8;
  const out = Buffer.allocUnsafe(headerLen + 4 + len);
  out[0] = 0x80 | (opcode & 0x0f);
  if (len < 126) {
    out[1] = 0x80 | len;
  } else if (len <= 0xffff) {
    out[1] = 0x80 | 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 0x80 | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  const maskKey = NodeCrypto.randomBytes(4);
  maskKey.copy(out, headerLen);
  const offset = headerLen + 4;
  for (let i = 0; i < len; i += 1) {
    out[offset + i] = body[i]! ^ maskKey[i & 3]!;
  }
  return out;
}

function createWebSocketDecoder(onFrame: (frame: WsFrame) => void): (chunk: Buffer) => void {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let fragmentedOpcode: number | null = null;
  let fragmentedChunks: Array<Buffer> = [];

  return (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const b0 = buffer[0]!;
      const b1 = buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const bigLen = buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(64 * 1024 * 1024)) {
          throw new Error("WebSocket frame exceeds limit");
        }
        length = Number(bigLen);
        offset = 10;
      }
      const totalLen = offset + (masked ? 4 : 0) + length;
      if (buffer.length < totalLen) return;
      const payload = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), totalLen));
      if (masked) {
        const maskKey = buffer.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] = payload[i]! ^ maskKey[i & 3]!;
        }
      }
      buffer = buffer.subarray(totalLen);

      if ((opcode & 0x08) !== 0) {
        onFrame({ fin, opcode, payload });
        continue;
      }
      if (opcode === 0x00) {
        fragmentedChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(fragmentedChunks);
          const effective = fragmentedOpcode ?? 0x02;
          fragmentedOpcode = null;
          fragmentedChunks = [];
          onFrame({ fin: true, opcode: effective, payload: full });
        }
        continue;
      }
      if (!fin) {
        fragmentedOpcode = opcode;
        fragmentedChunks = [payload];
        continue;
      }
      onFrame({ fin: true, opcode, payload });
    }
  };
}

export function startT3RelayTunnelClient(input: {
  readonly relayUrl: string;
  readonly tunnelId: string;
  readonly connectorToken: string;
  readonly localHost: string;
  readonly localPort: number;
  readonly rejectUnauthorized?: boolean;
}): T3RelayTunnelHandle {
  const endpoint = new URL("/_tunnel/connect", input.relayUrl);
  const isTls = endpoint.protocol === "https:" || endpoint.protocol === "wss:";
  const remotePort = Number(endpoint.port || (isTls ? 443 : 80));
  const remoteHost = endpoint.hostname;
  const originUrl = `http://${input.localHost}:${input.localPort}/`;

  const socket: NodeStream.Duplex = isTls
    ? NodeTls.connect({
        host: remoteHost,
        port: remotePort,
        servername: remoteHost,
        ...(input.rejectUnauthorized !== undefined
          ? { rejectUnauthorized: input.rejectUnauthorized }
          : {}),
      })
    : NodeNet.connect({ host: remoteHost, port: remotePort });

  const wsKey = NodeCrypto.randomBytes(16).toString("base64");
  const expectedAccept = NodeCrypto.createHash("sha1")
    .update(`${wsKey}${WS_GUID}`, "utf8")
    .digest("base64");
  const streams = new Map<number, ActiveLocalStream>();

  let handshakeDone = false;
  let running = true;
  let closed = false;
  let headBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  let resolveReady: () => void = () => {};
  let rejectReady: (err: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveExited: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });

  const sendTunnelFrame = (type: number, streamId: number, payload?: Buffer | string) => {
    if (closed || socket.destroyed) return;
    socket.write(encodeWebSocketFrame(0x02, encodeTunnelFrame(type, streamId, payload)));
  };

  const cleanup = (reason?: Error) => {
    if (closed) return;
    closed = true;
    running = false;
    clearInterval(pingTimer);
    for (const stream of streams.values()) {
      stream.req?.destroy();
      stream.tcp?.destroy();
    }
    streams.clear();
    if (!handshakeDone) {
      rejectReady(reason ?? new Error("Tunnel closed before handshake completed."));
    }
    if (!socket.destroyed) {
      socket.destroy();
    }
    resolveExited();
  };

  const pingTimer = setInterval(() => {
    if (!closed && handshakeDone && !socket.destroyed) {
      socket.write(encodeWebSocketFrame(0x09));
    }
  }, 25_000);
  pingTimer.unref?.();

  const decode = createWebSocketDecoder((wsFrame) => {
    if (closed) return;
    if (wsFrame.opcode === 0x08) {
      cleanup();
      return;
    }
    if (wsFrame.opcode === 0x09) {
      socket.write(encodeWebSocketFrame(0x0a, wsFrame.payload));
      return;
    }
    if (wsFrame.opcode !== 0x02) return;
    const frame = decodeTunnelFrame(wsFrame.payload);
    if (!frame) return;

    if (frame.type === TUNNEL_FRAME.PING) {
      sendTunnelFrame(TUNNEL_FRAME.PONG, 0, frame.payload);
      return;
    }
    if (frame.type === TUNNEL_FRAME.PONG) return;

    if (frame.type === TUNNEL_FRAME.OPEN_HTTP) {
      const meta = JSON.parse(frame.payload.toString("utf8")) as {
        method?: string;
        url?: string;
        headers?: Record<string, string | Array<string>>;
      };
      const headers: Record<string, string | Array<string>> = { ...meta.headers };
      const hostKey = Object.keys(headers).find((key) => key.toLowerCase() === "host");
      const rawHost = hostKey ? headers[hostKey] : undefined;
      const origHost = Array.isArray(rawHost) ? rawHost[0] : rawHost;
      if (origHost) {
        if (hostKey && hostKey !== "host") {
          delete headers[hostKey];
        }
        headers.host = origHost;
        if (!headers["x-forwarded-host"]) {
          headers["x-forwarded-host"] = origHost;
        }
      } else {
        headers.host = `${input.localHost}:${input.localPort}`;
      }

      const upstreamReq = NodeHttp.request(
        {
          host: input.localHost,
          port: input.localPort,
          method: meta.method ?? "GET",
          path: meta.url ?? "/",
          headers,
        },
        (upstreamRes) => {
          sendTunnelFrame(
            TUNNEL_FRAME.HTTP_HEAD,
            frame.streamId,
            JSON.stringify({
              statusCode: upstreamRes.statusCode ?? 200,
              statusMessage: upstreamRes.statusMessage ?? "OK",
              headers: upstreamRes.headers,
            }),
          );
          upstreamRes.on("data", (chunk: Buffer) =>
            sendTunnelFrame(TUNNEL_FRAME.DATA, frame.streamId, chunk),
          );
          upstreamRes.on("end", () => {
            sendTunnelFrame(TUNNEL_FRAME.END, frame.streamId);
            streams.delete(frame.streamId);
          });
          upstreamRes.on("error", () => {
            sendTunnelFrame(TUNNEL_FRAME.CLOSE, frame.streamId);
            streams.delete(frame.streamId);
          });
        },
      );
      upstreamReq.on("error", () => {
        sendTunnelFrame(TUNNEL_FRAME.CLOSE, frame.streamId);
        streams.delete(frame.streamId);
      });
      streams.set(frame.streamId, { kind: "http", req: upstreamReq });
      return;
    }

    if (frame.type === TUNNEL_FRAME.OPEN_WS) {
      const meta = JSON.parse(frame.payload.toString("utf8")) as {
        method?: string;
        url?: string;
        headers?: Record<string, string | Array<string>>;
      };
      const tcp = NodeNet.connect(input.localPort, input.localHost);
      const stream: ActiveLocalStream = {
        kind: "ws",
        tcp,
        tcpConnected: false,
        pendingData: [],
        pendingEnd: false,
      };
      streams.set(frame.streamId, stream);

      let parsedHead = false;
      let tcpBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

      tcp.on("connect", () => {
        stream.tcpConnected = true;
        const headerEntries = Object.entries(meta.headers ?? {});
        const hasHostHeader = headerEntries.some(
          ([k, v]) => k.toLowerCase() === "host" && (Array.isArray(v) ? v.length > 0 : Boolean(v)),
        );
        const lines = [`${meta.method ?? "GET"} ${meta.url ?? "/"} HTTP/1.1`];
        for (const [k, v] of headerEntries) {
          if (Array.isArray(v)) {
            for (const entry of v) lines.push(`${k}: ${entry}`);
          } else {
            lines.push(`${k}: ${v}`);
          }
        }
        if (!hasHostHeader) {
          lines.push(`Host: ${input.localHost}:${input.localPort}`);
        }
        lines.push("", "");
        tcp.write(lines.join("\r\n"));
        for (const chunk of stream.pendingData ?? []) {
          tcp.write(chunk);
        }
        stream.pendingData = [];
        if (stream.pendingEnd) {
          tcp.end();
        }
      });

      tcp.on("data", (chunk: Buffer) => {
        if (parsedHead) {
          sendTunnelFrame(TUNNEL_FRAME.DATA, frame.streamId, chunk);
          return;
        }
        tcpBuf = Buffer.concat([tcpBuf, chunk]);
        const sep = tcpBuf.indexOf("\r\n\r\n");
        if (sep === -1) return;
        parsedHead = true;
        const rawHead = tcpBuf.subarray(0, sep).toString("latin1");
        const rest = tcpBuf.subarray(sep + 4);
        const headLines = rawHead.split("\r\n");
        const statusMatch = /^HTTP\/1\.\d\s+(\d+)\s*(.*)$/u.exec(headLines[0] ?? "");
        const responseHeaders: Record<string, string> = {};
        for (const line of headLines.slice(1)) {
          const colon = line.indexOf(":");
          if (colon > 0) {
            responseHeaders[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
          }
        }
        const statusCode = statusMatch ? Number(statusMatch[1]) : 101;
        sendTunnelFrame(
          TUNNEL_FRAME.WS_ACK,
          frame.streamId,
          JSON.stringify({
            statusCode,
            statusMessage: statusMatch?.[2] || "Switching Protocols",
            headers: responseHeaders,
          }),
        );
        if (rest.length > 0 && statusCode === 101) {
          sendTunnelFrame(TUNNEL_FRAME.DATA, frame.streamId, rest);
        }
        if (statusCode !== 101) {
          tcp.destroy();
          streams.delete(frame.streamId);
        }
      });

      tcp.on("end", () => {
        sendTunnelFrame(TUNNEL_FRAME.END, frame.streamId);
        streams.delete(frame.streamId);
      });
      tcp.on("close", () => streams.delete(frame.streamId));
      tcp.on("error", () => {
        sendTunnelFrame(TUNNEL_FRAME.CLOSE, frame.streamId);
        streams.delete(frame.streamId);
      });
      return;
    }

    const active = streams.get(frame.streamId);
    if (!active) return;

    if (frame.type === TUNNEL_FRAME.DATA) {
      if (active.kind === "http") {
        active.req?.write(frame.payload);
      } else if (active.tcpConnected) {
        active.tcp?.write(frame.payload);
      } else {
        active.pendingData?.push(Buffer.from(frame.payload));
      }
      return;
    }

    if (frame.type === TUNNEL_FRAME.END) {
      if (active.kind === "http") {
        active.req?.end();
      } else if (active.tcpConnected) {
        active.tcp?.end();
      } else {
        active.pendingEnd = true;
      }
      return;
    }

    if (frame.type === TUNNEL_FRAME.CLOSE) {
      active.req?.destroy();
      active.tcp?.destroy();
      streams.delete(frame.streamId);
    }
  });

  const sendUpgradeRequest = () => {
    socket.write(
      [
        `GET ${endpoint.pathname}${endpoint.search} HTTP/1.1`,
        `Host: ${endpoint.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${wsKey}`,
        "Sec-WebSocket-Version: 13",
        `x-lunacode-tunnel-id: ${input.tunnelId}`,
        `Authorization: Bearer ${input.connectorToken}`,
        "",
        "",
      ].join("\r\n"),
    );
  };

  let parsedPublicHost: string | null = null;
  let parsedPublicUrl: string | null = null;

  socket.on(isTls ? "secureConnect" : "connect", sendUpgradeRequest);
  socket.on("data", (chunk: Buffer) => {
    if (!handshakeDone) {
      headBuffer = Buffer.concat([headBuffer, chunk]);
      const sep = headBuffer.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const headText = headBuffer.subarray(0, sep).toString("latin1");
      if (!headText.includes(" 101 ") || !headText.includes(expectedAccept)) {
        cleanup(
          new Error(`Unexpected relay tunnel upgrade response: ${headText.split("\r\n")[0] ?? ""}`),
        );
        return;
      }
      parsedPublicHost = extractHeaderFromHttpHead(headText, "x-tunnel-public-host");
      parsedPublicUrl = extractHeaderFromHttpHead(headText, "x-tunnel-public-url");
      handshakeDone = true;
      resolveReady();
      const rest = headBuffer.subarray(sep + 4);
      if (rest.length > 0) {
        try {
          decode(rest);
        } catch (error) {
          cleanup(error instanceof Error ? error : new Error(String(error)));
        }
      }
      return;
    }
    try {
      decode(chunk);
    } catch (error) {
      cleanup(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.on("close", () => cleanup());
  socket.on("error", (error: Error) => cleanup(error));

  return {
    originUrl,
    ready,
    exited,
    isReady: () => handshakeDone && !closed,
    isRunning: () => running && !closed,
    publicHost: () => parsedPublicHost,
    publicUrl: () => parsedPublicUrl,
    close: () => {
      if (!closed && handshakeDone && !socket.destroyed) {
        socket.write(encodeWebSocketFrame(0x08));
      }
      cleanup();
    },
  };
}
