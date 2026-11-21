import { bottle } from './fiber';
import type { Channel, FiberBrowserNode } from '@fiber-pay/sdk/browser';
import { newPreimage, wrapContentKey } from './crypto';
import { ckbToShannons, licenseAad, prices, type FilmRelease } from './catalog';

/**
 * A per-purchase license offer. The film ciphertext is NOT inside the offer:
 * it is published once (see FilmRelease) and fetched separately. The offer only
 * carries the content key wrapped with this purchase's payment preimage.
 */
export type EncryptedOffer = {
  version: 3;
  kind: 'film-license';
  cipher: 'AES-256-GCM';
  filmId: string;
  filmSha256: `0x${string}`;
  priceCkb: number;
  wrappedKey: `0x${string}`;
  wrapIv: `0x${string}`;
  invoice: string;
  paymentHash: `0x${string}`;
  lastHop: {
    pubkey: `0x${string}`;
    channel_outpoint: `0x${string}`;
    fee_rate: `0x${string}`;
    tlc_expiry_delta: `0x${string}`;
  };
};

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeHexBytes(value: unknown, label: string, bytes?: number) {
  if (typeof value !== 'string') throw new Error(`${label} is missing.`);
  const body = value.trim().replace(/^0x/i, '');
  if (!body || body.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(body)) {
    throw new Error(`${label} must be hexadecimal bytes.`);
  }
  if (bytes !== undefined && body.length !== bytes * 2) {
    throw new Error(`${label} must be ${bytes} bytes.`);
  }
  return `0x${body.toLowerCase()}` as `0x${string}`;
}

function normalizeHexQuantity(value: unknown, label: string) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return `0x${value.toString(16)}` as `0x${string}`;
  }
  if (typeof value !== 'string') throw new Error(`${label} is missing.`);
  const normalized = value.trim();
  if (/^0x[0-9a-f]+$/i.test(normalized)) {
    return `0x${BigInt(normalized).toString(16)}` as `0x${string}`;
  }
  if (/^\d+$/.test(normalized)) {
    return `0x${BigInt(normalized).toString(16)}` as `0x${string}`;
  }
  throw new Error(`${label} must be a non-negative integer.`);
}

function packOutpoint(txHash: `0x${string}`, index: `0x${string}`) {
  const indexValue = BigInt(index);
  if (indexValue > 0xffff_ffffn) throw new Error('Last-hop output index exceeds u32.');
  const indexBytes = indexValue
    .toString(16)
    .padStart(8, '0')
    .match(/../g)
    ?.reverse()
    .join('');
  return `0x${txHash.slice(2)}${indexBytes}` as `0x${string}`;
}

function normalizeOutpoint(value: unknown): EncryptedOffer['lastHop']['channel_outpoint'] {
  if (isJsonObject(value)) {
    return packOutpoint(
      normalizeHexBytes(value.tx_hash ?? value.txHash, 'Last-hop transaction hash', 32),
      normalizeHexQuantity(value.index, 'Last-hop output index'),
    );
  }
  if (typeof value === 'string' && /^0x[0-9a-f]{72}$/i.test(value.trim())) {
    return value.trim().toLowerCase() as `0x${string}`;
  }
  throw new Error('Last-hop channel outpoint is missing or malformed.');
}

function normalizeLastHop(value: unknown): EncryptedOffer['lastHop'] {
  if (!isJsonObject(value)) throw new Error('Last-hop hint is missing.');
  if (normalizeHexBytes(value.pubkey, 'Last-hop public key', 33) !== bottle.pubkey) throw new Error('Last-hop hint must identify Bottle.');
  return {
    pubkey: normalizeHexBytes(value.pubkey, 'Last-hop public key', 33),
    channel_outpoint: normalizeOutpoint(value.channel_outpoint ?? value.channelOutpoint),
    fee_rate: normalizeHexQuantity(value.fee_rate ?? value.feeRate, 'Last-hop fee rate'),
    tlc_expiry_delta: normalizeHexQuantity(
      value.tlc_expiry_delta ?? value.tlcExpiryDelta,
      'Last-hop expiry delta',
    ),
  };
}

/** Seller: create one license offer (fresh preimage, invoice and wrapped key) for one purchase. */
export async function createOffer(
  seller: FiberBrowserNode,
  sellerChannel: Channel,
  release: FilmRelease,
  contentKey: Uint8Array,
  priceCkb: number,
) {
  if (!sellerChannel.channel_outpoint) {
    throw new Error('Seller channel does not have a confirmed outpoint.');
  }
  if (!isListedPrice(priceCkb)) throw new Error('Choose a listed price.');
  const { filmId, filmSha256, title } = release.film;
  const { preimage, paymentHash } = await newPreimage();
  const license = await wrapContentKey(contentKey, preimage, licenseAad(filmId, filmSha256, priceCkb, paymentHash));
  const invoice = await seller.newInvoice({
    amount: `0x${ckbToShannons(priceCkb).toString(16)}`,
    currency: 'Fibt',
    payment_preimage: preimage,
    hash_algorithm: 'sha256',
    allow_trampoline_routing: true,
    description: `CKB Cinema: ${title}`.slice(0, 120),
    expiry: '0xe10', // 1 hour
  });
  if (invoice.invoice.data.payment_hash.toLowerCase() !== paymentHash) {
    throw new Error('The node returned an unexpected payment hash for this license.');
  }
  const offer: EncryptedOffer = {
    version: 3,
    kind: 'film-license',
    cipher: 'AES-256-GCM',
    filmId,
    filmSha256,
    priceCkb,
    ...license,
    invoice: invoice.invoice_address,
    paymentHash,
    lastHop: {
      pubkey: sellerChannel.pubkey,
      channel_outpoint: normalizeOutpoint(sellerChannel.channel_outpoint),
      fee_rate: normalizeHexQuantity(
        sellerChannel.tlc_fee_proportional_millionths,
        'Last-hop fee rate',
      ),
      tlc_expiry_delta: normalizeHexQuantity(
        sellerChannel.tlc_expiry_delta,
        'Last-hop expiry delta',
      ),
    },
  };
  return JSON.stringify(offer, null, 2);
}

function isListedPrice(value: unknown): value is (typeof prices)[number] {
  return prices.includes(value as (typeof prices)[number]);
}

/** Buyer: strictly parse a license offer. Unknown fields are dropped. */
export function parseOffer(value: string) {
  const offer: unknown = JSON.parse(value);
  if (!isJsonObject(offer) || offer.version !== 3 || offer.kind !== 'film-license' || offer.cipher !== 'AES-256-GCM') {
    throw new Error('This is not a CKB Cinema film license offer.');
  }
  if (typeof offer.invoice !== 'string' || !offer.invoice.toLowerCase().startsWith('fibt')) {
    throw new Error('License offer is missing a Fiber testnet Invoice.');
  }
  if (typeof offer.filmId !== 'string' || !/^[a-z0-9-]{1,48}$/.test(offer.filmId)) throw new Error('Film id is malformed.');
  if (!isListedPrice(offer.priceCkb)) throw new Error('License price is not a listed price.');
  return {
    version: 3,
    kind: 'film-license',
    cipher: 'AES-256-GCM',
    filmId: offer.filmId,
    filmSha256: normalizeHexBytes(offer.filmSha256, 'Film fingerprint', 32),
    priceCkb: offer.priceCkb,
    // 32-byte content key + 16-byte GCM tag
    wrappedKey: normalizeHexBytes(offer.wrappedKey, 'Wrapped key', 48),
    wrapIv: normalizeHexBytes(offer.wrapIv, 'Wrap IV', 12),
    invoice: offer.invoice,
    paymentHash: normalizeHexBytes(offer.paymentHash, 'Invoice payment hash', 32),
    lastHop: normalizeLastHop(offer.lastHop),
  } satisfies EncryptedOffer;
}
