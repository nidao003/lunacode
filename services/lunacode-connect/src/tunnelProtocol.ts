import * as NodeCrypto from "node:crypto";

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const TUNNEL_FRAME = {
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

export type TunnelFrameType = (typeof TUNNEL_FRAME)[keyof typeof TUNNEL_FRAME];

export interface DecodedTunnelFrame {
  readonly type: number;
  readonly streamId: number;
  readonly payload: Buffer;
}

export function encodeTunnelFrame(
  type: number,
  streamId: number,
  payload?: Buffer | string,
): Buffer {
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

export function decodeTunnelFrame(buf: Buffer): DecodedTunnelFrame | null {
  if (buf.length < 5) {
    return null;
  }
  return {
    type: buf.readUInt8(0),
    streamId: buf.readUInt32BE(1),
    payload: buf.subarray(5),
  };
}

export function computeWebSocketAccept(secWebSocketKey: string): string {
  return NodeCrypto.createHash("sha1")
    .update(`${secWebSocketKey.trim()}${WS_GUID}`, "utf8")
    .digest("base64");
}

export interface WebSocketFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

export function encodeWebSocketFrame(input: {
  readonly opcode: number;
  readonly payload?: Buffer;
  readonly mask?: boolean;
  readonly fin?: boolean;
}): Buffer {
  const fin = input.fin ?? true;
  const payload = input.payload ?? Buffer.alloc(0);
  const maskBit = input.mask ? 0x80 : 0x00;
  const len = payload.length;
  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) headerLen += 2;
  else if (len > 0xffff) headerLen += 8;
  const maskLen = input.mask ? 4 : 0;
  const out = Buffer.allocUnsafe(headerLen + maskLen + len);
  out[0] = (fin ? 0x80 : 0x00) | (input.opcode & 0x0f);
  if (len < 126) {
    out[1] = maskBit | len;
  } else if (len <= 0xffff) {
    out[1] = maskBit | 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = maskBit | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  if (input.mask) {
    const maskKey = NodeCrypto.randomBytes(4);
    maskKey.copy(out, headerLen);
    const offset = headerLen + 4;
    for (let i = 0; i < len; i += 1) {
      out[offset + i] = payload[i]! ^ maskKey[i & 3]!;
    }
  } else if (len > 0) {
    payload.copy(out, headerLen);
  }
  return out;
}

export function createWebSocketFrameDecoder(
  onFrame: (frame: WebSocketFrame) => void,
): (chunk: Buffer) => void {
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
          throw new Error("WebSocket frame exceeds 64 MiB limit");
        }
        length = Number(bigLen);
        offset = 10;
      }
      const totalLen = offset + (masked ? 4 : 0) + length;
      if (buffer.length < totalLen) {
        return;
      }
      let payload = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), totalLen));
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
          const fullPayload = Buffer.concat(fragmentedChunks);
          const effectiveOpcode = fragmentedOpcode ?? 0x02;
          fragmentedOpcode = null;
          fragmentedChunks = [];
          onFrame({ fin: true, opcode: effectiveOpcode, payload: fullPayload });
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
