import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface MintKeyPair {
  readonly kid: string;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly publicJwk: Record<string, unknown>;
}

export interface DpopPublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

export type DpopVerificationResult =
  | {
      readonly ok: true;
      readonly thumbprint: string;
      readonly jti: string;
      readonly iat: number;
    }
  | {
      readonly ok: false;
      readonly code:
        | "missing_proof"
        | "malformed_proof"
        | "key_mismatch"
        | "method_mismatch"
        | "url_mismatch"
        | "access_token_hash_mismatch"
        | "time_window"
        | "invalid_signature";
    };

export function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

export function randomToken(byteLength = 32): string {
  return NodeCrypto.randomBytes(byteLength).toString("base64url");
}

export function randomUuid(): string {
  return NodeCrypto.randomUUID();
}

export function sha256Base64Url(input: string | Buffer): string {
  return NodeCrypto.createHash("sha256").update(input).digest("base64url");
}

export function sha256Hex(input: string | Buffer): string {
  return NodeCrypto.createHash("sha256").update(input).digest("hex");
}

export function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = NodeCrypto.randomBytes(16).toString("base64url");
    NodeCrypto.scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(`scrypt$${salt}$${derivedKey.toString("base64url")}`);
    });
  });
}

export function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return Promise.resolve(false);
  }
  const salt = parts[1];
  const expected = parts[2];
  if (!salt || !expected) {
    return Promise.resolve(false);
  }
  return new Promise((resolve, reject) => {
    NodeCrypto.scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      const expectedBuf = Buffer.from(expected, "base64url");
      if (derivedKey.length !== expectedBuf.length) {
        resolve(false);
        return;
      }
      resolve(NodeCrypto.timingSafeEqual(derivedKey, expectedBuf));
    });
  });
}

export function loadOrCreateMintKeys(input: {
  readonly keyFilePath: string;
  readonly configuredPrivateKeyPem?: string;
  readonly configuredPublicKeyPem?: string;
}): MintKeyPair {
  let privateKeyPem = input.configuredPrivateKeyPem;
  let publicKeyPem = input.configuredPublicKeyPem;

  if (!privateKeyPem || !publicKeyPem) {
    if (NodeFS.existsSync(input.keyFilePath)) {
      const saved = JSON.parse(NodeFS.readFileSync(input.keyFilePath, "utf8")) as {
        privateKeyPem?: string;
        publicKeyPem?: string;
      };
      if (saved.privateKeyPem && saved.publicKeyPem) {
        privateKeyPem = saved.privateKeyPem;
        publicKeyPem = saved.publicKeyPem;
      }
    }
  }

  if (!privateKeyPem || !publicKeyPem) {
    const pair = NodeCrypto.generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    privateKeyPem = pair.privateKey;
    publicKeyPem = pair.publicKey;
    NodeFS.mkdirSync(NodePath.dirname(input.keyFilePath), { recursive: true });
    NodeFS.writeFileSync(
      input.keyFilePath,
      JSON.stringify({ privateKeyPem, publicKeyPem }, null, 2),
      { mode: 0o600 },
    );
  }

  const pubKeyObj = NodeCrypto.createPublicKey(publicKeyPem);
  const jwk = pubKeyObj.export({ format: "jwk" }) as Record<string, unknown>;
  const kid = sha256Base64Url(publicKeyPem).slice(0, 16);

  return {
    kid,
    privateKeyPem,
    publicKeyPem,
    publicJwk: {
      ...jwk,
      kid,
      use: "sig",
      alg: "EdDSA",
    },
  };
}

export function signEdDsaJwt(input: {
  readonly privateKeyPem: string;
  readonly typ: string;
  readonly kid?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}): string {
  const header: Record<string, unknown> = {
    alg: "EdDSA",
    typ: input.typ,
  };
  if (input.kid) {
    header.kid = input.kid;
  }
  const encodedHeader = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(input.payload), "utf8").toString("base64url");
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = NodeCrypto.sign(null, Buffer.from(signingInput, "utf8"), input.privateKeyPem);
  return `${signingInput}.${signature.toString("base64url")}`;
}

export function verifyEdDsaJwt(input: {
  readonly publicKeyPem: string;
  readonly token: string;
  readonly expectedTyp?: string;
  readonly expectedIssuer?: string;
  readonly expectedAudience?: string;
  readonly maxTokenAgeSeconds?: number;
  readonly clockToleranceSeconds?: number;
  readonly nowEpochSeconds?: number;
}):
  | {
      readonly ok: true;
      readonly header: Record<string, unknown>;
      readonly claims: Record<string, unknown>;
    }
  | { readonly ok: false; readonly reason: string } {
  const parts = input.token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, reason: "malformed_jwt" };
  }
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (header.alg !== "EdDSA") {
      return { ok: false, reason: "alg_mismatch" };
    }
    if (input.expectedTyp && header.typ !== input.expectedTyp) {
      return { ok: false, reason: "typ_mismatch" };
    }
    const pubKey = NodeCrypto.createPublicKey(input.publicKeyPem);
    const sigOk = NodeCrypto.verify(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
      pubKey,
      Buffer.from(parts[2], "base64url"),
    );
    if (!sigOk) {
      return { ok: false, reason: "invalid_signature" };
    }
    const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1_000);
    const skew = input.clockToleranceSeconds ?? 60;
    if (typeof claims.exp === "number" && claims.exp < now - skew) {
      return { ok: false, reason: "expired" };
    }
    if (typeof claims.nbf === "number" && claims.nbf > now + skew) {
      return { ok: false, reason: "not_yet_valid" };
    }
    if (typeof claims.iat === "number") {
      if (claims.iat > now + skew) {
        return { ok: false, reason: "iat_in_future" };
      }
      if (
        input.maxTokenAgeSeconds !== undefined &&
        now - claims.iat > input.maxTokenAgeSeconds + skew
      ) {
        return { ok: false, reason: "max_age_exceeded" };
      }
    }
    if (input.expectedIssuer !== undefined && claims.iss !== input.expectedIssuer) {
      return { ok: false, reason: "iss_mismatch" };
    }
    if (input.expectedAudience !== undefined) {
      const aud = claims.aud;
      const audMatches = Array.isArray(aud)
        ? aud.includes(input.expectedAudience)
        : aud === input.expectedAudience;
      if (!audMatches) {
        return { ok: false, reason: "aud_mismatch" };
      }
    }
    return { ok: true, header, claims };
  } catch {
    return { ok: false, reason: "decode_error" };
  }
}

export function normalizeDpopHtu(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function computeDpopJwkThumbprint(jwk: DpopPublicJwk): string {
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  return sha256Base64Url(canonical);
}

export function verifyDpopProof(input: {
  readonly proof: string | undefined;
  readonly method: string;
  readonly allowedUrls: ReadonlyArray<string>;
  readonly expectedThumbprint?: string;
  readonly expectedAccessToken?: string;
  readonly nowEpochSeconds?: number;
}): DpopVerificationResult {
  if (!input.proof?.trim()) {
    return { ok: false, code: "missing_proof" };
  }
  const parts = input.proof.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, code: "malformed_proof" };
  }
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (header.typ !== "dpop+jwt" || header.alg !== "ES256") {
      return { ok: false, code: "malformed_proof" };
    }
    const rawJwk = header.jwk as Record<string, unknown> | undefined;
    if (
      !rawJwk ||
      rawJwk.kty !== "EC" ||
      rawJwk.crv !== "P-256" ||
      typeof rawJwk.x !== "string" ||
      typeof rawJwk.y !== "string" ||
      "d" in rawJwk
    ) {
      return { ok: false, code: "malformed_proof" };
    }
    const jwk: DpopPublicJwk = {
      kty: "EC",
      crv: "P-256",
      x: rawJwk.x,
      y: rawJwk.y,
    };
    const thumbprint = computeDpopJwkThumbprint(jwk);
    if (input.expectedThumbprint && thumbprint !== input.expectedThumbprint) {
      return { ok: false, code: "key_mismatch" };
    }
    if (
      typeof payload.htm !== "string" ||
      payload.htm.toUpperCase() !== input.method.toUpperCase()
    ) {
      return { ok: false, code: "method_mismatch" };
    }
    if (typeof payload.htu !== "string") {
      return { ok: false, code: "url_mismatch" };
    }
    const normalizedAllowed = input.allowedUrls
      .map((entry) => normalizeDpopHtu(entry))
      .filter((entry): entry is string => entry !== null);
    const proofHtu = normalizeDpopHtu(payload.htu);
    if (!proofHtu || !normalizedAllowed.includes(proofHtu)) {
      return { ok: false, code: "url_mismatch" };
    }
    if (input.expectedAccessToken) {
      const expectedAth = sha256Base64Url(input.expectedAccessToken);
      if (payload.ath !== expectedAth) {
        return { ok: false, code: "access_token_hash_mismatch" };
      }
    }
    if (typeof payload.jti !== "string" || !payload.jti || typeof payload.iat !== "number") {
      return { ok: false, code: "malformed_proof" };
    }
    const pubKey = NodeCrypto.createPublicKey({
      key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
      format: "jwk",
    });
    const sigOk = NodeCrypto.verify(
      "sha256",
      Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
      { key: pubKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(parts[2], "base64url"),
    );
    if (!sigOk) {
      return { ok: false, code: "invalid_signature" };
    }
    const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1_000);
    if (Math.abs(now - payload.iat) > 300) {
      return { ok: false, code: "time_window" };
    }
    return {
      ok: true,
      thumbprint,
      jti: payload.jti,
      iat: Math.trunc(payload.iat),
    };
  } catch {
    return { ok: false, code: "malformed_proof" };
  }
}

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = NodeCrypto.createHash("sha256").update(verifier, "utf8").digest("base64url");
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(challenge, "utf8");
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
}
