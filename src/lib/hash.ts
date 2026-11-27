import { toHex } from "./bytes";

/** SHA-1 of a byte buffer, using the runtime's native Web Crypto implementation. */
export async function sha1Bytes(data: Uint8Array): Promise<Uint8Array> {
  // Web Crypto accepts BufferSource. Passing a view would also work, but the
  // spec is picky about SharedArrayBuffer-backed views; copy-free Uint8Array is
  // fine in workerd.
  const digest = await crypto.subtle.digest("SHA-1", data);
  return new Uint8Array(digest);
}

export async function sha1Hex(data: Uint8Array): Promise<string> {
  return toHex(await sha1Bytes(data));
}
