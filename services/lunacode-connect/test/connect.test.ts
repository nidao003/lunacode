import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import type * as NodeStream from "node:stream";
import * as NodeTest from "node:test";

import { loadConnectConfig } from "../src/config.ts";
import {
  hashPassword,
  nowEpochSeconds,
  sha256Base64Url,
  signEdDsaJwt,
  verifyEdDsaJwt,
} from "../src/crypto.ts";
import { startConnectServer, type ConnectServerInstance } from "../src/server.ts";
import {
  computeWebSocketAccept,
  createWebSocketFrameDecoder,
  decodeTunnelFrame,
  encodeTunnelFrame,
  encodeWebSocketFrame,
  TUNNEL_FRAME,
} from "../src/tunnelProtocol.ts";

function randomAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = NodeNet.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as NodeNet.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

function createDpopProof(input: {
  readonly keyPair: NodeCrypto.KeyPairKeyObjectResult;
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string;
}): string {
  const pubJwk = input.keyPair.publicKey.export({ format: "jwk" }) as {
    kty: string;
    crv: string;
    x: string;
    y: string;
  };
  const header = Buffer.from(
    JSON.stringify({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: { kty: pubJwk.kty, crv: pubJwk.crv, x: pubJwk.x, y: pubJwk.y },
    }),
    "utf8",
  ).toString("base64url");
  const payloadObj: Record<string, unknown> = {
    htm: input.method,
    htu: input.url,
    jti: NodeCrypto.randomUUID(),
    iat: nowEpochSeconds(),
  };
  if (input.accessToken) {
    payloadObj.ath = sha256Base64Url(input.accessToken);
  }
  const payload = Buffer.from(JSON.stringify(payloadObj), "utf8").toString("base64url");
  const sig = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`, "utf8"), {
    key: input.keyPair.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

function computeThumbprint(keyPair: NodeCrypto.KeyPairKeyObjectResult): string {
  const pubJwk = keyPair.publicKey.export({ format: "jwk" }) as {
    kty: string;
    crv: string;
    x: string;
    y: string;
  };
  return sha256Base64Url(
    JSON.stringify({ crv: pubJwk.crv, kty: pubJwk.kty, x: pubJwk.x, y: pubJwk.y }),
  );
}

function connectTunnelWs(input: {
  readonly port: number;
  readonly tunnelId: string;
  readonly connectorToken: string;
  readonly targetPort: number;
}): Promise<{
  readonly close: () => void;
  readonly closeAndAwait: () => Promise<void>;
  readonly headers: Record<string, string>;
}> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.connect(input.port, "127.0.0.1");
    const wsKey = NodeCrypto.randomBytes(16).toString("base64");
    const expectedAccept = computeWebSocketAccept(wsKey);
    let handshakeDone = false;
    let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    const localStreams = new Map<number, { req?: NodeHttp.ClientRequest; tcp?: NodeNet.Socket }>();
    const sendFrame = (type: number, streamId: number, payload?: Buffer | string) => {
      const frame = encodeTunnelFrame(type, streamId, payload);
      socket.write(encodeWebSocketFrame({ opcode: 0x02, payload: frame, mask: true }));
    };

    const decode = createWebSocketFrameDecoder((wsFrame) => {
      if (wsFrame.opcode === 0x09) {
        socket.write(encodeWebSocketFrame({ opcode: 0x0a, payload: wsFrame.payload, mask: true }));
        return;
      }
      if (wsFrame.opcode !== 0x02) return;
      const frame = decodeTunnelFrame(wsFrame.payload);
      if (!frame) return;

      if (frame.type === TUNNEL_FRAME.PING) {
        sendFrame(TUNNEL_FRAME.PONG, 0, frame.payload);
        return;
      }

      if (frame.type === TUNNEL_FRAME.OPEN_HTTP) {
        const meta = JSON.parse(frame.payload.toString("utf8")) as {
          method: string;
          url: string;
          headers: Record<string, string | Array<string>>;
        };
        const upstreamReq = NodeHttp.request(
          {
            host: "127.0.0.1",
            port: input.targetPort,
            method: meta.method,
            path: meta.url,
            headers: meta.headers.host
              ? meta.headers
              : { ...meta.headers, host: `127.0.0.1:${input.targetPort}` },
          },
          (upstreamRes) => {
            sendFrame(
              TUNNEL_FRAME.HTTP_HEAD,
              frame.streamId,
              JSON.stringify({
                statusCode: upstreamRes.statusCode ?? 200,
                statusMessage: upstreamRes.statusMessage ?? "OK",
                headers: upstreamRes.headers,
              }),
            );
            upstreamRes.on("data", (chunk: Buffer) =>
              sendFrame(TUNNEL_FRAME.DATA, frame.streamId, chunk),
            );
            upstreamRes.on("end", () => {
              sendFrame(TUNNEL_FRAME.END, frame.streamId);
              localStreams.delete(frame.streamId);
            });
          },
        );
        upstreamReq.on("error", () => {
          sendFrame(TUNNEL_FRAME.CLOSE, frame.streamId);
          localStreams.delete(frame.streamId);
        });
        localStreams.set(frame.streamId, { req: upstreamReq });
        return;
      }

      if (frame.type === TUNNEL_FRAME.OPEN_WS) {
        const meta = JSON.parse(frame.payload.toString("utf8")) as {
          method: string;
          url: string;
          headers: Record<string, string | Array<string>>;
        };
        const tcp = NodeNet.connect(input.targetPort, "127.0.0.1");
        let parsedHead = false;
        let tcpBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        tcp.on("connect", () => {
          const entries = Object.entries(meta.headers);
          const hasHost = entries.some(([k, v]) => k.toLowerCase() === "host" && Boolean(v));
          const lines = [`${meta.method || "GET"} ${meta.url || "/"} HTTP/1.1`];
          for (const [k, v] of entries) {
            lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
          }
          if (!hasHost) {
            lines.push(`Host: 127.0.0.1:${input.targetPort}`);
          }
          lines.push("", "");
          tcp.write(lines.join("\r\n"));
        });
        tcp.on("data", (chunk: Buffer) => {
          if (parsedHead) {
            sendFrame(TUNNEL_FRAME.DATA, frame.streamId, chunk);
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
          const headers: Record<string, string> = {};
          for (const line of headLines.slice(1)) {
            const colon = line.indexOf(":");
            if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
          }
          sendFrame(
            TUNNEL_FRAME.WS_ACK,
            frame.streamId,
            JSON.stringify({
              statusCode: statusMatch ? Number(statusMatch[1]) : 101,
              statusMessage: statusMatch?.[2] || "Switching Protocols",
              headers,
            }),
          );
          if (rest.length > 0) sendFrame(TUNNEL_FRAME.DATA, frame.streamId, rest);
        });
        tcp.on("end", () => sendFrame(TUNNEL_FRAME.END, frame.streamId));
        tcp.on("close", () => localStreams.delete(frame.streamId));
        localStreams.set(frame.streamId, { tcp });
        return;
      }

      const active = localStreams.get(frame.streamId);
      if (!active) return;
      if (frame.type === TUNNEL_FRAME.DATA) {
        if (active.req) active.req.write(frame.payload);
        else if (active.tcp) active.tcp.write(frame.payload);
      } else if (frame.type === TUNNEL_FRAME.END) {
        if (active.req) active.req.end();
        else if (active.tcp) active.tcp.end();
      } else if (frame.type === TUNNEL_FRAME.CLOSE) {
        active.req?.destroy();
        active.tcp?.destroy();
        localStreams.delete(frame.streamId);
      }
    });

    socket.on("connect", () => {
      socket.write(
        [
          "GET /_tunnel/connect HTTP/1.1",
          `Host: 127.0.0.1:${input.port}`,
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
    });

    socket.on("data", (chunk: Buffer) => {
      if (!handshakeDone) {
        buf = Buffer.concat([buf, chunk]);
        const sep = buf.indexOf("\r\n\r\n");
        if (sep === -1) return;
        const headText = buf.subarray(0, sep).toString("latin1");
        if (!headText.includes("101") || !headText.includes(expectedAccept)) {
          reject(new Error(`Unexpected handshake response: ${headText}`));
          socket.destroy();
          return;
        }
        const headers: Record<string, string> = {};
        for (const line of headText.split("\r\n").slice(1)) {
          const colon = line.indexOf(":");
          if (colon > 0) {
            headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
          }
        }
        handshakeDone = true;
        const remainder = buf.subarray(sep + 4);
        if (remainder.length > 0) decode(remainder);
        resolve({
          close: () => socket.destroy(),
          closeAndAwait: () =>
            new Promise<void>((done) => {
              if (socket.destroyed) {
                done();
                return;
              }
              socket.once("close", () => done());
              socket.write(
                encodeWebSocketFrame({ opcode: 0x08, payload: Buffer.alloc(0), mask: true }),
              );
              socket.end();
            }),
          headers,
        });
        return;
      }
      decode(chunk);
    });

    socket.once("error", reject);
  });
}

NodeTest.describe("lunacode-connect backend integration", () => {
  let tempDir = "";
  let connectServer: ConnectServerInstance;
  let mockEnvServer: NodeHttp.Server;
  let connectPort = 0;
  let mockEnvPort = 0;
  let envKeys: NodeCrypto.KeyPairKeyObjectResult;
  let envPublicKeyPem = "";
  let envPrivateKeyPem = "";
  const environmentId = "env_test_machine_1";

  const activeMockSockets = new Set<NodeNet.Socket | NodeStream.Duplex>();

  NodeTest.before(async () => {
    tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lunacode-connect-test-"));
    connectPort = await randomAvailablePort();
    envKeys = NodeCrypto.generateKeyPairSync("ed25519");
    envPublicKeyPem = envKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    envPrivateKeyPem = envKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const cfg = loadConnectConfig({
      HOST: "127.0.0.1",
      PORT: String(connectPort),
      DATA_DIR: tempDir,
      PUBLIC_ORIGIN: `http://127.0.0.1:${connectPort}`,
      TUNNEL_WILDCARD_DOMAIN: "connect.local.test",
      TUNNEL_BASE_SCHEME: "http",
      ALLOW_REGISTRATION: "true",
    });
    connectServer = await startConnectServer(cfg);

    mockEnvServer = NodeHttp.createServer((req, res) => {
      if (req.url === "/ping") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, host: req.headers.host }));
        return;
      }
      const chunks: Array<Buffer> = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          proof?: string;
        };
        const nowSec = nowEpochSeconds();
        if (req.url === "/api/t3-connect/health") {
          const verified = verifyEdDsaJwt({
            publicKeyPem: connectServer.mintKeys.publicKeyPem,
            token: body.proof ?? "",
            expectedTyp: "t3-cloud-health+jwt",
            expectedIssuer: connectServer.origin,
            expectedAudience: `t3-env:${environmentId}`,
          });
          NodeAssert.equal(verified.ok, true);
          const responseProof = signEdDsaJwt({
            privateKeyPem: envPrivateKeyPem,
            typ: "t3-env-health+jwt",
            payload: {
              iss: `t3-env:${environmentId}`,
              aud: connectServer.origin,
              sub: environmentId,
              jti: NodeCrypto.randomUUID(),
              iat: nowSec,
              exp: nowSec + 120,
              environmentId,
              requestNonce: verified.claims.nonce,
              status: "online",
            },
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              environmentId,
              status: "online",
              checkedAt: "2026-01-01T00:00:00.000Z",
              descriptor: { environmentId, label: "Test Mac" },
              proof: responseProof,
            }),
          );
          return;
        }
        if (req.url === "/api/t3-connect/mint-credential") {
          const verified = verifyEdDsaJwt({
            publicKeyPem: connectServer.mintKeys.publicKeyPem,
            token: body.proof ?? "",
            expectedTyp: "t3-cloud-mint+jwt",
            expectedIssuer: connectServer.origin,
            expectedAudience: `t3-env:${environmentId}`,
          });
          NodeAssert.equal(verified.ok, true);
          const cred = `session_cred_${NodeCrypto.randomBytes(8).toString("hex")}`;
          const responseProof = signEdDsaJwt({
            privateKeyPem: envPrivateKeyPem,
            typ: "t3-env-mint+jwt",
            payload: {
              iss: `t3-env:${environmentId}`,
              aud: connectServer.origin,
              sub: environmentId,
              jti: NodeCrypto.randomUUID(),
              iat: nowSec,
              exp: nowSec + 120,
              environmentId,
              clientProofKeyThumbprint: verified.claims.clientProofKeyThumbprint,
              requestNonce: verified.claims.nonce,
              credential: cred,
            },
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              credential: cred,
              expiresAt: new Date((nowSec + 300) * 1_000).toISOString(),
              proof: responseProof,
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    mockEnvServer.on("upgrade", (req, socket) => {
      activeMockSockets.add(socket);
      socket.once("close", () => activeMockSockets.delete(socket));
      const wsKey = String(req.headers["sec-websocket-key"] ?? "");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${computeWebSocketAccept(wsKey)}`,
          "",
          "",
        ].join("\r\n"),
      );
      const dec = createWebSocketFrameDecoder((frame) => {
        if (frame.opcode === 0x01 || frame.opcode === 0x02) {
          socket.write(encodeWebSocketFrame({ opcode: frame.opcode, payload: frame.payload }));
        }
      });
      socket.on("data", (chunk: Buffer) => dec(chunk));
    });

    await new Promise<void>((resolve) => {
      mockEnvServer.listen(0, "127.0.0.1", () => {
        mockEnvPort = (mockEnvServer.address() as NodeNet.AddressInfo).port;
        resolve();
      });
    });
  });

  NodeTest.after(async () => {
    for (const sock of activeMockSockets) sock.destroy();
    await connectServer.close();
    mockEnvServer.closeAllConnections();
    await new Promise<void>((resolve) => mockEnvServer.close(() => resolve()));
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  });

  NodeTest.it(
    "returns b3 and traceparent in CORS preflight allow-headers for packaged Desktop origin",
    async () => {
      const base = connectServer.origin;
      const preflight = await fetch(`${base}/v1/client/environment-link-challenges`, {
        method: "OPTIONS",
        headers: {
          origin: "t3code://app",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,b3,content-type,traceparent",
        },
      });
      NodeAssert.equal(preflight.status, 204);
      NodeAssert.equal(preflight.headers.get("access-control-allow-origin"), "t3code://app");
      NodeAssert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
      const allowedHeaders = (preflight.headers.get("access-control-allow-headers") ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase());
      NodeAssert.ok(allowedHeaders.includes("authorization"));
      NodeAssert.ok(allowedHeaders.includes("content-type"));
      NodeAssert.ok(allowedHeaders.includes("dpop"));
      NodeAssert.ok(allowedHeaders.includes("b3"));
      NodeAssert.ok(allowedHeaders.includes("traceparent"));
      const exposedHeaders = (preflight.headers.get("access-control-expose-headers") ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase());
      NodeAssert.ok(exposedHeaders.includes("traceparent"));
      NodeAssert.ok(exposedHeaders.includes("www-authenticate"));
    },
  );

  NodeTest.it(
    "supports account registration, OAuth PKCE & Device Code, DPoP exchange, t3_relay tunnel HTTP/WS proxying, and revocation",
    async () => {
      const base = connectServer.origin;

      const healthRes = await fetch(`${base}/health`);
      NodeAssert.equal(healthRes.status, 200);
      NodeAssert.deepEqual(await healthRes.json(), { ok: true, service: "relay" });

      const regRes = await fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "Alice@Example.com",
          password: "strong-password-123",
          displayName: "Alice",
        }),
      });
      NodeAssert.equal(regRes.status, 201);
      const regJson = (await regRes.json()) as {
        user: { id: string; email: string };
        accessToken: string;
        refreshToken: string;
      };
      NodeAssert.equal(regJson.user.email, "alice@example.com");

      // PKCE CLI authorize + exchange
      const verifier = NodeCrypto.randomBytes(32).toString("base64url");
      const challenge = sha256Base64Url(verifier);
      const cliAuthRes = await fetch(`${base}/api/auth/cli/authorize`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${regJson.accessToken}`,
        },
        body: JSON.stringify({
          state: "st_123",
          challenge,
          loopbackPort: 34338,
        }),
      });
      NodeAssert.equal(cliAuthRes.status, 200);
      const { redirectTo } = (await cliAuthRes.json()) as { redirectTo: string };
      const callbackUrl = new URL(redirectTo);
      const code = callbackUrl.searchParams.get("code")!;
      NodeAssert.equal(callbackUrl.searchParams.get("state"), "st_123");

      const oauthTokenRes = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://127.0.0.1:34338/callback",
          client_id: "lunacode-cli",
          code_verifier: verifier,
        }),
      });
      NodeAssert.equal(oauthTokenRes.status, 200);
      const oauthTokens = (await oauthTokenRes.json()) as {
        access_token: string;
        refresh_token: string;
        id_token: string;
      };
      NodeAssert.ok(oauthTokens.access_token);
      NodeAssert.ok(oauthTokens.id_token);

      // Device code grant flow
      const deviceInitRes = await fetch(`${base}/oauth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "lunacode-cli", scope: "openid email" }),
      });
      NodeAssert.equal(deviceInitRes.status, 200);
      const deviceInit = (await deviceInitRes.json()) as {
        device_code: string;
        user_code: string;
      };
      const approveRes = await fetch(`${base}/oauth/device/approve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${oauthTokens.access_token}`,
        },
        body: JSON.stringify({ userCode: deviceInit.user_code }),
      });
      NodeAssert.equal(approveRes.status, 200);
      const devicePollRes = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceInit.device_code,
          client_id: "lunacode-cli",
        }),
      });
      NodeAssert.equal(devicePollRes.status, 200);

      // Link challenge + environment link provisioning t3_relay
      const challengeRes = await fetch(`${base}/v1/client/environment-link-challenges`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${regJson.accessToken}`,
        },
        body: JSON.stringify({
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled: true,
        }),
      });
      NodeAssert.equal(challengeRes.status, 200);
      const { challenge: linkChallenge } = (await challengeRes.json()) as { challenge: string };

      const nowSec = nowEpochSeconds();
      const linkProof = signEdDsaJwt({
        privateKeyPem: envPrivateKeyPem,
        typ: "t3-env-link+jwt",
        payload: {
          iss: `t3-env:${environmentId}`,
          aud: base,
          sub: environmentId,
          jti: NodeCrypto.randomUUID(),
          iat: nowSec,
          exp: nowSec + 300,
          challenge: linkChallenge,
          descriptor: { environmentId, label: "Test Mac" },
          environmentId,
          environmentPublicKey: envPublicKeyPem,
          endpoint: {
            httpBaseUrl: `${base}/`,
            wsBaseUrl: `${base.replace(/^http/u, "ws")}/`,
            providerKind: "t3_relay",
          },
          origin: { localHttpHost: "127.0.0.1", localHttpPort: mockEnvPort },
          scopes: ["agent_activity_notifications", "managed_tunnels"],
        },
      });

      const linkRes = await fetch(`${base}/v1/client/environment-links`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${regJson.accessToken}`,
        },
        body: JSON.stringify({
          proof: linkProof,
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled: true,
        }),
      });
      NodeAssert.equal(linkRes.status, 200);
      const linked = (await linkRes.json()) as {
        ok: boolean;
        cloudUserId: string;
        endpoint: { httpBaseUrl: string; wsBaseUrl: string; providerKind: string };
        endpointRuntime: {
          providerKind: string;
          connectorToken: string;
          tunnelId: string;
          tunnelName: string;
        };
        environmentCredential: string;
      };
      NodeAssert.equal(linked.ok, true);
      NodeAssert.equal(linked.endpoint.providerKind, "t3_relay");
      NodeAssert.equal(linked.endpointRuntime.providerKind, "t3_relay");

      // Exchange DPoP token
      const dpopKeyPair = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      const jkt = computeThumbprint(dpopKeyPair);
      const dpopExchangeRes = await fetch(`${base}/v1/client/dpop-token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          dpop: createDpopProof({
            keyPair: dpopKeyPair,
            method: "POST",
            url: `${base}/v1/client/dpop-token`,
          }),
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: regJson.accessToken,
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          resource: base,
          scope: "environment:connect environment:status",
          client_id: "t3-web",
        }),
      });
      NodeAssert.equal(dpopExchangeRes.status, 200);
      const { access_token: dpopToken } = (await dpopExchangeRes.json()) as {
        access_token: string;
      };

      // Before tunnel connects, status reports offline
      const offlineStatusRes = await fetch(`${base}/v1/environments/${environmentId}/status`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `DPoP ${dpopToken}`,
          dpop: createDpopProof({
            keyPair: dpopKeyPair,
            method: "POST",
            url: `${base}/v1/environments/${environmentId}/status`,
            accessToken: dpopToken,
          }),
        },
        body: "{}",
      });
      NodeAssert.equal(offlineStatusRes.status, 200);
      NodeAssert.equal(((await offlineStatusRes.json()) as { status: string }).status, "offline");

      // Connect t3_relay WS tunnel
      const tunnelConn = await connectTunnelWs({
        port: connectPort,
        tunnelId: linked.endpointRuntime.tunnelId,
        connectorToken: linked.endpointRuntime.connectorToken,
        targetPort: mockEnvPort,
      });

      // Status now succeeds end-to-end through tunnel
      const onlineStatusRes = await fetch(`${base}/v1/environments/${environmentId}/status`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `DPoP ${dpopToken}`,
          dpop: createDpopProof({
            keyPair: dpopKeyPair,
            method: "POST",
            url: `${base}/v1/environments/${environmentId}/status`,
            accessToken: dpopToken,
          }),
        },
        body: "{}",
      });
      NodeAssert.equal(onlineStatusRes.status, 200);
      NodeAssert.equal(((await onlineStatusRes.json()) as { status: string }).status, "online");

      // /connect mints short-lived environment credential through tunnel
      const connectRes = await fetch(`${base}/v1/environments/${environmentId}/connect`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `DPoP ${dpopToken}`,
          dpop: createDpopProof({
            keyPair: dpopKeyPair,
            method: "POST",
            url: `${base}/v1/environments/${environmentId}/connect`,
            accessToken: dpopToken,
          }),
        },
        body: JSON.stringify({ clientProofKeyThumbprint: jkt }),
      });
      NodeAssert.equal(connectRes.status, 200);
      const connectJson = (await connectRes.json()) as { credential: string };
      NodeAssert.ok(connectJson.credential.startsWith("session_cred_"));

      // External HTTP proxy routed by Host header -> tunnel host
      const tunnelHostname = new URL(linked.endpoint.httpBaseUrl).hostname;
      const proxiedHttp = await new Promise<{ statusCode: number; body: string }>(
        (resolve, reject) => {
          const req = NodeHttp.request(
            {
              host: "127.0.0.1",
              port: connectPort,
              path: "/ping",
              method: "GET",
              headers: { Host: tunnelHostname },
            },
            (res) => {
              const parts: Array<Buffer> = [];
              res.on("data", (c: Buffer) => parts.push(c));
              res.on("end", () =>
                resolve({
                  statusCode: res.statusCode ?? 500,
                  body: Buffer.concat(parts).toString("utf8"),
                }),
              );
            },
          );
          req.once("error", reject);
          req.end();
        },
      );
      NodeAssert.equal(proxiedHttp.statusCode, 200);
      NodeAssert.deepEqual(JSON.parse(proxiedHttp.body), {
        ok: true,
        host: new URL(linked.endpoint.httpBaseUrl).host,
      });

      // External WebSocket echo through tunnel
      const wsEcho = await new Promise<string>((resolve, reject) => {
        const clientSocket = NodeNet.connect(connectPort, "127.0.0.1");
        const key = NodeCrypto.randomBytes(16).toString("base64");
        let upgraded = false;
        let rawBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        const decoder = createWebSocketFrameDecoder((frame) => {
          if (frame.opcode === 0x01) {
            clientSocket.destroy();
            resolve(frame.payload.toString("utf8"));
          }
        });
        clientSocket.on("connect", () => {
          clientSocket.write(
            [
              "GET /ws HTTP/1.1",
              `Host: ${tunnelHostname}`,
              "Upgrade: websocket",
              "Connection: Upgrade",
              `Sec-WebSocket-Key: ${key}`,
              "Sec-WebSocket-Version: 13",
              "",
              "",
            ].join("\r\n"),
          );
        });
        clientSocket.on("data", (chunk: Buffer) => {
          if (!upgraded) {
            rawBuf = Buffer.concat([rawBuf, chunk]);
            const sep = rawBuf.indexOf("\r\n\r\n");
            if (sep === -1) return;
            upgraded = true;
            clientSocket.write(
              encodeWebSocketFrame({
                opcode: 0x01,
                payload: Buffer.from("hello-lunacode", "utf8"),
                mask: true,
              }),
            );
            const rest = rawBuf.subarray(sep + 4);
            if (rest.length > 0) decoder(rest);
            return;
          }
          decoder(chunk);
        });
        clientSocket.once("error", reject);
      });
      NodeAssert.equal(wsEcho, "hello-lunacode");

      tunnelConn.close();

      // Recover tunnel rotates connectorToken
      const recoverProof = signEdDsaJwt({
        privateKeyPem: envPrivateKeyPem,
        typ: "t3-env-managed-tunnel-recovery+jwt",
        payload: {
          iss: `t3-env:${environmentId}`,
          aud: base,
          sub: environmentId,
          jti: NodeCrypto.randomUUID(),
          iat: nowSec,
          exp: nowSec + 300,
          action: "recover",
          environmentId,
          cloudUserId: linked.cloudUserId,
          origin: { localHttpHost: "127.0.0.1", localHttpPort: mockEnvPort },
        },
      });
      const recoverRes = await fetch(`${base}/v1/environments/${environmentId}/tunnel`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${linked.environmentCredential}`,
        },
        body: JSON.stringify({
          cloudUserId: linked.cloudUserId,
          origin: { localHttpHost: "127.0.0.1", localHttpPort: mockEnvPort },
          proof: recoverProof,
        }),
      });
      NodeAssert.equal(recoverRes.status, 200);
      const recovered = (await recoverRes.json()) as {
        endpointRuntime: { connectorToken: string };
      };
      NodeAssert.notEqual(
        recovered.endpointRuntime.connectorToken,
        linked.endpointRuntime.connectorToken,
      );

      // Revoke link
      const delRes = await fetch(`${base}/v1/client/environment-links/${environmentId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${regJson.accessToken}` },
      });
      NodeAssert.equal(delRes.status, 200);
      const listRes = await fetch(`${base}/v1/environments`, {
        headers: { authorization: `Bearer ${regJson.accessToken}` },
      });
      NodeAssert.deepEqual(await listRes.json(), { environments: [] });
    },
  );
});

NodeTest.describe("lunacode-connect single-domain :8443 path-prefix tunnel", () => {
  let tempDir = "";
  let connectServer: ConnectServerInstance;
  let mockEnvServer: NodeHttp.Server;
  let connectPort = 0;
  let mockEnvPort = 0;
  let envPublicKeyPem = "";
  let envPrivateKeyPem = "";
  const environmentId = "env_single_domain_8443";
  const publicOrigin = "https://connect.example.com:8443";
  const activeMockSockets = new Set<NodeNet.Socket | NodeStream.Duplex>();

  NodeTest.before(async () => {
    tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lunacode-connect-8443-"));
    connectPort = await randomAvailablePort();
    const envKeys = NodeCrypto.generateKeyPairSync("ed25519");
    envPublicKeyPem = envKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    envPrivateKeyPem = envKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const cfg = loadConnectConfig({
      HOST: "127.0.0.1",
      PORT: String(connectPort),
      DATA_DIR: tempDir,
      PUBLIC_ORIGIN: publicOrigin,
      ALLOW_REGISTRATION: "true",
    });
    connectServer = await startConnectServer(cfg);

    mockEnvServer = NodeHttp.createServer((req, res) => {
      if (req.url === "/ping" || req.url === "/.well-known/t3/environment") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            url: req.url,
            host: req.headers.host,
            fwdProto: req.headers["x-forwarded-proto"],
            fwdPrefix: req.headers["x-forwarded-prefix"],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    mockEnvServer.on("upgrade", (req, socket) => {
      activeMockSockets.add(socket);
      socket.once("close", () => activeMockSockets.delete(socket));
      const wsKey = String(req.headers["sec-websocket-key"] ?? "");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${computeWebSocketAccept(wsKey)}`,
          `X-Seen-Url: ${req.url ?? ""}`,
          `X-Seen-Host: ${String(req.headers.host ?? "")}`,
          "",
          "",
        ].join("\r\n"),
      );
      const dec = createWebSocketFrameDecoder((frame) => {
        if (frame.opcode === 0x01 || frame.opcode === 0x02) {
          socket.write(encodeWebSocketFrame({ opcode: frame.opcode, payload: frame.payload }));
        }
      });
      socket.on("data", (chunk: Buffer) => dec(chunk));
    });

    await new Promise<void>((resolve) => {
      mockEnvServer.listen(0, "127.0.0.1", () => {
        mockEnvPort = (mockEnvServer.address() as NodeNet.AddressInfo).port;
        resolve();
      });
    });
  });

  NodeTest.after(async () => {
    for (const sock of activeMockSockets) sock.destroy();
    await connectServer.close();
    mockEnvServer.closeAllConnections();
    await new Promise<void>((resolve) => mockEnvServer.close(() => resolve()));
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  });

  NodeTest.it(
    "preserves :8443 in endpoints, routes /t/<slug>/ HTTP & WS without control-route collisions, and redirects /",
    async () => {
      const localHttp = `http://127.0.0.1:${connectPort}`;

      const rootRes = await fetch(`${localHttp}/`, { redirect: "manual" });
      NodeAssert.equal(rootRes.status, 302);
      NodeAssert.equal(rootRes.headers.get("location"), "/login");

      const regRes = await fetch(`${localHttp}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "bob@example.com",
          password: "strong-password-123",
          displayName: "Bob",
        }),
      });
      NodeAssert.equal(regRes.status, 201);
      const regJson = (await regRes.json()) as { accessToken: string };

      const challengeRes = await fetch(`${localHttp}/v1/client/environment-link-challenges`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${regJson.accessToken}`,
        },
        body: JSON.stringify({ managedTunnelsEnabled: true }),
      });
      NodeAssert.equal(challengeRes.status, 200);
      const { challenge } = (await challengeRes.json()) as { challenge: string };

      const nowSec = nowEpochSeconds();
      const proof = signEdDsaJwt({
        privateKeyPem: envPrivateKeyPem,
        typ: "t3-env-link+jwt",
        payload: {
          iss: `t3-env:${environmentId}`,
          aud: publicOrigin,
          sub: environmentId,
          jti: NodeCrypto.randomUUID(),
          iat: nowSec,
          exp: nowSec + 300,
          challenge,
          descriptor: { environmentId, label: "Single Domain Mac" },
          environmentId,
          environmentPublicKey: envPublicKeyPem,
          endpoint: {
            httpBaseUrl: `${publicOrigin}/`,
            wsBaseUrl: `${publicOrigin.replace(/^https/u, "wss")}/`,
            providerKind: "t3_relay",
          },
          origin: { localHttpHost: "127.0.0.1", localHttpPort: mockEnvPort },
          scopes: ["agent_activity_notifications", "managed_tunnels"],
        },
      });

      const linkRes = await fetch(`${localHttp}/v1/client/environment-links`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${regJson.accessToken}`,
        },
        body: JSON.stringify({ proof, managedTunnelsEnabled: true }),
      });
      NodeAssert.equal(linkRes.status, 200);
      const linked = (await linkRes.json()) as {
        endpoint: { httpBaseUrl: string; wsBaseUrl: string };
        endpointRuntime: { tunnelId: string; connectorToken: string };
      };

      const httpEndpoint = new URL(linked.endpoint.httpBaseUrl);
      const wsEndpoint = new URL(linked.endpoint.wsBaseUrl);
      NodeAssert.equal(httpEndpoint.origin, publicOrigin);
      NodeAssert.equal(wsEndpoint.origin, "wss://connect.example.com:8443");
      NodeAssert.match(httpEndpoint.pathname, /^\/t\/env-[a-f0-9]+\/$/u);
      const prefix = httpEndpoint.pathname.replace(/\/$/u, "");

      const tunnelConn = await connectTunnelWs({
        port: connectPort,
        tunnelId: linked.endpointRuntime.tunnelId,
        connectorToken: linked.endpointRuntime.connectorToken,
        targetPort: mockEnvPort,
      });

      try {
        // Request sent with portless Host header still restores :8443 and forwards x-forwarded-prefix.
        const sendProxiedGet = (reqPath: string) =>
          new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
            const req = NodeHttp.request(
              {
                host: "127.0.0.1",
                port: connectPort,
                path: reqPath,
                method: "GET",
                headers: { Host: "connect.example.com" },
              },
              (res) => {
                const parts: Array<Buffer> = [];
                res.on("data", (c: Buffer) => parts.push(c));
                res.on("end", () =>
                  resolve({
                    statusCode: res.statusCode ?? 500,
                    body: Buffer.concat(parts).toString("utf8"),
                  }),
                );
              },
            );
            req.once("error", reject);
            req.end();
          });

        const pingRes = await sendProxiedGet(`${prefix}/ping`);
        NodeAssert.equal(pingRes.statusCode, 200);
        NodeAssert.deepEqual(JSON.parse(pingRes.body), {
          ok: true,
          url: "/ping",
          host: "connect.example.com:8443",
          fwdProto: "https",
          fwdPrefix: prefix,
        });

        const wellKnownEnvRes = await sendProxiedGet(`${prefix}/.well-known/t3/environment`);
        NodeAssert.equal(wellKnownEnvRes.statusCode, 200);
        NodeAssert.equal(
          (JSON.parse(wellKnownEnvRes.body) as { url: string }).url,
          "/.well-known/t3/environment",
        );

        // Connect control-plane metadata on the same host continues answering without collision.
        const controlOauth = await sendProxiedGet("/.well-known/oauth-authorization-server");
        NodeAssert.equal(controlOauth.statusCode, 200);
        NodeAssert.equal(
          (JSON.parse(controlOauth.body) as { issuer: string }).issuer,
          publicOrigin,
        );

        // Unknown slug returns 404 tunnel_not_found instead of falling into auth routes.
        const missingSlug = await sendProxiedGet("/t/env-doesnotexist/ping");
        NodeAssert.equal(missingSlug.statusCode, 404);

        // External WebSocket upgrade under /t/<slug>/ws succeeds end-to-end.
        const wsEcho = await new Promise<string>((resolve, reject) => {
          const clientSocket = NodeNet.connect(connectPort, "127.0.0.1");
          const key = NodeCrypto.randomBytes(16).toString("base64");
          let upgraded = false;
          let rawBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
          const decoder = createWebSocketFrameDecoder((frame) => {
            if (frame.opcode === 0x01) {
              clientSocket.destroy();
              resolve(frame.payload.toString("utf8"));
            }
          });
          clientSocket.on("connect", () => {
            clientSocket.write(
              [
                `GET ${prefix}/ws?wsTicket=abc HTTP/1.1`,
                "Host: connect.example.com:8443",
                "Upgrade: websocket",
                "Connection: Upgrade",
                `Sec-WebSocket-Key: ${key}`,
                "Sec-WebSocket-Version: 13",
                "",
                "",
              ].join("\r\n"),
            );
          });
          clientSocket.on("data", (chunk: Buffer) => {
            if (!upgraded) {
              rawBuf = Buffer.concat([rawBuf, chunk]);
              const sep = rawBuf.indexOf("\r\n\r\n");
              if (sep === -1) return;
              upgraded = true;
              const headText = rawBuf.subarray(0, sep).toString("latin1");
              NodeAssert.match(headText, /X-Seen-Url: \/ws\?wsTicket=abc/iu);
              clientSocket.write(
                encodeWebSocketFrame({
                  opcode: 0x01,
                  payload: Buffer.from("hello-8443", "utf8"),
                  mask: true,
                }),
              );
              const rest = rawBuf.subarray(sep + 4);
              if (rest.length > 0) decoder(rest);
              return;
            }
            decoder(chunk);
          });
          clientSocket.once("error", reject);
        });
        NodeAssert.equal(wsEcho, "hello-8443");
      } finally {
        tunnelConn.close();
      }
    },
  );
});

NodeTest.describe("lunacode-connect super admin and legacy DB migration", () => {
  NodeTest.it(
    "migrates legacy users DB, auto-promotes earliest user, and enforces /admin management controls",
    async (t) => {
      const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lunacode-connect-admin-"));
      const legacyDbPath = NodePath.join(tmpDir, "connect.sqlite");
      const adminPasswordHash = await hashPassword("admin-pass-123");

      // Seed a legacy 5-column `users` table without `role` or `disabled_at`.
      const legacyDb = new NodeSqlite.DatabaseSync(legacyDbPath);
      legacyDb.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          display_name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      legacyDb
        .prepare(
          "INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          "usr_legacy_1",
          "legacy-admin@example.com",
          adminPasswordHash,
          "Legacy Admin",
          "2026-11-26T00:00:00.000Z",
        );
      legacyDb.close();

      const connectPort = await randomAvailablePort();
      const mockEnvPort = await randomAvailablePort();

      const mockEnvServer = NodeHttp.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, url: req.url }));
      });
      await new Promise<void>((resolve) => mockEnvServer.listen(mockEnvPort, "127.0.0.1", resolve));

      const publicOrigin = `https://connect.example.com:${connectPort}`;
      const config = loadConnectConfig({
        HOST: "127.0.0.1",
        PORT: String(connectPort),
        DATA_DIR: tmpDir,
        PUBLIC_ORIGIN: publicOrigin,
        ALLOW_REGISTRATION: "true",
      });
      const instance = await startConnectServer(config);

      t.after(async () => {
        await instance.close();
        await new Promise<void>((resolve) => mockEnvServer.close(() => resolve()));
        NodeFS.rmSync(tmpDir, { recursive: true, force: true });
      });

      const localHttp = `http://127.0.0.1:${connectPort}`;

      // Unauthenticated GET /admin redirects to /login?next=%2Fadmin.
      const unauthAdmin = await fetch(`${localHttp}/admin`, { redirect: "manual" });
      NodeAssert.equal(unauthAdmin.status, 302);
      NodeAssert.equal(unauthAdmin.headers.get("location"), "/login?next=%2Fadmin");

      // Legacy earliest user auto-promoted to admin and can log in + access /admin.
      const adminLoginRes = await fetch(`${localHttp}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "legacy-admin@example.com", password: "admin-pass-123" }),
      });
      NodeAssert.equal(adminLoginRes.status, 200);
      const adminSetCookie = adminLoginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
      NodeAssert.ok(adminSetCookie.includes("lunacode_session="));
      const adminLoginJson = (await adminLoginRes.json()) as {
        user: { id: string; email: string; role: string };
        accessToken: string;
      };
      NodeAssert.equal(adminLoginJson.user.role, "admin");

      const adminPageRes = await fetch(`${localHttp}/admin`, {
        headers: { cookie: adminSetCookie },
      });
      NodeAssert.equal(adminPageRes.status, 200);
      NodeAssert.match(await adminPageRes.text(), /超级管理控制台/u);

      const overviewRes = await fetch(`${localHttp}/api/admin/overview`, {
        headers: { authorization: `Bearer ${adminLoginJson.accessToken}` },
      });
      NodeAssert.equal(overviewRes.status, 200);
      const overviewJson = (await overviewRes.json()) as {
        stats: { totalUsers: number; activeAdmins: number };
        users: Array<{ id: string; email: string; role: string }>;
      };
      NodeAssert.equal(overviewJson.stats.totalUsers, 1);
      NodeAssert.equal(overviewJson.stats.activeAdmins, 1);
      NodeAssert.equal(overviewJson.users[0]?.email, "legacy-admin@example.com");

      // Toggle registration settings dynamically and verify /api/auth/register enforces them.
      const disableRegRes = await fetch(`${localHttp}/api/admin/settings`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: adminSetCookie,
        },
        body: JSON.stringify({ allowRegistration: false }),
      });
      NodeAssert.equal(disableRegRes.status, 200);

      const blockedReg = await fetch(`${localHttp}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "blocked@example.com", password: "password-123" }),
      });
      NodeAssert.equal(blockedReg.status, 403);
      NodeAssert.equal(
        ((await blockedReg.json()) as { error: string }).error,
        "registration_disabled",
      );

      // Re-enable registration with email whitelist.
      const whitelistRes = await fetch(`${localHttp}/api/admin/settings`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: adminSetCookie,
        },
        body: JSON.stringify({
          allowRegistration: true,
          allowedEmails: "allowed@example.com",
        }),
      });
      NodeAssert.equal(whitelistRes.status, 200);

      const blockedByWhitelist = await fetch(`${localHttp}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "notlisted@example.com", password: "password-123" }),
      });
      NodeAssert.equal(blockedByWhitelist.status, 403);
      NodeAssert.equal(
        ((await blockedByWhitelist.json()) as { error: string }).error,
        "email_not_allowed",
      );

      // Admin creates a normal member user directly.
      const createMemberRes = await fetch(`${localHttp}/api/admin/users`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: adminSetCookie,
        },
        body: JSON.stringify({
          email: "member@example.com",
          password: "member-pass-123",
          displayName: "Team Member",
          role: "user",
        }),
      });
      NodeAssert.equal(createMemberRes.status, 201);
      const createdMember = (await createMemberRes.json()) as {
        user: { id: string; email: string; role: string };
      };
      NodeAssert.equal(createdMember.user.role, "user");

      // Normal user logs in but gets 403 on /admin and /api/admin/overview.
      const memberLoginRes = await fetch(`${localHttp}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "member@example.com", password: "member-pass-123" }),
      });
      NodeAssert.equal(memberLoginRes.status, 200);
      const memberCookie = memberLoginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
      const memberTokens = (await memberLoginRes.json()) as {
        user: { role: string };
        accessToken: string;
        refreshToken: string;
      };
      NodeAssert.equal(memberTokens.user.role, "user");

      NodeAssert.equal(
        (await fetch(`${localHttp}/admin`, { headers: { cookie: memberCookie } })).status,
        403,
      );
      NodeAssert.equal(
        (await fetch(`${localHttp}/api/admin/overview`, { headers: { cookie: memberCookie } }))
          .status,
        403,
      );

      // Guardrails: admin cannot disable, demote, or delete self / last admin.
      const selfDisableRes = await fetch(`${localHttp}/api/admin/users/${adminLoginJson.user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: adminSetCookie },
        body: JSON.stringify({ disabled: true }),
      });
      NodeAssert.equal(selfDisableRes.status, 400);

      const selfDemoteRes = await fetch(`${localHttp}/api/admin/users/${adminLoginJson.user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: adminSetCookie },
        body: JSON.stringify({ role: "user" }),
      });
      NodeAssert.equal(selfDemoteRes.status, 400);

      const selfDeleteRes = await fetch(`${localHttp}/api/admin/users/${adminLoginJson.user.id}`, {
        method: "DELETE",
        headers: { cookie: adminSetCookie },
      });
      NodeAssert.equal(selfDeleteRes.status, 400);

      // Member links an environment and opens an active tunnel.
      const memberEnvId = "env-member-1";
      const memberEnvKeys = NodeCrypto.generateKeyPairSync("ed25519");
      const memberEnvPublicKeyPem = memberEnvKeys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString();
      const memberEnvPrivateKeyPem = memberEnvKeys.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString();

      const chRes = await fetch(`${localHttp}/v1/client/environment-link-challenges`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${memberTokens.accessToken}`,
        },
        body: JSON.stringify({ managedTunnelsEnabled: true }),
      });
      NodeAssert.equal(chRes.status, 200);
      const { challenge } = (await chRes.json()) as { challenge: string };
      const nowSec = nowEpochSeconds();

      const proof = signEdDsaJwt({
        privateKeyPem: memberEnvPrivateKeyPem,
        typ: "t3-env-link+jwt",
        payload: {
          iss: `t3-env:${memberEnvId}`,
          sub: memberEnvId,
          aud: publicOrigin,
          jti: NodeCrypto.randomUUID(),
          iat: nowSec,
          exp: nowSec + 300,
          challenge,
          descriptor: { environmentId: memberEnvId, label: "Member Laptop" },
          environmentId: memberEnvId,
          environmentPublicKey: memberEnvPublicKeyPem,
          endpoint: {
            httpBaseUrl: `${publicOrigin}/`,
            wsBaseUrl: `${publicOrigin.replace(/^https/u, "wss")}/`,
            providerKind: "t3_relay",
          },
          origin: { localHttpHost: "127.0.0.1", localHttpPort: mockEnvPort },
          scopes: ["agent_activity_notifications", "managed_tunnels"],
        },
      });
      const linkRes = await fetch(`${localHttp}/v1/client/environment-links`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${memberTokens.accessToken}`,
        },
        body: JSON.stringify({ proof, managedTunnelsEnabled: true }),
      });
      NodeAssert.equal(linkRes.status, 200);
      const linked = (await linkRes.json()) as {
        endpoint: { httpBaseUrl: string };
        endpointRuntime: { tunnelId: string; connectorToken: string };
      };
      const envSlugPath = new URL(linked.endpoint.httpBaseUrl).pathname.replace(/\/$/u, "");

      const tunnelConn = await connectTunnelWs({
        port: connectPort,
        tunnelId: linked.endpointRuntime.tunnelId,
        connectorToken: linked.endpointRuntime.connectorToken,
        targetPort: mockEnvPort,
      });

      // Verify tunnel works and admin can see it online, then admin disconnects it.
      const beforeDisconnect = await fetch(`${localHttp}${envSlugPath}/ping`);
      NodeAssert.equal(beforeDisconnect.status, 200);

      const disconnectRes = await fetch(
        `${localHttp}/api/admin/environments/${createdMember.user.id}/${memberEnvId}/disconnect`,
        { method: "POST", headers: { cookie: adminSetCookie } },
      );
      NodeAssert.equal(disconnectRes.status, 200);
      const afterDisconnectOverview = (await (
        await fetch(`${localHttp}/api/admin/overview`, { headers: { cookie: adminSetCookie } })
      ).json()) as { stats: { onlineTunnels: number } };
      NodeAssert.equal(afterDisconnectOverview.stats.onlineTunnels, 0);

      // Reconnect tunnel to test disabling user closes tunnel + invalidates session & refresh token.
      tunnelConn.close();
      const tunnelConn2 = await connectTunnelWs({
        port: connectPort,
        tunnelId: linked.endpointRuntime.tunnelId,
        connectorToken: linked.endpointRuntime.connectorToken,
        targetPort: mockEnvPort,
      });

      const disableMemberRes = await fetch(
        `${localHttp}/api/admin/users/${createdMember.user.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie: adminSetCookie },
          body: JSON.stringify({ disabled: true }),
        },
      );
      NodeAssert.equal(disableMemberRes.status, 200);

      // Disabled user's session, refresh token, and login all fail; tunnel is offline.
      NodeAssert.equal(
        (await fetch(`${localHttp}/api/auth/session`, { headers: { cookie: memberCookie } }))
          .status,
        401,
      );
      NodeAssert.equal(
        (
          await fetch(`${localHttp}/api/auth/token`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refreshToken: memberTokens.refreshToken }),
          })
        ).status,
        401,
      );
      const disabledLoginRes = await fetch(`${localHttp}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "member@example.com", password: "member-pass-123" }),
      });
      NodeAssert.equal(disabledLoginRes.status, 403);
      NodeAssert.equal(
        ((await disabledLoginRes.json()) as { error: string }).error,
        "account_disabled",
      );
      const afterDisableOverview = (await (
        await fetch(`${localHttp}/api/admin/overview`, { headers: { cookie: adminSetCookie } })
      ).json()) as { stats: { onlineTunnels: number; disabledUsers: number } };
      NodeAssert.equal(afterDisableOverview.stats.onlineTunnels, 0);
      NodeAssert.equal(afterDisableOverview.stats.disabledUsers, 1);
      tunnelConn2.close();

      // Re-enable user and reset password -> old password fails, new password succeeds.
      const resetPwRes = await fetch(`${localHttp}/api/admin/users/${createdMember.user.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: adminSetCookie },
        body: JSON.stringify({ disabled: false, password: "reset-pass-456" }),
      });
      NodeAssert.equal(resetPwRes.status, 200);

      NodeAssert.equal(
        (
          await fetch(`${localHttp}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "member@example.com", password: "member-pass-123" }),
          })
        ).status,
        401,
      );
      NodeAssert.equal(
        (
          await fetch(`${localHttp}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "member@example.com", password: "reset-pass-456" }),
          })
        ).status,
        200,
      );

      // Admin revokes member's environment -> /t/<slug>/ returns 404.
      const revokeEnvRes = await fetch(
        `${localHttp}/api/admin/environments/${createdMember.user.id}/${memberEnvId}`,
        { method: "DELETE", headers: { cookie: adminSetCookie } },
      );
      NodeAssert.equal(revokeEnvRes.status, 200);
      NodeAssert.equal((await fetch(`${localHttp}${envSlugPath}/ping`)).status, 404);

      // Admin deletes member user -> user can no longer log in.
      const deleteMemberRes = await fetch(`${localHttp}/api/admin/users/${createdMember.user.id}`, {
        method: "DELETE",
        headers: { cookie: adminSetCookie },
      });
      NodeAssert.equal(deleteMemberRes.status, 200);
      NodeAssert.equal(
        (
          await fetch(`${localHttp}/api/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "member@example.com", password: "reset-pass-456" }),
          })
        ).status,
        401,
      );
    },
  );

  NodeTest.it(
    "supports wildcard tunnels, admin quotas/permissions, webhooks with hold replay, mobile activity/devices, self-service security, and hosted web SPA",
    async (t) => {
      const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lunacode-phase2-"));
      const webDistDir = NodePath.join(tmpDir, "web-dist");
      NodeFS.mkdirSync(NodePath.join(webDistDir, "assets"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(webDistDir, "index.html"),
        "<!doctype html><html><body><!-- LUNACODE_WEB_HOSTED --></body></html>",
        "utf8",
      );
      NodeFS.writeFileSync(
        NodePath.join(webDistDir, "assets", "app.js"),
        "console.log('lunacode-web-ok');",
        "utf8",
      );

      const connectPort = await randomAvailablePort();
      const mockEnvPort = await randomAvailablePort();

      const webhookDeliveries: Array<{
        readonly method: string;
        readonly url: string;
        readonly headers: NodeHttp.IncomingHttpHeaders;
        readonly body: string;
      }> = [];
      let resolveSecondWebhook: () => void = () => {};
      const secondWebhookPromise = new Promise<void>((resolve) => {
        resolveSecondWebhook = resolve;
      });

      const mockEnvServer = NodeHttp.createServer((req, res) => {
        const chunks: Array<Buffer> = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          if (req.url === "/ping") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("wildcard-pong");
            return;
          }
          if (req.url?.includes("hook-daily")) {
            webhookDeliveries.push({
              method: req.method ?? "POST",
              url: req.url,
              headers: req.headers,
              body: bodyText,
            });
            if (webhookDeliveries.length >= 2) {
              resolveSecondWebhook();
            }
            res.writeHead(200, {
              "content-type": "application/json",
              "x-t3-hook-outcome": "accepted",
            });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, url: req.url }));
        });
      });
      await new Promise<void>((resolve) => mockEnvServer.listen(mockEnvPort, "127.0.0.1", resolve));

      const publicOrigin = "https://connect.example.com:8443";
      const config = loadConnectConfig({
        HOST: "127.0.0.1",
        PORT: String(connectPort),
        DATA_DIR: NodePath.join(tmpDir, "data"),
        PUBLIC_ORIGIN: publicOrigin,
        TUNNEL_WILDCARD_DOMAIN: "example.com",
        TUNNEL_PUBLIC_PORT: "8443",
        DEFAULT_USER_MAX_TUNNELS: "1",
        ALLOW_REGISTRATION: "true",
        ADMIN_EMAILS: "root@example.com",
        WEB_DIST_DIR: webDistDir,
      });
      const instance = await startConnectServer(config);

      t.after(async () => {
        await instance.close();
        await new Promise<void>((resolve) => mockEnvServer.close(() => resolve()));
        NodeFS.rmSync(tmpDir, { recursive: true, force: true });
      });

      const localHttp = `http://127.0.0.1:${connectPort}`;

      // Hosted Web SPA routes vs backend routes
      const rootRes = await fetch(`${localHttp}/`, { redirect: "manual" });
      NodeAssert.equal(rootRes.status, 200);
      NodeAssert.match(await rootRes.text(), /LUNACODE_WEB_HOSTED/);
      const pairRes = await fetch(`${localHttp}/pair`);
      NodeAssert.equal(pairRes.status, 200);
      NodeAssert.match(await pairRes.text(), /LUNACODE_WEB_HOSTED/);
      const approveRes = await fetch(`${localHttp}/approve-agent`);
      NodeAssert.equal(approveRes.status, 200);
      NodeAssert.match(await approveRes.text(), /LUNACODE_WEB_HOSTED/);
      const assetRes = await fetch(`${localHttp}/assets/app.js`);
      NodeAssert.equal(assetRes.status, 200);
      NodeAssert.match(await assetRes.text(), /lunacode-web-ok/);
      const loginHtmlRes = await fetch(`${localHttp}/login`);
      NodeAssert.equal(loginHtmlRes.status, 200);
      NodeAssert.match(await loginHtmlRes.text(), /LunaCode Connect/);

      // Register admin + quota-limited user
      const adminReg = await fetch(`${localHttp}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "root@example.com",
          password: "root-password-123",
          displayName: "Root Admin",
        }),
      });
      NodeAssert.equal(adminReg.status, 201);
      const adminJson = (await adminReg.json()) as {
        user: { id: string; role: string };
        accessToken: string;
      };
      NodeAssert.equal(adminJson.user.role, "admin");

      const quotaReg = await fetch(`${localHttp}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "quota@example.com",
          password: "quota-password-123",
          displayName: "Quota User",
        }),
      });
      NodeAssert.equal(quotaReg.status, 201);
      const quotaJson = (await quotaReg.json()) as {
        user: {
          id: string;
          maxTunnels: number;
          permissions: { webhooks: boolean; mobilePush: boolean };
        };
        accessToken: string;
        refreshToken: string;
      };
      NodeAssert.equal(quotaJson.user.maxTunnels, 1);
      NodeAssert.equal(quotaJson.user.permissions.webhooks, true);

      // /v1/client/t3chat-link returns admin-configured maxTunnelsOverride
      const t3chatRes1 = await fetch(`${localHttp}/v1/client/t3chat-link`, {
        headers: { authorization: `Bearer ${quotaJson.accessToken}` },
      });
      NodeAssert.equal(t3chatRes1.status, 200);
      const t3chatJson1 = (await t3chatRes1.json()) as { maxTunnelsOverride?: number | null };
      NodeAssert.equal(t3chatJson1.maxTunnelsOverride, 1);

      // Link helper
      const linkEnvironment = async (accessToken: string, envId: string) => {
        const keys = NodeCrypto.generateKeyPairSync("ed25519");
        const pubPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
        const privPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
        const chRes = await fetch(`${localHttp}/v1/client/environment-link-challenges`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            managedTunnelsEnabled: true,
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
          }),
        });
        NodeAssert.equal(chRes.status, 200);
        const { challenge } = (await chRes.json()) as { challenge: string };
        const nowSec = nowEpochSeconds();
        const proof = signEdDsaJwt({
          privateKeyPem: privPem,
          typ: "t3-env-link+jwt",
          payload: {
            iss: `t3-env:${envId}`,
            sub: envId,
            aud: publicOrigin,
            jti: NodeCrypto.randomUUID(),
            iat: nowSec,
            exp: nowSec + 300,
            challenge,
            descriptor: { environmentId: envId, label: `Box ${envId}` },
            environmentId: envId,
            environmentPublicKey: pubPem,
            endpoint: {
              httpBaseUrl: `${publicOrigin}/`,
              wsBaseUrl: `${publicOrigin.replace(/^https/u, "wss")}/`,
              providerKind: "t3_relay",
            },
            origin: { localHttpHost: "127.0.0.1", localHttpPort: mockEnvPort },
            scopes: ["agent_activity_notifications", "managed_tunnels"],
          },
        });
        const res = await fetch(`${localHttp}/v1/client/environment-links`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ proof, managedTunnelsEnabled: true }),
        });
        return { res, keys, privPem };
      };

      const { res: link1Res, privPem: env1PrivPem } = await linkEnvironment(
        quotaJson.accessToken,
        "env-quota-1",
      );
      NodeAssert.equal(link1Res.status, 200);
      const link1Json = (await link1Res.json()) as {
        endpoint: { httpBaseUrl: string; wsBaseUrl: string; providerKind: string };
        endpointRuntime: { tunnelId: string; tunnelName: string; connectorToken: string };
        environmentCredential: string;
      };
      NodeAssert.match(
        link1Json.endpoint.httpBaseUrl,
        /^https:\/\/env-[0-9a-f]{16}\.example\.com:8443\/$/,
      );
      NodeAssert.match(link1Json.endpointRuntime.tunnelName, /^lunacode-[0-9a-f]{16}$/);
      const endpointKey = link1Json.endpointRuntime.tunnelName.split("-").at(-1)!;
      NodeAssert.match(endpointKey, /^[0-9a-f]{16}$/);

      // Second link hits 403 environment_link_limit_exceeded while maxTunnels === 1
      const { res: link2BlockedRes } = await linkEnvironment(quotaJson.accessToken, "env-quota-2");
      NodeAssert.equal(link2BlockedRes.status, 403);
      NodeAssert.equal(
        ((await link2BlockedRes.json()) as { code: string }).code,
        "environment_link_limit_exceeded",
      );

      // Admin raises quota to 2 -> link2 succeeds and /v1/client/t3chat-link updates
      const raiseQuotaRes = await fetch(`${localHttp}/api/admin/users/${quotaJson.user.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${adminJson.accessToken}`,
        },
        body: JSON.stringify({ maxTunnels: 2 }),
      });
      NodeAssert.equal(raiseQuotaRes.status, 200);
      const t3chatJson2 = (await (
        await fetch(`${localHttp}/v1/client/t3chat-link`, {
          headers: { authorization: `Bearer ${quotaJson.accessToken}` },
        })
      ).json()) as { maxTunnelsOverride?: number | null };
      NodeAssert.equal(t3chatJson2.maxTunnelsOverride, 2);

      const { res: link2AllowedRes } = await linkEnvironment(quotaJson.accessToken, "env-quota-2");
      NodeAssert.equal(link2AllowedRes.status, 200);

      // Connect wildcard tunnel -> verify 101 X-Tunnel-Public-Host/Url and host proxy routing
      const tunnelConn1 = await connectTunnelWs({
        port: connectPort,
        tunnelId: link1Json.endpointRuntime.tunnelId,
        connectorToken: link1Json.endpointRuntime.connectorToken,
        targetPort: mockEnvPort,
      });
      const expectedWildcardHost = `env-${endpointKey}.example.com:8443`;
      NodeAssert.equal(tunnelConn1.headers["x-tunnel-public-host"], expectedWildcardHost);
      NodeAssert.equal(
        tunnelConn1.headers["x-tunnel-public-url"],
        `https://${expectedWildcardHost}/`,
      );

      const wildcardHttpRes = await new Promise<{ statusCode: number; body: string }>(
        (resolve, reject) => {
          const req = NodeHttp.request(
            {
              host: "127.0.0.1",
              port: connectPort,
              path: "/ping",
              method: "GET",
              headers: { Host: expectedWildcardHost },
            },
            (res) => {
              const parts: Array<Buffer> = [];
              res.on("data", (c: Buffer) => parts.push(c));
              res.on("end", () =>
                resolve({
                  statusCode: res.statusCode ?? 500,
                  body: Buffer.concat(parts).toString("utf8"),
                }),
              );
            },
          );
          req.once("error", reject);
          req.end();
        },
      );
      NodeAssert.equal(wildcardHttpRes.statusCode, 200);
      NodeAssert.equal(wildcardHttpRes.body, "wildcard-pong");

      // Webhook online forwarding with EdDSA x-t3-relay-delivery proof & header stripping
      const onlineHookRes = await fetch(
        `${localHttp}/v1/hooks/${endpointKey}/hook-daily/secret-tok-1`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: "session=strip-me",
            "x-t3-relay-delivery": "forged-jwt",
            "x-t3-relay-spoof": "strip-me",
            "x-webhook-event": "push",
          },
          body: JSON.stringify({ event: "online" }),
        },
      );
      NodeAssert.equal(onlineHookRes.status, 200);
      NodeAssert.equal(onlineHookRes.headers.get("x-t3-hook-outcome"), "accepted");
      NodeAssert.equal(webhookDeliveries.length, 1);
      NodeAssert.equal(webhookDeliveries[0]?.headers.cookie, undefined);
      NodeAssert.equal(webhookDeliveries[0]?.headers["x-t3-relay-spoof"], undefined);
      NodeAssert.equal(webhookDeliveries[0]?.headers["x-webhook-event"], "push");
      const deliveryJwt = String(webhookDeliveries[0]?.headers["x-t3-relay-delivery"] ?? "");
      const verifiedDelivery = verifyEdDsaJwt({
        publicKeyPem: instance.mintKeys.publicKeyPem,
        token: deliveryJwt,
        expectedTyp: "t3-relay-hook-delivery+jwt",
        expectedIssuer: publicOrigin,
        expectedAudience: "t3-env:env-quota-1",
      });
      NodeAssert.equal(verifiedDelivery.ok, true);
      if (verifiedDelivery.ok) {
        NodeAssert.equal(verifiedDelivery.claims.hookId, "hook-daily");
        NodeAssert.equal(verifiedDelivery.claims.environmentId, "env-quota-1");
      }

      // Close tunnel -> default hold=false returns 503 -> enabling holdWebhooksWhileOffline holds (202) -> reconnect & hooks/wake replays it
      await tunnelConn1.closeAndAwait();

      const unheldOfflineHookRes = await fetch(
        `${localHttp}/v1/hooks/${endpointKey}/hook-daily/secret-tok-2`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event: "offline-unheld" }),
        },
      );
      NodeAssert.equal(unheldOfflineHookRes.status, 503);

      const enableHoldRes = await fetch(
        `${localHttp}/v1/environments/env-quota-1/link-preferences`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${link1Json.environmentCredential}`,
          },
          body: JSON.stringify({ holdWebhooksWhileOffline: true }),
        },
      );
      NodeAssert.equal(enableHoldRes.status, 200);

      const heldHookRes = await fetch(
        `${localHttp}/v1/hooks/${endpointKey}/hook-daily/secret-tok-2`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event: "offline-held" }),
        },
      );
      NodeAssert.equal(heldHookRes.status, 202);
      NodeAssert.equal(((await heldHookRes.json()) as { status: string }).status, "held");

      const tunnelConn2 = await connectTunnelWs({
        port: connectPort,
        tunnelId: link1Json.endpointRuntime.tunnelId,
        connectorToken: link1Json.endpointRuntime.connectorToken,
        targetPort: mockEnvPort,
      });
      const wakeRes = await fetch(`${localHttp}/v1/environments/env-quota-1/hooks/wake`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${link1Json.environmentCredential}`,
        },
        body: "{}",
      });
      NodeAssert.equal(wakeRes.status, 200);
      await secondWebhookPromise;
      NodeAssert.equal(webhookDeliveries.length, 2);
      NodeAssert.match(webhookDeliveries[1]!.body, /offline-held/);
      tunnelConn2.close();

      // Mobile DPoP registration + RelayClientDeviceRecord format + Live Activity + Agent Activity proof
      const dpopKeys = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      const jkt = computeThumbprint(dpopKeys);
      const dpopTokenRes = await fetch(`${localHttp}/v1/client/dpop-token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          dpop: createDpopProof({
            keyPair: dpopKeys,
            method: "POST",
            url: `${localHttp}/v1/client/dpop-token`,
          }),
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: quotaJson.accessToken,
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          resource: publicOrigin,
          scope: "environment:connect environment:status mobile:registration",
          client_id: "t3-mobile",
        }),
      });
      NodeAssert.equal(dpopTokenRes.status, 200);
      const { access_token: dpopToken } = (await dpopTokenRes.json()) as { access_token: string };

      const regIosRes = await fetch(`${localHttp}/v1/mobile/devices`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `DPoP ${dpopToken}`,
          dpop: createDpopProof({
            keyPair: dpopKeys,
            method: "POST",
            url: `${localHttp}/v1/mobile/devices`,
            accessToken: dpopToken,
          }),
        },
        body: JSON.stringify({
          deviceId: "ios-dev-1",
          label: "iPhone 16 Pro",
          platform: "ios",
          iosMajorVersion: 18,
          appVersion: "1.2.3",
          pushToken: "apns-secret-device-token",
          preferences: {
            notificationsEnabled: true,
            notifyOnApproval: true,
            notifyOnInput: true,
            notifyOnCompletion: false,
            notifyOnFailure: true,
          },
        }),
      });
      NodeAssert.equal(regIosRes.status, 200);

      const regAndroidRes = await fetch(`${localHttp}/v1/mobile/devices`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `DPoP ${dpopToken}`,
          dpop: createDpopProof({
            keyPair: dpopKeys,
            method: "POST",
            url: `${localHttp}/v1/mobile/devices`,
            accessToken: dpopToken,
          }),
        },
        body: JSON.stringify({
          deviceId: "android-dev-1",
          label: "Pixel 9",
          platform: "android",
          androidApiLevel: 35,
          preferences: {
            notificationsEnabled: true,
            notifyOnApproval: true,
            notifyOnInput: true,
            notifyOnCompletion: true,
            notifyOnFailure: true,
          },
        }),
      });
      NodeAssert.equal(regAndroidRes.status, 200);

      const liveActRes = await fetch(`${localHttp}/v1/mobile/live-activities`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `DPoP ${dpopToken}`,
          dpop: createDpopProof({
            keyPair: dpopKeys,
            method: "POST",
            url: `${localHttp}/v1/mobile/live-activities`,
            accessToken: dpopToken,
          }),
        },
        body: JSON.stringify({ deviceId: "ios-dev-1", activityPushToken: "live-act-secret" }),
      });
      NodeAssert.equal(liveActRes.status, 200);

      const v1DevicesJson = (await (
        await fetch(`${localHttp}/v1/client/devices`, {
          headers: { authorization: `Bearer ${quotaJson.accessToken}` },
        })
      ).json()) as {
        devices: Array<{
          deviceId: string;
          platform: string;
          pushToken?: string;
          notifications: { enabled: boolean };
          liveActivities: { enabled: boolean };
        }>;
      };
      NodeAssert.equal(v1DevicesJson.devices.length, 1);
      NodeAssert.equal(v1DevicesJson.devices[0]?.deviceId, "ios-dev-1");
      NodeAssert.equal(v1DevicesJson.devices[0]?.pushToken, undefined);
      NodeAssert.equal(v1DevicesJson.devices[0]?.notifications.enabled, true);
      NodeAssert.equal(v1DevicesJson.devices[0]?.liveActivities.enabled, true);

      const v2DevicesJson = (await (
        await fetch(`${localHttp}/v2/client/devices`, {
          headers: { authorization: `Bearer ${quotaJson.accessToken}` },
        })
      ).json()) as { devices: Array<{ deviceId: string }> };
      NodeAssert.equal(v2DevicesJson.devices.length, 2);

      // Publish agent activity with canonical key-order independence check
      const nowActivitySec = nowEpochSeconds();
      const signedState = {
        environmentId: "env-quota-1",
        threadId: "thread-abc",
        projectTitle: "t3code",
        threadTitle: "Wildcard verification",
        phase: "waiting_for_approval",
        headline: "Needs shell command approval",
        modelTitle: "Gemini",
        updatedAt: new Date(nowActivitySec * 1_000).toISOString(),
        deepLink: "lunacode://thread/thread-abc",
      };
      const reorderedState = {
        deepLink: signedState.deepLink,
        updatedAt: signedState.updatedAt,
        modelTitle: signedState.modelTitle,
        headline: signedState.headline,
        phase: signedState.phase,
        threadTitle: signedState.threadTitle,
        projectTitle: signedState.projectTitle,
        threadId: signedState.threadId,
        environmentId: signedState.environmentId,
      };
      const activityProof = signEdDsaJwt({
        privateKeyPem: env1PrivPem,
        typ: "t3-env-activity+jwt",
        payload: {
          iss: "t3-env:env-quota-1",
          sub: "env-quota-1",
          aud: publicOrigin,
          jti: NodeCrypto.randomUUID(),
          iat: nowActivitySec,
          exp: nowActivitySec + 120,
          environmentId: "env-quota-1",
          threadId: "thread-abc",
          state: signedState,
        },
      });
      const publishRes = await fetch(
        `${localHttp}/v1/environments/env-quota-1/threads/thread-abc/agent-activity`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${link1Json.environmentCredential}`,
          },
          body: JSON.stringify({ proof: activityProof, state: reorderedState }),
        },
      );
      NodeAssert.equal(publishRes.status, 200);

      const aggRes = await fetch(`${localHttp}/v1/mobile/agent-activity`, {
        headers: {
          authorization: `DPoP ${dpopToken}`,
          dpop: createDpopProof({
            keyPair: dpopKeys,
            method: "GET",
            url: `${localHttp}/v1/mobile/agent-activity`,
            accessToken: dpopToken,
          }),
        },
      });
      NodeAssert.equal(aggRes.status, 200);
      const aggJson = (await aggRes.json()) as {
        aggregate: {
          activeCount: number;
          activities: Array<{ threadId: string; phase: string }>;
        } | null;
      };
      NodeAssert.equal(aggJson.aggregate?.activeCount, 1);
      NodeAssert.equal(aggJson.aggregate?.activities.length, 1);
      NodeAssert.equal(aggJson.aggregate?.activities[0]?.threadId, "thread-abc");

      // Admin revokes webhooks + mobilePush -> 403 enforced on both
      const revokePermsRes = await fetch(`${localHttp}/api/admin/users/${quotaJson.user.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${adminJson.accessToken}`,
        },
        body: JSON.stringify({
          permissions: { managedTunnels: true, webhooks: false, mobilePush: false },
        }),
      });
      NodeAssert.equal(revokePermsRes.status, 200);
      NodeAssert.equal(
        (
          await fetch(`${localHttp}/v1/hooks/${endpointKey}/hook-daily/secret-tok-3`, {
            method: "POST",
            body: "{}",
          })
        ).status,
        403,
      );
      NodeAssert.equal(
        (
          await fetch(`${localHttp}/v1/mobile/devices`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `DPoP ${dpopToken}`,
              dpop: createDpopProof({
                keyPair: dpopKeys,
                method: "POST",
                url: `${localHttp}/v1/mobile/devices`,
                accessToken: dpopToken,
              }),
            },
            body: JSON.stringify({
              deviceId: "ios-dev-2",
              label: "iPad",
              platform: "ios",
              iosMajorVersion: 18,
              preferences: {
                notificationsEnabled: true,
                notifyOnApproval: true,
                notifyOnInput: true,
                notifyOnCompletion: false,
                notifyOnFailure: true,
              },
            }),
          })
        ).status,
        403,
      );

      // Self-service account endpoints: GET account, PATCH profile, POST change-password, revoke-other-sessions
      const accountRes = await fetch(`${localHttp}/api/auth/account`, {
        headers: { authorization: `Bearer ${quotaJson.accessToken}` },
      });
      NodeAssert.equal(accountRes.status, 200);
      const accountJson = (await accountRes.json()) as {
        activeTunnels: number;
        deviceCount: number;
        user: { maxTunnels: number };
      };
      NodeAssert.equal(accountJson.activeTunnels, 2);
      NodeAssert.equal(accountJson.deviceCount, 2);
      NodeAssert.equal(accountJson.user.maxTunnels, 2);

      const profileRes = await fetch(`${localHttp}/api/auth/profile`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${quotaJson.accessToken}`,
        },
        body: JSON.stringify({ displayName: "Updated Quota" }),
      });
      NodeAssert.equal(profileRes.status, 200);
      NodeAssert.equal(
        ((await profileRes.json()) as { user: { displayName: string } }).user.displayName,
        "Updated Quota",
      );

      const badPwChange = await fetch(`${localHttp}/api/auth/change-password`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${quotaJson.accessToken}`,
        },
        body: JSON.stringify({
          currentPassword: "wrong-password",
          newPassword: "new-password-456",
        }),
      });
      NodeAssert.equal(badPwChange.status, 401);

      const okPwChange = await fetch(`${localHttp}/api/auth/change-password`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${quotaJson.accessToken}`,
        },
        body: JSON.stringify({
          currentPassword: "quota-password-123",
          newPassword: "new-password-456",
        }),
      });
      NodeAssert.equal(okPwChange.status, 200);

      // Log in two sessions with the new password, then revoke other sessions from session 1
      const s1Login = await fetch(`${localHttp}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "quota@example.com", password: "new-password-456" }),
      });
      NodeAssert.equal(s1Login.status, 200);
      const s1Json = (await s1Login.json()) as { accessToken: string; refreshToken: string };
      const s1Cookie = s1Login.headers.get("set-cookie")?.split(";")[0] ?? "";

      const s2Login = await fetch(`${localHttp}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "quota@example.com", password: "new-password-456" }),
      });
      NodeAssert.equal(s2Login.status, 200);
      const s2Json = (await s2Login.json()) as { refreshToken: string };
      const s2Cookie = s2Login.headers.get("set-cookie")?.split(";")[0] ?? "";

      const revokeOthersRes = await fetch(`${localHttp}/api/auth/revoke-other-sessions`, {
        method: "POST",
        headers: {
          cookie: s1Cookie,
        },
      });
      NodeAssert.equal(revokeOthersRes.status, 200);

      // Session 1's cookie remains valid (200), while Session 2's cookie & refresh token are revoked (401)
      NodeAssert.equal(
        (await fetch(`${localHttp}/api/auth/account`, { headers: { cookie: s1Cookie } })).status,
        200,
      );
      NodeAssert.equal(
        (await fetch(`${localHttp}/api/auth/account`, { headers: { cookie: s2Cookie } })).status,
        401,
      );
      NodeAssert.equal(
        (
          await fetch(`${localHttp}/api/auth/token`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refreshToken: s2Json.refreshToken }),
          })
        ).status,
        401,
      );
      NodeAssert.ok(s1Json.accessToken);
      NodeAssert.ok(jkt);
    },
  );
});
