/**
 * MSB-first bitfield, matching the BitTorrent wire format.
 *
 * Piece 0 is the most significant bit of byte 0. Trailing bits beyond
 * `pieceCount` are always zero.
 */
export class BitField {
  readonly pieceCount: number;
  private readonly data: Uint8Array;

  constructor(pieceCount: number, source?: Uint8Array) {
    if (!Number.isInteger(pieceCount) || pieceCount < 0) {
      throw new Error("pieceCount must be a non-negative integer");
    }
    this.pieceCount = pieceCount;
    const length = Math.ceil(pieceCount / 8);
    this.data = new Uint8Array(length);
    if (source) {
      if (source.length < length) {
        throw new Error(`bitfield is too short: expected ${length} bytes, got ${source.length}`);
      }
      this.data.set(source.subarray(0, length));
    }
  }

  static all(pieceCount: number): BitField {
    const bits = new BitField(pieceCount);
    for (let i = 0; i < pieceCount; i++) bits.set(i);
    return bits;
  }

  get(index: number): boolean {
    this.assertIndex(index);
    return (this.data[index >> 3] & (0x80 >> (index & 7))) !== 0;
  }

  set(index: number, value = true): void {
    this.assertIndex(index);
    const mask = 0x80 >> (index & 7);
    if (value) this.data[index >> 3] |= mask;
    else this.data[index >> 3] &= ~mask;
  }

  count(): number {
    let total = 0;
    for (let i = 0; i < this.pieceCount; i++) {
      if (this.get(i)) total++;
    }
    return total;
  }

  hasNone(): boolean {
    for (const byte of this.data) if (byte !== 0) return false;
    return true;
  }

  clone(): BitField {
    return new BitField(this.pieceCount, this.data);
  }

  toBytes(): Uint8Array {
    return this.data.slice();
  }

  toHex(): string {
    let out = "";
    for (const byte of this.data) out += byte.toString(16).padStart(2, "0");
    return out;
  }

  private assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.pieceCount) {
      throw new Error(`piece index out of range: ${index}`);
    }
  }
}
