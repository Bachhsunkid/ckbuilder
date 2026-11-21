export type EncryptedPayload = {
  ciphertext: `0x${string}`;
  iv: `0x${string}`;
};

export const toHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;

export const fromHex = (value: string) =>
  Uint8Array.from(value.replace(/^0x/, '').match(/.{2}/g) ?? [], (part) =>
    Number.parseInt(part, 16),
  );

const randomBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const encoder = new TextEncoder();

async function aesKey(raw: Uint8Array, usage: KeyUsage) {
  if (raw.length !== 32) throw new Error('AES-256 keys must be 32 bytes.');
  return crypto.subtle.importKey('raw', new Uint8Array(raw), { name: 'AES-GCM' }, false, [usage]);
}

export async function sha256Hex(data: Uint8Array | ArrayBuffer) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data))));
}

// ---------------------------------------------------------------------------
// Envelope encryption for films.
//
// The film is encrypted ONCE with a random content key (CEK). Every purchase
// gets its own random 32-byte secret that is used twice:
//   1. as the Fiber invoice payment preimage, so it is only revealed when the
//      buyer's payment settles, and
//   2. as an AES key that wraps (encrypts) the CEK for that purchase.
// The buyer therefore needs the settled payment to unwrap the CEK, while the
// large ciphertext can be published once on any CDN and shared by all buyers.
// ---------------------------------------------------------------------------

/** Encrypt the film bytes once. `aad` binds the public listing to the ciphertext. */
export async function encryptFilm(film: Uint8Array, aad: string) {
  const contentKey = randomBytes(32);
  const iv = randomBytes(12);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    await aesKey(contentKey, 'encrypt'),
    new Uint8Array(film),
  ));
  return { contentKey, iv: toHex(iv), ciphertext };
}

export async function decryptFilm(ciphertext: Uint8Array, ivHex: string, contentKey: Uint8Array, aad: string) {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromHex(ivHex), additionalData: encoder.encode(aad) },
    await aesKey(contentKey, 'decrypt'),
    new Uint8Array(ciphertext),
  ));
}

/** A fresh per-purchase secret and its payment hash, SHA-256(preimage). */
export async function newPreimage() {
  const preimage = randomBytes(32);
  return { preimage: toHex(preimage), paymentHash: (await sha256Hex(preimage)).toLowerCase() as `0x${string}` };
}

/** Wrap the film's content key with a purchase preimage. */
export async function wrapContentKey(contentKey: Uint8Array, preimageHex: string, aad: string) {
  const wrapIv = randomBytes(12);
  const wrappedKey = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: wrapIv, additionalData: encoder.encode(aad) },
    await aesKey(fromHex(preimageHex), 'encrypt'),
    new Uint8Array(contentKey),
  ));
  return { wrapIv: toHex(wrapIv), wrappedKey: toHex(wrappedKey) };
}

/** Recover the content key with the preimage revealed by the settled payment. */
export async function unwrapContentKey(wrappedKeyHex: string, wrapIvHex: string, preimageHex: string, aad: string) {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromHex(wrapIvHex), additionalData: encoder.encode(aad) },
    await aesKey(fromHex(preimageHex), 'decrypt'),
    fromHex(wrappedKeyHex),
  ));
}

/** The invoice payment hash is SHA-256(preimage); the buyer re-checks it locally. */
export async function preimageMatchesHash(preimageHex: string, paymentHash: string) {
  return (await sha256Hex(fromHex(preimageHex))).toLowerCase() === paymentHash.toLowerCase();
}
