import { asciiBytes, asciiString, bytesEqual, concatBytes, readU32, u32Bytes } from "../lib/bytes";

export const PROTOCOL_STRING = "BitTorrent protocol";
export const HANDSHAKE_LENGTH = 68;

export const MessageId = {
  Choke: 0,
  Unchoke: 1,
  Interested: 2,
  NotInterested: 3,
  Have: 4,
  Bitfield: 5,
  Request: 6,
  Piece: 7,
  Cancel: 8,
  Port: 9,
  Extended: 20,
} as const;

export interface HandshakeInfo {
  infoHash: Uint8Array;
  peerId: Uint8Array;
  reserved: Uint8Array;
}

export interface ParsedFrame {
  id: number;
  payload: Uint8Array;
}

export function buildHandshake(
  infoHash: Uint8Array,
  peerId: Uint8Array,
  options: { extended?: boolean } = {},
): Uint8Array {
  if (infoHash.length !== 20) throw new Error("info hash must be 20 bytes");
  if (peerId.length !== 20) throw new Error("peer id must be 20 bytes");
  const out = new Uint8Array(HANDSHAKE_LENGTH);
  out[0] = PROTOCOL_STRING.length;
  out.set(asciiBytes(PROTOCOL_STRING), 1);
  // Reserved byte 5, bit 0x10 = BEP 10 extension protocol.
  if (options.extended) out[25] |= 0x10;
  out.set(infoHash, 28);
  out.set(peerId, 48);
  return out;
}

export function parseHandshake(bytes: Uint8Array): HandshakeInfo {
  if (bytes.length !== HANDSHAKE_LENGTH) throw new Error("handshake must be 68 bytes");
  if (bytes[0] !== PROTOCOL_STRING.length) throw new Error("unexpected protocol string length");
  if (asciiString(bytes.subarray(1, 20)) !== PROTOCOL_STRING) {
    throw new Error("unexpected BitTorrent protocol string");
  }
  return {
    reserved: bytes.slice(20, 28),
    infoHash: bytes.slice(28, 48),
    peerId: bytes.slice(48, 68),
  };
}

export function validateHandshake(bytes: Uint8Array, expectedInfoHash: Uint8Array): HandshakeInfo {
  const info = parseHandshake(bytes);
  if (!bytesEqual(info.infoHash, expectedInfoHash)) {
    throw new Error("handshake info hash does not match the requested torrent");
  }
  return info;
}

export function supportsExtendedProtocol(reserved: Uint8Array): boolean {
  return reserved.length >= 6 && (reserved[5] & 0x10) !== 0;
}

export function buildExtendedHandshake(payload: Uint8Array): Uint8Array {
  return buildMessage(MessageId.Extended, concatBytes([new Uint8Array([0]), payload]));
}

export function buildExtendedMessage(extensionId: number, payload: Uint8Array): Uint8Array {
  if (extensionId < 1 || extensionId > 255) throw new Error("invalid extended message id");
  return buildMessage(MessageId.Extended, concatBytes([new Uint8Array([extensionId]), payload]));
}

export function buildMessage(id: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (!Number.isInteger(id) || id < 0 || id > 255) throw new Error("invalid peer message id");
  const out = new Uint8Array(5 + payload.length);
  out.set(u32Bytes(1 + payload.length), 0);
  out[4] = id;
  out.set(payload, 5);
  return out;
}

export function buildKeepAlive(): Uint8Array {
  return new Uint8Array(4);
}

export function buildSimpleMessage(id: number): Uint8Array {
  return buildMessage(id);
}

export function buildHave(index: number): Uint8Array {
  return buildMessage(MessageId.Have, u32Bytes(index));
}

export function buildBitfield(bitfield: Uint8Array): Uint8Array {
  return buildMessage(MessageId.Bitfield, bitfield);
}

export function buildRequest(index: number, begin: number, length: number): Uint8Array {
  return buildMessage(MessageId.Request, concatBytes([u32Bytes(index), u32Bytes(begin), u32Bytes(length)]));
}

export function buildCancel(index: number, begin: number, length: number): Uint8Array {
  return buildMessage(MessageId.Cancel, concatBytes([u32Bytes(index), u32Bytes(begin), u32Bytes(length)]));
}

/** Build a piece message. The PoC never uploads, but this is useful in tests. */
export function buildPiece(index: number, begin: number, block: Uint8Array): Uint8Array {
  return buildMessage(MessageId.Piece, concatBytes([u32Bytes(index), u32Bytes(begin), block]));
}

/** Split a complete message (length prefix included) into id + payload. */
export function parseFrame(message: Uint8Array): ParsedFrame {
  if (message.length < 4) throw new Error("peer message is missing its length prefix");
  const length = readU32(message, 0);
  if (length === 0) throw new Error("keep-alive has no message id");
  if (message.length !== 4 + length) throw new Error("peer message length does not match its payload");
  const body = message.subarray(4);
  return { id: body[0], payload: body.subarray(1) };
}
