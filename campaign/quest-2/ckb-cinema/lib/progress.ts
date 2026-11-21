/** Public lesson progress only. Keys and decrypted content stay out of this cache. */
// CKB Cinema stores film license offers here; the key differs from the starter so its text offers are never restored.
export const encryptedSessionKey = 'ckb-cinema:checkout-progress-v1';
export const encryptedBuyerProfile = 'fiber-docs:multi-hop-sender-v1';
export const encryptedSellerProfile = 'fiber-docs:multi-hop-receiver-v1';
export const earlierSenderKey = 'fiber-docs:wasm-quickstart-profile-v1';

export function isMultiHopProfileKey(key: unknown, role: 'buyer' | 'seller'): key is string {
  if (typeof key !== 'string') return false;
  const base = role === 'buyer' ? encryptedBuyerProfile : encryptedSellerProfile;
  return key === base || key.startsWith(`${base}:fresh:`) || (role === 'buyer' && key === earlierSenderKey);
}

type Reader = Pick<Storage, 'getItem'>;
export type EncryptedLessonProgress = {
  version: 1;
  buyerId: string;
  sellerId: string;
  buyerProfileKey?: string;
  sellerProfileKey?: string;
  generatedOffer: string;
  buyerOfferText: string;
  attemptedPaymentHash: string;
  triedWithoutKey: boolean;
  completedSteps?: string[];
};

export function savedNodeIdentifier(storage: Reader, key: string): string | null {
  try {
    const profile = JSON.parse(storage.getItem(key) ?? 'null');
    return profile && /^[0-9a-f]{64}$/i.test(profile.fiberKey)
      && /^[0-9a-f]{64}$/i.test(profile.ckbKey)
      && typeof profile.identifier === 'string' && profile.identifier.length > 0
      ? profile.identifier : null;
  } catch { return null; }
}

export function readEncryptedProgress(session: Reader, profiles: Reader): EncryptedLessonProgress | null {
  try {
    const value = JSON.parse(session.getItem(encryptedSessionKey) ?? 'null');
    const buyerKey = value?.buyerProfileKey ?? encryptedBuyerProfile;
    const sellerKey = value?.sellerProfileKey ?? encryptedSellerProfile;
    if (!value || value.version !== 1
      || !isMultiHopProfileKey(buyerKey, 'buyer') || !isMultiHopProfileKey(sellerKey, 'seller')
      || !value.buyerId || value.buyerId !== savedNodeIdentifier(profiles, buyerKey)
      || !value.sellerId || value.sellerId !== savedNodeIdentifier(profiles, sellerKey)
      || typeof value.generatedOffer !== 'string' || typeof value.buyerOfferText !== 'string'
      || typeof value.attemptedPaymentHash !== 'string'
      || (value.attemptedPaymentHash && !/^0x[0-9a-f]{64}$/i.test(value.attemptedPaymentHash))
      || typeof value.triedWithoutKey !== 'boolean') return null;
    // Pick fields explicitly so extra cached secrets are never propagated.
    return { version: 1, buyerId: value.buyerId, sellerId: value.sellerId,
      ...(value.buyerProfileKey ? { buyerProfileKey: buyerKey } : {}),
      ...(value.sellerProfileKey ? { sellerProfileKey: sellerKey } : {}),
      generatedOffer: value.generatedOffer, buyerOfferText: value.buyerOfferText,
      attemptedPaymentHash: value.attemptedPaymentHash, triedWithoutKey: value.triedWithoutKey,
      ...(Array.isArray(value.completedSteps) ? { completedSteps: value.completedSteps.filter((step: unknown) => typeof step === 'string' && ['setup', 'encrypt', 'transfer', 'pay', 'decrypt'].includes(step)) } : {}) };
  } catch { return null; }
}

export function canSubmitEncryptedPayment(state: {
  routeReady: boolean; hasOffer: boolean; triedWithoutKey: boolean;
  attemptedPaymentHash: string; paymentStatus: string; busy: boolean;
}) {
  return state.routeReady && state.hasOffer && state.triedWithoutKey && !state.busy
    && (!state.attemptedPaymentHash || state.paymentStatus === 'Failed');
}

export function encryptedNodeStatus(state: {
  nodeState: string; starting: boolean; hasNode: boolean; hasChannel: boolean;
  connected: boolean; error: boolean;
}): { tone: 'idle' | 'waiting' | 'running' | 'error'; label: string } {
  if (state.nodeState === 'error' || (!state.hasNode && state.error)) return { tone: 'error', label: 'Error' };
  if (state.starting || ['starting', 'unlocking'].includes(state.nodeState)) return { tone: 'waiting', label: 'Starting' };
  if (state.nodeState === 'stopping') return { tone: 'waiting', label: 'Stopping' };
  if (state.nodeState === 'stopped') return { tone: 'idle', label: 'Stopped' };
  if (state.hasNode && state.nodeState === 'running') {
    return state.hasChannel && !state.connected ? { tone: 'waiting', label: 'Disconnected' } : { tone: 'running', label: 'Running' };
  }
  return { tone: 'idle', label: 'Not started' };
}
