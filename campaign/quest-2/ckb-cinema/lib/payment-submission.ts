import type { FiberBrowserNode, SendPaymentParams } from '@fiber-pay/sdk/browser';

type ParsedInvoice = Awaited<ReturnType<FiberBrowserNode['parseInvoice']>>['invoice'];

export class EncryptedPaymentRejectedError extends Error {
  constructor(reason: string) {
    super(`Payment was not submitted: ${reason}. Start another offer to continue.`);
    this.name = 'EncryptedPaymentRejectedError';
  }
}

export function assertEncryptedInvoiceNotExpired(invoice: ParsedInvoice, now = Date.now()) {
  const expiry = invoice.data.attrs?.find((attribute) => 'expiry_time' in attribute);
  if (expiry && 'expiry_time' in expiry
    && BigInt(invoice.data.timestamp) + BigInt(expiry.expiry_time) * 1_000n <= BigInt(now)) {
    throw new Error('This Invoice has expired. Start another offer to continue.');
  }
}

// fiber-js 0.10.1 stringifies the Rust RPC error; SDK 0.3.1 adds this prefix.
// Read the actual message, never a similar phrase in RPC parameters or data.
function rpcMessage(error: unknown): string {
  if (!(error instanceof Error)) return '';
  let message = error.message.replace(/^WASM RPC error:\s*/, '');
  const rustMessage = /^ErrorObject(?:Owned)? \{ code: [^,]+, message: ("(?:[^"\\]|\\.)*"), data: .*\}$/s.exec(message);
  if (rustMessage) {
    try { message = JSON.parse(rustMessage[1]) as string; } catch { return ''; }
  }
  message = message.replace(/^InvalidParameter:\s*/, '');
  const validation = /^Failed to validate payment request: ("(?:[^"\\]|\\.)*")$/.exec(message);
  if (validation) {
    try { return JSON.parse(validation[1]) as string; } catch { return ''; }
  }
  return message;
}

// These v0.10.1 validation errors return before the payment actor is created.
// Route failures, worker failures and timeouts do not prove non-submission.
const preSubmissionRejections = new Set([
  'invoice is expired',
  'invoice is invalid',
  'invoice is not signed',
  'invoice does not support hop hints',
  'payment secret is required for multi-path payment',
]);

export async function submitEncryptedPayment(
  node: Pick<FiberBrowserNode, 'sendPayment' | 'getPayment' | 'waitForPayment'>,
  paymentHash: `0x${string}`,
  params: SendPaymentParams,
) {
  let submitted;
  try {
    submitted = await node.sendPayment(params);
  } catch (error) {
    const reason = rpcMessage(error);
    if (!preSubmissionRejections.has(reason)) throw error;
    // Even a rejected retry must preserve any earlier successful/pending attempt.
    try {
      return await node.getPayment({ payment_hash: paymentHash });
    } catch (checkError) {
      const missing = rpcMessage(checkError);
      if (missing.startsWith('Payment session not found:')
        && missing.toLowerCase().includes(paymentHash.slice(2).toLowerCase())) {
        throw new EncryptedPaymentRejectedError(reason);
      }
      // An unavailable status read leaves the original attempt uncertain.
      throw error;
    }
  }
  // A timeout after sendPayment returned must never be treated as a rejection.
  return submitted.status === 'Success' || submitted.status === 'Failed' ? submitted
    : node.waitForPayment(submitted.payment_hash, { timeout: 60_000, interval: 1_000 });
}
