/** R2 key layout. Keeping it in one file makes cleanup and debugging simple. */

export function torrentObjectKey(infoHashHex: string): string {
  return `torrents/${infoHashHex}.torrent`;
}

export function stagingPrefix(infoHashHex: string): string {
  return `staging/${infoHashHex}/`;
}

export function stagingPieceKey(infoHashHex: string, pieceIndex: number, pieceCount: number): string {
  // Zero padding makes the staging prefix listable in piece order, which helps
  // when debugging a partial download in the dashboard.
  const width = Math.max(6, String(Math.max(0, pieceCount - 1)).length);
  return `${stagingPrefix(infoHashHex)}${String(pieceIndex).padStart(width, "0")}.piece`;
}

export function outputObjectKey(infoHashHex: string, outputName: string): string {
  return `downloads/${infoHashHex}/${outputName}`;
}

export function manifestObjectKey(infoHashHex: string): string {
  return `downloads/${infoHashHex}/manifest.json`;
}
