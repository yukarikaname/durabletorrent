import { connect } from "cloudflare:sockets";
import { readU32 } from "../lib/bytes";
import { LIMITS } from "../lib/limits";
import {
  buildHandshake,
  buildKeepAlive,
  buildRequest,
  buildSimpleMessage,
  MessageId,
  validateHandshake,
  type HandshakeInfo,
  type ParsedFrame,
} from "./peer-frames";

export class PeerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerTimeoutError";
  }
}

export class PeerClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerClosedError";
  }
}

export interface PeerWireOptions {
  host: string;
  port: number;
  infoHash: Uint8Array;
  peerId: Uint8Array;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** Advertise BEP 10 extension protocol support in the handshake. */
  extended?: boolean;
}

/**
 * A small framed reader/writer around one outbound `cloudflare:sockets`
 * connection.
 *
 * The socket is opened inside the alarm/request handler (never at module
 * scope) and closed explicitly. Reads are deadline-driven because workerd
 * stream reads have no built-in timeout.
 */
export class PeerWire {
  private readonly buffer = { bytes: new Uint8Array(0), offset: 0 };
  private closed = false;
  private constructor(
    private readonly socket: Socket,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {}

  static async connectAndHandshake(
    options: PeerWireOptions,
  ): Promise<{ wire: PeerWire; handshake: HandshakeInfo }> {
    let socket: Socket | undefined;
    try {
      socket = connect({ hostname: options.host, port: options.port });
      await withTimeout(
        socket.opened,
        options.connectTimeoutMs ?? LIMITS.connectTimeoutMs,
        `TCP connect to ${options.host}:${options.port} timed out`,
      );

      const reader = socket.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const writer = socket.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
      const wire = new PeerWire(socket, reader, writer);

      await wire.send(buildHandshake(options.infoHash, options.peerId, { extended: options.extended }));
      const bytes = await wire.readExactly(
        68,
        Date.now() + (options.handshakeTimeoutMs ?? LIMITS.handshakeTimeoutMs),
      );
      const handshake = validateHandshake(bytes, options.infoHash);
      return { wire, handshake };
    } catch (error) {
      await socket?.close().catch(() => undefined);
      throw error;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async send(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new PeerClosedError("socket is closed");
    await this.writer.write(bytes);
  }

  sendInterested(): Promise<void> {
    return this.send(buildSimpleMessage(MessageId.Interested));
  }

  sendNotInterested(): Promise<void> {
    return this.send(buildSimpleMessage(MessageId.NotInterested));
  }

  sendKeepAlive(): Promise<void> {
    return this.send(buildKeepAlive());
  }

  sendRequest(index: number, begin: number, length: number): Promise<void> {
    return this.send(buildRequest(index, begin, length));
  }

  /**
   * Read exactly `size` bytes, or throw PeerTimeoutError / PeerClosedError.
   * `deadline` is an absolute epoch-millisecond timestamp.
   */
  async readExactly(size: number, deadline: number): Promise<Uint8Array> {
    if (size < 0) throw new Error("read size must be non-negative");
    if (size === 0) return new Uint8Array(0);
    if (size > LIMITS.maxPeerMessageBytes + 4) throw new Error("peer read is too large");

    while (this.available < size) {
      const chunk = await this.readChunk(deadline);
      const merged = new Uint8Array(this.available + chunk.length);
      merged.set(this.buffer.bytes.subarray(this.buffer.offset), 0);
      merged.set(chunk, this.available);
      this.buffer.bytes = merged;
      this.buffer.offset = 0;
    }

    return this.consume(size);
  }

  /** Read one length-prefixed message. Keep-alives are skipped transparently. */
  async nextMessage(deadline: number): Promise<ParsedFrame> {
    while (true) {
      if (Date.now() >= deadline) throw new PeerTimeoutError("peer read timed out");
      const header = await this.readExactly(4, deadline);
      const length = readU32(header, 0);
      if (length === 0) continue; // keep-alive
      if (length > LIMITS.maxPeerMessageBytes) {
        throw new Error(`peer message length ${length} exceeds the PoC limit`);
      }
      const body = await this.readExactly(length, deadline);
      return { id: body[0], payload: body.subarray(1) };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // socket.close() forcibly closes both streams. Closing the writer first can
    // wait for queued data on an unresponsive peer, so avoid that.
    await this.socket.close().catch(() => undefined);
  }

  private get available(): number {
    return this.buffer.bytes.length - this.buffer.offset;
  }

  private consume(size: number): Uint8Array {
    const start = this.buffer.offset;
    const out = this.buffer.bytes.slice(start, start + size);
    this.buffer.offset += size;
    if (this.buffer.offset >= this.buffer.bytes.length) {
      this.buffer.bytes = new Uint8Array(0);
      this.buffer.offset = 0;
    } else if (this.buffer.offset > 64 * 1024) {
      this.buffer.bytes = this.buffer.bytes.slice(this.buffer.offset);
      this.buffer.offset = 0;
    }
    return out;
  }

  private readChunk(deadline: number): Promise<Uint8Array> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return Promise.reject(new PeerTimeoutError("peer read timed out"));
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new PeerTimeoutError("peer read timed out"));
      }, remaining);

      this.reader.read().then(
        ({ done, value }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (done) reject(new PeerClosedError("peer closed the connection"));
          else if (!value || value.length === 0) resolve(new Uint8Array(0));
          else resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new PeerClosedError(String(error)));
        },
      );
    });
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new PeerTimeoutError(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
