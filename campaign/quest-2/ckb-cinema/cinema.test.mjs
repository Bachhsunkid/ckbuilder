import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptFilm, encryptFilm, newPreimage, preimageMatchesHash, sha256Hex, unwrapContentKey, wrapContentKey } from './lib/crypto.ts';
import { ckbToShannons, filmAad, licenseAad, parseRelease } from './lib/catalog.ts';

const film = { filmId: 'neon-tide', title: 'Neon Tide', mime: 'video/webm', size: 4096, filmSha256: '' };
const bytes = crypto.getRandomValues(new Uint8Array(4096));

async function published() {
  const info = { ...film, filmSha256: await sha256Hex(bytes) };
  const encrypted = await encryptFilm(bytes, filmAad(info));
  return { info, encrypted };
}

async function license(contentKey, info, price = 2) {
  const { preimage, paymentHash } = await newPreimage();
  const aad = licenseAad(info.filmId, info.filmSha256, price, paymentHash);
  return { preimage, paymentHash, aad, ...(await wrapContentKey(contentKey, preimage, aad)) };
}

test('a settled preimage unwraps the content key and decrypts the film', async () => {
  const { info, encrypted } = await published();
  const l = await license(encrypted.contentKey, info);
  assert.equal(await preimageMatchesHash(l.preimage, l.paymentHash), true);
  const contentKey = await unwrapContentKey(l.wrappedKey, l.wrapIv, l.preimage, l.aad);
  const plain = await decryptFilm(encrypted.ciphertext, encrypted.iv, contentKey, filmAad(info));
  assert.deepEqual(plain, bytes);
  assert.equal(await sha256Hex(plain), info.filmSha256);
});

test('a guessed key cannot unwrap a license', async () => {
  const { info, encrypted } = await published();
  const l = await license(encrypted.contentKey, info);
  const guess = (await newPreimage()).preimage;
  await assert.rejects(unwrapContentKey(l.wrappedKey, l.wrapIv, guess, l.aad));
});

test('every purchase gets its own payment hash, yet all open the same ciphertext', async () => {
  const { info, encrypted } = await published();
  const first = await license(encrypted.contentKey, info);
  const second = await license(encrypted.contentKey, info);
  assert.notEqual(first.paymentHash, second.paymentHash);
  assert.notEqual(first.wrappedKey, second.wrappedKey);
  for (const l of [first, second]) {
    const key = await unwrapContentKey(l.wrappedKey, l.wrapIv, l.preimage, l.aad);
    assert.deepEqual(await decryptFilm(encrypted.ciphertext, encrypted.iv, key, filmAad(info)), bytes);
  }
  // One purchase's key does not open another purchase's license.
  await assert.rejects(unwrapContentKey(second.wrappedKey, second.wrapIv, first.preimage, second.aad));
});

test('a license is bound to its price and payment hash', async () => {
  const { info, encrypted } = await published();
  const l = await license(encrypted.contentKey, info, 2);
  await assert.rejects(unwrapContentKey(l.wrappedKey, l.wrapIv, l.preimage, licenseAad(info.filmId, info.filmSha256, 1, l.paymentHash)));
});

test('a changed film description makes decryption fail', async () => {
  const { info, encrypted } = await published();
  const l = await license(encrypted.contentKey, info);
  const key = await unwrapContentKey(l.wrappedKey, l.wrapIv, l.preimage, l.aad);
  await assert.rejects(decryptFilm(encrypted.ciphertext, encrypted.iv, key, filmAad({ ...info, title: 'Neon Tide (Director’s Cut)' })));
});

test('a tampered ciphertext is rejected', async () => {
  const { info, encrypted } = await published();
  const l = await license(encrypted.contentKey, info);
  const key = await unwrapContentKey(l.wrappedKey, l.wrapIv, l.preimage, l.aad);
  const tampered = encrypted.ciphertext.slice();
  tampered[10] ^= 1;
  await assert.rejects(decryptFilm(tampered, encrypted.iv, key, filmAad(info)));
});

test('releases are parsed strictly', async () => {
  const { info, encrypted } = await published();
  const release = { version: 1, film: info, contentIv: encrypted.iv, ciphertextSha256: await sha256Hex(encrypted.ciphertext), ciphertextSize: encrypted.ciphertext.length, extra: 'dropped' };
  assert.equal('extra' in parseRelease(release), false);
  assert.throws(() => parseRelease({ ...release, ciphertextSize: 1 }), /does not match/);
  assert.throws(() => parseRelease({ ...release, film: { ...info, mime: 'text/html' } }), /Only video/);
  assert.throws(() => parseRelease({ ...release, film: { ...info, filmId: '../x' } }), /malformed/);
});

test('prices convert to exact shannons', () => {
  assert.equal(ckbToShannons(1), 100_000_000n);
  assert.equal(ckbToShannons(3), 300_000_000n);
});
