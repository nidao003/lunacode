import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";

import { handleAdminRoute } from "./adminRoutes.ts";
import { bootstrapAdmins, handleAuthRoute, sendJson } from "./authRoutes.ts";
import type { ConnectConfig } from "./config.ts";
import { loadOrCreateMintKeys, type MintKeyPair } from "./crypto.ts";
import { ConnectDatabase } from "./db.ts";
import { handleRelayRoute } from "./relayRoutes.ts";
import { TunnelHub } from "./tunnelHub.ts";
import { replayHeldWebhooksForEnvironment } from "./webhookRelay.ts";

export interface ConnectServerInstance {
  readonly server: NodeHttp.Server;
  readonly db: ConnectDatabase;
  readonly tunnelHub: TunnelHub;
  readonly mintKeys: MintKeyPair;
  readonly port: number;
  readonly origin: string;
  readonly close: () => Promise<void>;
}

const MAX_CONTROL_BODY_BYTES = 1024 * 1024;

const STATIC_MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function serveHostedWebStatic(input: {
  readonly webDistDir: string | null;
  readonly req: NodeHttp.IncomingMessage;
  readonly res: NodeHttp.ServerResponse;
  readonly url: URL;
}): boolean {
  const { webDistDir, req, res, url } = input;
  if (!webDistDir) return false;
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return false;

  const indexHtmlPath = NodePath.join(webDistDir, "index.html");
  if (!NodeFS.existsSync(indexHtmlPath)) return false;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  if (decodedPath.includes("\0")) return false;

  if (
    decodedPath === "/health" ||
    decodedPath.startsWith("/api/") ||
    decodedPath.startsWith("/oauth/") ||
    decodedPath.startsWith("/v1/") ||
    decodedPath.startsWith("/v2/") ||
    decodedPath.startsWith("/.well-known/") ||
    decodedPath.startsWith("/_tunnel/") ||
    decodedPath.startsWith("/t/")
  ) {
    return false;
  }

  const resolvedRoot = NodePath.resolve(webDistDir);
  const rel = decodedPath.replace(/^\/+/u, "");
  const candidate = rel ? NodePath.resolve(resolvedRoot, rel) : indexHtmlPath;
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${NodePath.sep}`)) {
    return false;
  }

  let targetFile: string | null = null;
  try {
    if (rel && NodeFS.existsSync(candidate) && NodeFS.statSync(candidate).isFile()) {
      targetFile = candidate;
    }
  } catch {
    targetFile = null;
  }

  if (!targetFile) {
    if (decodedPath.startsWith("/assets/")) {
      res.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(method === "HEAD" ? undefined : "Not found");
      return true;
    }
    targetFile = indexHtmlPath;
  }

  const ext = NodePath.extname(targetFile).toLowerCase();
  const contentType = STATIC_MIME_TYPES[ext] ?? "application/octet-stream";
  const cacheControl =
    rel.startsWith("assets/") && targetFile !== indexHtmlPath
      ? "public, max-age=31536000, immutable"
      : ext === ".html"
        ? "no-cache"
        : "public, max-age=3600";

  const content = NodeFS.readFileSync(targetFile);
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": String(content.length),
    "cache-control": cacheControl,
  });
  res.end(method === "HEAD" ? undefined : content);
  return true;
}

function readRequestBody(req: NodeHttp.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CONTROL_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function applyCorsHeaders(
  config: ConnectConfig,
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
): void {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !origin) {
    return;
  }
  const allowAllOrConfigured =
    config.corsAllowedOrigins.length === 0 || config.corsAllowedOrigins.includes(origin);
  if (!allowAllOrConfigured) {
    return;
  }
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,b3,traceparent,content-type,dpop");
  res.setHeader(
    "access-control-expose-headers",
    "x-t3-relay-credential-expiring,traceparent,www-authenticate",
  );
}

type TunnelRequestResolution =
  | {
      readonly kind: "tunnel";
      readonly tunnelId: string;
      readonly targetUrl: string;
      readonly forwardedPrefix?: string;
      readonly forwardedHost: string;
    }
  | { readonly kind: "not_found" }
  | null;

function ensureHostWithPort(rawHost: string, publicPort: string): string {
  const trimmed = rawHost.trim();
  if (!trimmed) return "";
  if (!publicPort) return trimmed;
  if (trimmed.startsWith("[")) {
    return trimmed.includes("]:") ? trimmed : `${trimmed}:${publicPort}`;
  }
  return trimmed.includes(":") ? trimmed : `${trimmed}:${publicPort}`;
}

function resolveTunnelRequest(
  config: ConnectConfig,
  tunnelHub: TunnelHub,
  req: NodeHttp.IncomingMessage,
): TunnelRequestResolution {
  const parsedUrl = new URL(req.url ?? "/", "http://localhost");
  const rawPathWithQuery = `${parsedUrl.pathname}${parsedUrl.search}`;
  const rawHostHeader = typeof req.headers.host === "string" ? req.headers.host : "";
  const fallbackHost = new URL(config.publicOrigin).host;
  const forwardedHost = ensureHostWithPort(rawHostHeader, config.tunnelPublicPort) || fallbackHost;

  const prefixMatch = /^\/t\/([a-z0-9_-]{1,64})(?:(\/.*))?$/iu.exec(parsedUrl.pathname);
  if (prefixMatch) {
    const slug = prefixMatch[1]!.toLowerCase();
    const restPath = prefixMatch[2] || "/";
    const tunnelId = tunnelHub.resolveTunnelForSlug(slug);
    if (!tunnelId) {
      return { kind: "not_found" };
    }
    return {
      kind: "tunnel",
      tunnelId,
      targetUrl: `${restPath}${parsedUrl.search}`,
      forwardedPrefix: `/t/${slug}`,
      forwardedHost,
    };
  }

  const hostOnly = rawHostHeader.startsWith("[")
    ? (rawHostHeader.match(/^(\[[^\]]+\])/u)?.[1]?.toLowerCase() ?? "")
    : (rawHostHeader.split(":")[0]?.toLowerCase() ?? "");
  const publicHost = new URL(config.publicOrigin).hostname.toLowerCase();
  if (hostOnly && hostOnly !== publicHost && hostOnly !== "127.0.0.1" && hostOnly !== "localhost") {
    const tunnelId = tunnelHub.resolveTunnelForHost(hostOnly);
    if (tunnelId) {
      return {
        kind: "tunnel",
        tunnelId,
        targetUrl: rawPathWithQuery,
        forwardedHost: ensureHostWithPort(rawHostHeader, config.tunnelPublicPort) || hostOnly,
      };
    }
  }

  return null;
}

export async function startConnectServer(config: ConnectConfig): Promise<ConnectServerInstance> {
  const db = new ConnectDatabase(config.sqlitePath);
  await bootstrapAdmins({ config, db });
  if (config.tunnelWildcardDomain) {
    const portSuffix = config.tunnelPublicPort ? `:${config.tunnelPublicPort}` : "";
    db.reconcileWildcardTunnelEndpoints({
      wildcardDomain: config.tunnelWildcardDomain,
      scheme: config.tunnelBaseScheme,
      portSuffix,
    });
  }
  const mintKeys = loadOrCreateMintKeys({
    keyFilePath: config.keyFilePath,
    configuredPrivateKeyPem: config.mintPrivateKeyPem,
    configuredPublicKeyPem: config.mintPublicKeyPem,
  });
  const tunnelHub = new TunnelHub(db);
  const issuer = config.publicOrigin.replace(/\/+$/u, "");
  tunnelHub.setOnTunnelConnected((env) => {
    void replayHeldWebhooksForEnvironment({
      env,
      db,
      tunnelHub,
      mintKeys,
      issuer,
    }).catch(() => undefined);
  });

  const server = NodeHttp.createServer(async (req, res) => {
    const resolved = resolveTunnelRequest(config, tunnelHub, req);
    if (resolved?.kind === "not_found") {
      sendJson(res, 404, { error: "tunnel_not_found" });
      return;
    }
    if (resolved?.kind === "tunnel") {
      tunnelHub.proxyExternalHttp(resolved.tunnelId, req, res, {
        targetUrl: resolved.targetUrl,
        ...(resolved.forwardedPrefix ? { forwardedPrefix: resolved.forwardedPrefix } : {}),
        forwardedProto: config.tunnelBaseScheme,
        forwardedHost: resolved.forwardedHost,
      });
      return;
    }

    applyCorsHeaders(config, req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url ?? "/", config.publicOrigin);
      const body =
        req.method === "GET" || req.method === "HEAD"
          ? Buffer.alloc(0)
          : await readRequestBody(req);
      const ctx = { req, res, url, body };

      if (await handleAuthRoute({ ctx, config, mintKeys, db })) {
        return;
      }
      if (await handleAdminRoute({ ctx, config, mintKeys, db, tunnelHub })) {
        return;
      }
      if (await handleRelayRoute({ ctx, config, mintKeys, db, tunnelHub })) {
        return;
      }
      if (serveHostedWebStatic({ webDistDir: config.webDistDir, req, res, url })) {
        return;
      }
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
        res.writeHead(302, {
          location: "/login",
          "cache-control": "no-store",
        });
        res.end();
        return;
      }
      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      if (!res.headersSent) {
        const isTooLarge = error instanceof Error && error.message === "Request body too large";
        sendJson(res, isTooLarge ? 413 : 500, {
          error: isTooLarge ? "payload_too_large" : "internal_error",
          message: error instanceof Error ? error.message : "Unexpected error",
        });
      }
    }
  });

  server.on("upgrade", (req: NodeHttp.IncomingMessage, socket: NodeStream.Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/_tunnel/connect") {
      tunnelHub.handleControlUpgrade(req, socket, head);
      return;
    }
    const resolved = resolveTunnelRequest(config, tunnelHub, req);
    if (resolved?.kind === "tunnel") {
      tunnelHub.proxyExternalUpgrade(resolved.tunnelId, req, socket, head, {
        targetUrl: resolved.targetUrl,
        ...(resolved.forwardedPrefix ? { forwardedPrefix: resolved.forwardedPrefix } : {}),
        forwardedProto: config.tunnelBaseScheme,
        forwardedHost: resolved.forwardedHost,
      });
      return;
    }
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address() as NodeNet.AddressInfo | null;
  const boundPort = addr?.port ?? config.port;
  const origin = config.publicOrigin;

  return {
    server,
    db,
    tunnelHub,
    mintKeys,
    port: boundPort,
    origin,
    close: async () => {
      tunnelHub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      db.close();
    },
  };
}
