import assert from 'node:assert/strict';
import test from 'node:test';
import { payForOffer, validateOffer } from './lib/payment.ts';

const hash = `0x${'a'.repeat(64)}`;
const offer = { invoice: 'fibt-example', paymentHash: hash, priceCkb: 1, lastHop: {} };
function fixture(status = 'Success') {
  const calls = [];
  const result = { status, payment_hash: hash, fee: '0x0' };
  const node = {
    parseInvoice: async () => ({ invoice: { currency: 'Fibt', amount: '0x5f5e100', data: { payment_hash: hash } } }),
    sendPayment: async () => { calls.push('send'); return result; },
    getPayment: async () => { calls.push('check'); return result; },
    waitForPayment: async () => result,
  };
  return { node, calls, result };
}
test('mismatched currency, amount, or payment hash blocks submission', async () => {
  for (const change of [{ currency: 'Fibb' }, { amount: '0x1' }, { data: { payment_hash: '0xother' } }]) {
    const { node, calls } = fixture();
    const original = node.parseInvoice;
    node.parseInvoice = async () => ({ invoice: { ...(await original()).invoice, ...change } });
    await assert.rejects(validateOffer(node, offer), /does not match/);
    assert.deepEqual(calls, []);
  }
});
test('the invoice must ask exactly the license price', async () => {
  const { node, calls } = fixture();
  await assert.rejects(validateOffer(node, { ...offer, priceCkb: 2 }), /does not match this 2 CKB/);
  await validateOffer(node, offer);
  assert.deepEqual(calls, []);
});
test('attempt is recorded before submission and failed storage prevents spending', async () => {
  const { node, calls } = fixture();
  await payForOffer(node, offer, '', () => calls.push('record'));
  assert.deepEqual(calls, ['record', 'send']);
  const second = fixture();
  await assert.rejects(payForOffer(second.node, offer, '', () => { throw new Error('Storage failed'); }), /Storage failed/);
  assert.deepEqual(second.calls, []);
});
test('restored successful and pending payments are checked without resubmission', async () => {
  for (const status of ['Success', 'Inflight']) {
    const { node, calls } = fixture(status);
    await payForOffer(node, offer, hash, () => calls.push('record'), true);
    assert.deepEqual(calls, ['check']);
  }
});
test('retry requires both explicit intent and a verified failure', async () => {
  const first = fixture('Failed');
  await payForOffer(first.node, offer, hash, () => first.calls.push('record'));
  assert.deepEqual(first.calls, ['check']);
  const retry = fixture('Failed');
  await payForOffer(retry.node, offer, hash, () => retry.calls.push('record'), true);
  assert.deepEqual(retry.calls, ['check', 'record', 'send']);
  await assert.rejects(payForOffer(retry.node, offer, '0xwrong', () => {}), /previous payment/);
});

test('an expired Invoice is rejected before recording or submitting a new payment', async () => {
  const { node, calls } = fixture();
  const original = node.parseInvoice;
  node.parseInvoice = async () => ({ invoice: { ...(await original()).invoice,
    data: { payment_hash: hash, timestamp: '0x0', attrs: [{ expiry_time: '0x1' }] } } });
  await assert.rejects(payForOffer(node, offer, '', () => calls.push('record')), /expired/);
  assert.deepEqual(calls, []);
});

test('a rejected submission clears durable progress so reload does not restore a nonexistent attempt', async () => {
  const { node } = fixture();
  let saved = JSON.stringify({ attemptedPaymentHash: '' });
  const record = attemptedPaymentHash => { saved = JSON.stringify({ attemptedPaymentHash }); };
  node.sendPayment = async () => { throw new Error(`WASM RPC error: ErrorObject { code: ServerError(-32000), message: ${JSON.stringify('InvalidParameter: Failed to validate payment request: "invoice is expired"')}, data: None }`); };
  node.getPayment = async () => { throw new Error(`WASM RPC error: ErrorObject { code: ServerError(-32000), message: ${JSON.stringify(`InvalidParameter: Payment session not found: ${hash}`)}, data: None }`); };
  await assert.rejects(payForOffer(node, offer, '', record), /Payment was not submitted/);
  assert.equal(JSON.parse(saved).attemptedPaymentHash, '');
  const fresh = fixture();
  await payForOffer(fresh.node, offer, JSON.parse(saved).attemptedPaymentHash, record);
  assert.deepEqual(fresh.calls, ['send']);
});

test('an uncertain send or a polling timeout retains the attempt across reload and never resends it', async () => {
  for (const phase of ['send', 'wait']) {
    const { node, calls } = fixture('Inflight');
    let saved = '';
    const record = value => { saved = value; };
    if (phase === 'send') node.sendPayment = async () => { calls.push('send'); throw new Error('Worker disconnected'); };
    else node.waitForPayment = async () => { throw new Error('Payment timed out'); };
    await assert.rejects(payForOffer(node, offer, '', record));
    assert.equal(saved, hash);
    await payForOffer(node, offer, saved, record, true);
    assert.deepEqual(calls, ['send', 'check']);
  }
});

test('settled payments can still be recovered after their Invoice expires', async () => {
  const { node, calls, result } = fixture('Success');
  const original = node.parseInvoice;
  node.parseInvoice = async () => ({ invoice: { ...(await original()).invoice,
    data: { payment_hash: hash, timestamp: '0x0', attrs: [{ expiry_time: '0x1' }] } } });
  assert.equal(await payForOffer(node, offer, hash, () => assert.fail('Do not record or resend')), result);
  assert.deepEqual(calls, ['check']);
});

test('a failed attempt reset cannot silently ignore a browser storage error', async () => {
  const { node } = fixture();
  node.sendPayment = async () => { throw new Error('invoice is expired'); };
  node.getPayment = async () => { throw new Error(`Payment session not found: ${hash}`); };
  let saved = '';
  await assert.rejects(payForOffer(node, offer, '', value => {
    if (!value) throw new Error('Storage failed');
    saved = value;
  }), /Storage failed/);
  assert.equal(saved, hash);
});
