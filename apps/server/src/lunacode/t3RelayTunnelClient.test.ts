// @effect-diagnostics nodeBuiltinImport:off - Exercises raw RFC 6455 binary tunnel frames against local Node HTTP and TCP servers.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import { describe, expect, it } from "vite-plus/test";

import { startT3RelayTunnelClient } from "./t3RelayTunnelClient.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const TUNNEL_FRAME = {
  OPEN_HTTP: 0x01,
  HTTP_HEAD: 0x02,
  DATA: 0x03,
  END: 0x04,
} as const;

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

function encodeServerBinaryWsFrame(payload: Buffer): Buffer {
  const len = payload.length;
  if (len < 126) {
    const out = Buffer.allocUnsafe(2 + len);
    out[0] = 0x82;
    out[1] = len;
    payload.copy(out, 2);
    return out;
  }
  const out = Buffer.allocUnsafe(4 + len);
  out[0] = 0x82;
  out[1] = 126;
  out.writeUInt16BE(len, 2);
  payload.copy(out, 4);
  return out;
}

function createWsDecoder(onBinary: (payload: Buffer) => void): (chunk: Buffer) => void {
  let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0]!;
      const b1 = buf[1]!;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        offset = 4;
      }
      const total = offset + (masked ? 4 : 0) + length;
      if (buf.length < total) return;
      const payload = Buffer.from(buf.subarray(offset + (masked ? 4 : 0), total));
      if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] = payload[i]! ^ mask[i & 3]!;
        }
      }
      buf = buf.subarray(total);
      if (opcode === 0x02) {
        onBinary(payload);
      }
    }
  };
}

describe("t3RelayTunnelClient", () => {
  it("connects to relay upgrade endpoint and forwards HTTP requests to the local server", async () => {
    const localServer = NodeHttp.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          path: req.url,
          host: req.headers.host,
          fwdHost: req.headers["x-forwarded-host"],
          fwdProto: req.headers["x-forwarded-proto"],
          fwdPrefix: req.headers["x-forwarded-prefix"],
        }),
      );
    });
    const localPort = await new Promise<number>((resolve) => {
      localServer.listen(0, "127.0.0.1", () => {
        resolve((localServer.address() as NodeNet.AddressInfo).port);
      });
    });

    let serverSocket: NodeStream.Duplex | undefined;
    let resolveSocket!: (socket: NodeStream.Duplex) => void;
    const socketReady = new Promise<NodeStream.Duplex>((resolve) => {
      resolveSocket = resolve;
    });

    let receivedHead: { statusCode: number } | null = null;
    const receivedChunks: Array<Buffer> = [];
    let resolveStreamEnd!: () => void;
    const streamEnded = new Promise<void>((resolve) => {
      resolveStreamEnd = resolve;
    });

    const mockRelayServer = NodeHttp.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    mockRelayServer.on("upgrade", (req, socket) => {
      expect(req.url).toBe("/_tunnel/connect");
      expect(req.headers["x-lunacode-tunnel-id"]).toBe("tun_test_client_1");
      expect(req.headers.authorization).toBe("Bearer lct_secret_1");

      const wsKey = String(req.headers["sec-websocket-key"] ?? "");
      const accept = NodeCrypto.createHash("sha1")
        .update(`${wsKey}${WS_GUID}`, "utf8")
        .digest("base64");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          "",
        ].join("\r\n"),
      );

      const decode = createWsDecoder((binary) => {
        if (binary.length < 5) return;
        const type = binary.readUInt8(0);
        const streamId = binary.readUInt32BE(1);
        const payload = binary.subarray(5);
        if (streamId !== 1) return;
        if (type === TUNNEL_FRAME.HTTP_HEAD) {
          receivedHead = JSON.parse(payload.toString("utf8")) as { statusCode: number };
        } else if (type === TUNNEL_FRAME.DATA) {
          receivedChunks.push(Buffer.from(payload));
        } else if (type === TUNNEL_FRAME.END) {
          resolveStreamEnd();
        }
      });
      socket.on("data", decode);
      resolveSocket(socket);
    });

    const relayPort = await new Promise<number>((resolve) => {
      mockRelayServer.listen(0, "127.0.0.1", () => {
        resolve((mockRelayServer.address() as NodeNet.AddressInfo).port);
      });
    });

    const client = startT3RelayTunnelClient({
      relayUrl: `http://127.0.0.1:${relayPort}`,
      tunnelId: "tun_test_client_1",
      connectorToken: "lct_secret_1",
      localHost: "127.0.0.1",
      localPort,
    });

    try {
      serverSocket = await socketReady;
      await client.ready;
      expect(client.isReady()).toBe(true);
      expect(client.isRunning()).toBe(true);

      const openFrame = encodeTunnelFrame(
        TUNNEL_FRAME.OPEN_HTTP,
        1,
        JSON.stringify({
          method: "GET",
          url: "/hello?a=1",
          headers: {
            host: "connect.example.com:8443",
            "x-forwarded-proto": "https",
            "x-forwarded-prefix": "/t/env-1",
          },
        }),
      );
      const endFrame = encodeTunnelFrame(TUNNEL_FRAME.END, 1);
      serverSocket.write(encodeServerBinaryWsFrame(openFrame));
      serverSocket.write(encodeServerBinaryWsFrame(endFrame));

      await streamEnded;
      expect(receivedHead).toMatchObject({ statusCode: 200 });
      expect(JSON.parse(Buffer.concat(receivedChunks).toString("utf8"))).toEqual({
        ok: true,
        path: "/hello?a=1",
        host: "connect.example.com:8443",
        fwdHost: "connect.example.com:8443",
        fwdProto: "https",
        fwdPrefix: "/t/env-1",
      });
    } finally {
      client.close();
      await client.exited;
      serverSocket?.destroy();
      mockRelayServer.closeAllConnections();
      localServer.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => mockRelayServer.close(() => resolve())),
        new Promise<void>((resolve) => localServer.close(() => resolve())),
      ]);
    }
  });

  it("parses X-Tunnel-Public-Host and X-Tunnel-Public-Url from 101 upgrade response", async () => {
    const localServer = NodeHttp.createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const localPort = await new Promise<number>((resolve) => {
      localServer.listen(0, "127.0.0.1", () => {
        resolve((localServer.address() as NodeNet.AddressInfo).port);
      });
    });

    let serverSocket: NodeStream.Duplex | undefined;
    const mockRelayServer = NodeHttp.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    mockRelayServer.on("upgrade", (req, socket) => {
      const wsKey = String(req.headers["sec-websocket-key"] ?? "");
      const accept = NodeCrypto.createHash("sha1")
        .update(`${wsKey}${WS_GUID}`, "utf8")
        .digest("base64");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "X-Tunnel-Public-Host: env-0123456789abcdef.example.com:8443",
          "X-Tunnel-Public-Url: https://env-0123456789abcdef.example.com:8443/",
          "",
          "",
        ].join("\r\n"),
      );
      serverSocket = socket;
    });

    const relayPort = await new Promise<number>((resolve) => {
      mockRelayServer.listen(0, "127.0.0.1", () => {
        resolve((mockRelayServer.address() as NodeNet.AddressInfo).port);
      });
    });

    const client = startT3RelayTunnelClient({
      relayUrl: `http://127.0.0.1:${relayPort}`,
      tunnelId: "tun_wildcard_1",
      connectorToken: "lct_secret_wildcard",
      localHost: "127.0.0.1",
      localPort,
    });

    try {
      await client.ready;
      expect(client.publicHost()).toBe("env-0123456789abcdef.example.com:8443");
      expect(client.publicUrl()).toBe("https://env-0123456789abcdef.example.com:8443/");
    } finally {
      client.close();
      await client.exited;
      serverSocket?.destroy();
      mockRelayServer.closeAllConnections();
      localServer.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => mockRelayServer.close(() => resolve())),
        new Promise<void>((resolve) => localServer.close(() => resolve())),
      ]);
    }
  });
});
