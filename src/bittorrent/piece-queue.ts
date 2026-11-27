/**
 * Shared claim queue for one download wave.
 *
 * Peers pop pieces from the main list. If a peer does not advertise a piece it
 * is deferred instead of discarded, so another peer can still take it. The
 * queue is in-memory only; SQLite's piece.state is the durable record.
 */
export class PieceQueue {
  private main: number[];
  private deferred: number[] = [];

  constructor(indices: number[]) {
    this.main = shuffle([...indices]);
  }

  get size(): number {
    return this.main.length + this.deferred.length;
  }

  take(has: ((index: number) => boolean) | null): number | null {
    // Bound the scan so a peer that has almost nothing cannot spin forever.
    for (let attempts = 0; attempts < 128; attempts++) {
      if (this.main.length === 0) {
        if (this.deferred.length === 0) return null;
        this.main = this.deferred;
        this.deferred = [];
        continue;
      }
      const index = this.main.pop()!;
      if (has && !has(index)) {
        this.deferred.push(index);
        continue;
      }
      return index;
    }
    return null;
  }

  release(index: number): void {
    this.main.push(index);
  }
}

function shuffle<T>(values: T[]): T[] {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = values[i];
    values[i] = values[j];
    values[j] = tmp;
  }
  return values;
}
