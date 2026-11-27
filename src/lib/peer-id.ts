import { asciiBytes, randomBytes } from "./bytes";
import { PEER_ID_PREFIX } from "./limits";

/** 20-byte Azureus-style peer ID with a random 12-character suffix. */
export function makePeerId(): Uint8Array {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const random = randomBytes(12);
  let suffix = "";
  for (const byte of random) suffix += alphabet[byte % alphabet.length];
  return asciiBytes(PEER_ID_PREFIX + suffix);
}
