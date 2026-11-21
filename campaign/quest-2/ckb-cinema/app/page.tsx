'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { scriptToAddress, type Channel, type FiberBrowserNode, type GetPaymentResult } from '@fiber-pay/sdk/browser';
import { channelFundingGuidance, onChainBalance } from '../lib/channel-funding';
import { decryptFilm, preimageMatchesHash, sha256Hex, toHex, unwrapContentKey } from '../lib/crypto';
import { bottle, channelFundingCkb, connectAndOpenChannel, readChannel, ready, startRole } from '../lib/fiber';
import { createOffer, parseOffer, type EncryptedOffer } from '../lib/offer';
import { payForOffer, validateOffer } from '../lib/payment';
import { createBrowserNodeSession } from '../lib/node-session';
import { encryptedSessionKey, encryptedBuyerProfile, encryptedSellerProfile, savedNodeIdentifier, readEncryptedProgress, type EncryptedLessonProgress } from '../lib/progress';
import { ckbToShannons, filmAad, formatBytes, licenseAad, maxFilmBytes, prices, sampleFilms, type FilmInfo, type FilmRelease } from '../lib/catalog';
import { downloadCiphertext, listReleases, publishFilm, recordLicense, studioContentKey, studioLicenses } from '../lib/vault';
import Intro from './intro';

type Role = 'buyer' | 'seller';
const roleName: Record<Role, string> = { buyer: 'Viewer A', seller: 'Studio C' };
const ckb = (shannons: string | bigint) => {
  const value = Number(BigInt(shannons)) / 100_000_000;
  return value.toLocaleString('en-US', { maximumFractionDigits: 3 });
};
const short = (hex: string, size = 10) => (hex.length > size * 2 ? `${hex.slice(0, size)}…${hex.slice(-6)}` : hex);

type Check = { what: string; result: string };

type Checkout = {
  offer: EncryptedOffer;
  release: FilmRelease;
  ciphertext: Uint8Array;
};

export default function Page() {
  const nodes = useRef<Partial<Record<Role, FiberBrowserNode>>>({});
  const sessions = useRef<Partial<Record<Role, ReturnType<typeof createBrowserNodeSession>>>>({});
  const progress = useRef<EncryptedLessonProgress | null>(null);
  const locked = useRef(false);
  const videoUrl = useRef('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addresses, setAddresses] = useState<Partial<Record<Role, string>>>({});
  const [balances, setBalances] = useState<Partial<Record<Role, bigint>>>({});
  const [connected, setConnected] = useState<Partial<Record<Role, boolean>>>({});
  const [channels, setChannels] = useState<Partial<Record<Role, Channel>>>({});
  const [releases, setReleases] = useState<FilmRelease[]>([]);
  const [filmPrices, setFilmPrices] = useState<Record<string, number>>(() => Object.fromEntries(sampleFilms.map((film) => [film.filmId, film.priceCkb])));
  const [customTitle, setCustomTitle] = useState('');
  const [customFile, setCustomFile] = useState<File | null>(null);
  const [masters, setMasters] = useState<Record<string, File>>({});
  const [licenses, setLicenses] = useState<Record<string, string[]>>({});
  const [trailer, setTrailer] = useState('');
  const [featured, setFeatured] = useState('neon-tide');
  const [restoredOffer, setRestoredOffer] = useState('');
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [offerJson, setOfferJson] = useState('');
  const [attempt, setAttempt] = useState('');
  const [tested, setTested] = useState(false);
  const [payment, setPayment] = useState<GetPaymentResult | null>(null);
  const [key, setKey] = useState('');
  const [watchUrl, setWatchUrl] = useState('');
  const [checks, setChecks] = useState<Check[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const loadReleases = useCallback(async () => {
    const order = (filmId: string) => { const index = sampleFilms.findIndex((film) => film.filmId === filmId); return index < 0 ? sampleFilms.length : index; };
    const list = (await listReleases()).sort((a, b) => order(a.film.filmId) - order(b.film.filmId));
    setReleases(list);
    const entries = await Promise.all(list.map(async (release) => [release.film.filmId, await studioLicenses(release.film.filmId)] as const));
    setLicenses(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    const saved = readEncryptedProgress(sessionStorage, localStorage);
    progress.current = saved;
    if (saved?.buyerOfferText) { setRestoredOffer(saved.buyerOfferText); setAttempt(saved.attemptedPaymentHash); setTested(saved.triedWithoutKey); }
    void loadReleases().catch(() => setError('Browser storage is unavailable, so films cannot be published here.')).finally(() => setLoaded(true));
    const owned = sessions.current;
    const stop = () => { for (const session of Object.values(owned)) void session.stop().catch(() => {}); };
    window.addEventListener('pagehide', stop);
    return () => {
      window.removeEventListener('pagehide', stop); stop(); nodes.current = {}; sessions.current = {};
      if (videoUrl.current) URL.revokeObjectURL(videoUrl.current);
    };
  }, [loadReleases]);

  function save(update: Partial<EncryptedLessonProgress>) {
    const buyerId = savedNodeIdentifier(localStorage, encryptedBuyerProfile);
    const sellerId = savedNodeIdentifier(localStorage, encryptedSellerProfile);
    if (!buyerId || !sellerId) throw new Error('Start both saved nodes before continuing.');
    const next = { version: 1 as const, buyerId, sellerId, generatedOffer: '', buyerOfferText: '', attemptedPaymentHash: '', triedWithoutKey: false, ...progress.current, ...update };
    sessionStorage.setItem(encryptedSessionKey, JSON.stringify(next));
    progress.current = next;
  }

  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Action failed. Check status before retrying a payment.'); }
    finally { locked.current = false; setBusy(false); }
  }

  // ---------- Network ----------

  const refresh = useCallback(async (role: Role) => {
    const node = nodes.current[role];
    if (!node) return;
    const [channel, { peers }] = await Promise.all([readChannel(node), node.listPeers()]);
    setConnected((previous) => ({ ...previous, [role]: peers.some((peer) => peer.pubkey.replace(/^0x/i, '').toLowerCase() === bottle.pubkey.slice(2)) }));
    setChannels((previous) => ({ ...previous, [role]: channel }));
    if (!channel || !ready(channel)) {
      const balance = await onChainBalance(node).catch(() => undefined);
      if (balance !== undefined) setBalances((previous) => ({ ...previous, [role]: balance }));
    }
  }, []);

  async function start(role: Role) {
    if (nodes.current[role]) return;
    const session = sessions.current[role] ??= createBrowserNodeSession();
    let started: FiberBrowserNode | undefined;
    await session.start(role === 'buyer' ? encryptedBuyerProfile : encryptedSellerProfile, async (track) => {
      started = await startRole(role, track);
    });
    if (!started) return;
    nodes.current[role] = started;
    const info = await started.nodeInfo();
    setAddresses((previous) => ({ ...previous, [role]: scriptToAddress(info.default_funding_lock_script, 'testnet') }));
    if (await readChannel(started)) await started.connectPeer(bottle);
    await refresh(role);
  }

  async function open(role: Role) {
    const node = nodes.current[role];
    if (!node) return;
    const channel = await connectAndOpenChannel(node);
    setChannels((previous) => ({ ...previous, [role]: channel }));
    await refresh(role);
    setStatus(channel && ready(channel) ? `${roleName[role]} channel is ready.` : 'Channel opening submitted. It becomes ready after on-chain confirmation.');
  }

  const networkReady = Boolean(connected.buyer && connected.seller && channels.buyer && ready(channels.buyer) && channels.seller && ready(channels.seller));
  const routeReady = (price: number) => Boolean(networkReady && channels.buyer && channels.seller
    && BigInt(channels.buyer.local_balance) >= ckbToShannons(price) && BigInt(channels.seller.remote_balance) >= ckbToShannons(price));

  // Poll while a node is waiting for funds, a channel or its Bottle connection.
  useEffect(() => {
    const roles = (Object.keys(addresses) as Role[]);
    if (!roles.length || networkReady) return;
    const timer = setInterval(() => {
      if (locked.current) return;
      for (const role of roles) void refresh(role).catch(() => {});
    }, 5_000);
    return () => clearInterval(timer);
  }, [addresses, networkReady, refresh]);

  // ---------- Studio ----------

  async function publishSample(film: FilmInfo) {
    const file = masters[film.filmId];
    if (!file) throw new Error(`Choose the master file for ${film.title} (samples/films/${film.filmId}.webm).`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if ((await sha256Hex(bytes)).toLowerCase() !== film.masterSha256) {
      throw new Error(`${file.name} is not the master of ${film.title}: its SHA-256 does not match the catalog.`);
    }
    const release = await publishFilm(film.filmId, film.title, bytes, 'video/webm');
    await loadReleases();
    setStatus(`${film.title} printed: encrypted once (${formatBytes(release.ciphertextSize)}) and sent to the CDN.`);
  }

  async function publishCustom() {
    if (!customFile) return;
    if (!customFile.type.startsWith('video/')) throw new Error('Choose a video file.');
    if (customFile.size > maxFilmBytes) throw new Error(`Films are limited to ${maxFilmBytes / 1024 / 1024} MB in this demo.`);
    const title = customTitle.trim() || customFile.name.replace(/\.[^.]+$/, '');
    const filmId = `custom-${crypto.randomUUID().slice(0, 8)}`;
    await publishFilm(filmId, title.slice(0, 80), new Uint8Array(await customFile.arrayBuffer()), customFile.type);
    setFilmPrices((previous) => ({ ...previous, [filmId]: 1 }));
    setCustomFile(null); setCustomTitle('');
    await loadReleases();
    setStatus(`${title} printed and sent to the CDN.`);
  }

  // ---------- Checkout ----------

  /** Buyer: verify an offer against the invoice and the public release, then fetch the encrypted film. */
  async function receiveOffer(text: string, buyer: FiberBrowserNode) {
    const offer = parseOffer(text);
    const release = releases.find((item) => item.film.filmId === offer.filmId);
    if (!release) throw new Error('This license is for a film that is not in the catalog.');
    if (release.film.filmSha256 !== offer.filmSha256) throw new Error('The license does not match the published film.');
    const info = sampleFilms.find((film) => film.filmId === release.film.filmId);
    if (info && info.masterSha256 !== release.film.filmSha256) throw new Error('The published film does not match the catalog fingerprint.');
    await validateOffer(buyer, offer);
    const ciphertext = await downloadCiphertext(release);
    setCheckout({ offer, release, ciphertext });
    setOfferJson(text);
    setChecks([
      ...(info ? [{ what: `Release matches the catalog fingerprint for ${info.title}`, result: short(info.masterSha256, 8) }] : []),
      { what: `Invoice is on Fiber Testnet and asks exactly ${offer.priceCkb} CKB`, result: `Fibt · ${offer.priceCkb} CKB` },
      { what: 'Encrypted film from the CDN matches the release', result: `${formatBytes(ciphertext.length)} · ok` },
    ]);
    return offer;
  }

  async function requestLicense(release: FilmRelease) {
    const seller = nodes.current.seller;
    const buyer = nodes.current.buyer;
    const price = filmPrices[release.film.filmId] ?? 1;
    if (!seller || !buyer || !channels.seller || !routeReady(price)) throw new Error('Open both channels before buying a ticket.');
    if (attempt && payment?.status !== 'Failed') throw new Error('Finish or check the current payment first.');
    // Studio C: issue a fresh license (new preimage, new invoice) for this purchase.
    const text = await createOffer(seller, channels.seller, release, await studioContentKey(release.film.filmId), price);
    const offer = parseOffer(text);
    setLicenses((previous) => ({ ...previous, [offer.filmId]: [...(previous[offer.filmId] ?? []), offer.paymentHash] }));
    void recordLicense(offer.filmId, offer.paymentHash);
    // The offer is delivered to Viewer A directly, never through Bottle.
    save({ generatedOffer: text, buyerOfferText: text, attemptedPaymentHash: '', triedWithoutKey: false });
    resetPurchase();
    await receiveOffer(text, buyer);
    setStatus(`Ticket offer received for ${release.film.title}. Check it, then pay.`);
    document.getElementById('checkout')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function restoreCheckout() {
    const buyer = nodes.current.buyer;
    if (!buyer || !restoredOffer) return;
    const offer = await receiveOffer(restoredOffer, buyer);
    if (attempt && attempt.toLowerCase() !== offer.paymentHash.toLowerCase()) throw new Error('Restore the offer for the previous payment.');
    setRestoredOffer('');
    setStatus(attempt ? 'Checkout restored. Check the payment status.' : 'Checkout restored.');
  }

  async function tryWithoutPaying() {
    if (!checkout) return;
    const { offer } = checkout;
    try {
      const guess = toHex(crypto.getRandomValues(new Uint8Array(32)));
      await unwrapContentKey(offer.wrappedKey, offer.wrapIv, guess, licenseAad(offer.filmId, offer.filmSha256, offer.priceCkb, offer.paymentHash));
      throw new Error('Unexpected: a guessed key opened the license.');
    } catch (failure) {
      if (failure instanceof Error && failure.message.startsWith('Unexpected')) throw failure;
      save({ triedWithoutKey: true }); setTested(true);
      setChecks((previous) => [...previous, { what: 'Playing without paying: a guessed key was rejected', result: 'locked' }]);
      setStatus('Locked. The film key is only revealed by the payment.');
    }
  }

  async function acceptPayment(result: GetPaymentResult) {
    setPayment(result); setStatus(`Payment: ${result.status}`);
    if (result.status === 'Failed') setError(result.failed_error ?? 'Payment failed. Check channel liquidity before retrying.');
    if (result.status === 'Success' && result.payment_preimage && checkout) {
      if (!(await preimageMatchesHash(result.payment_preimage, checkout.offer.paymentHash))) {
        throw new Error('The revealed key does not match the invoice payment hash.');
      }
      setKey(result.payment_preimage);
      setChecks((previous) => [...previous, { what: 'Payment settled; SHA-256 of the revealed key equals the payment hash', result: short(checkout.offer.paymentHash, 6) }]);
    }
  }

  async function pay() {
    const buyer = nodes.current.buyer;
    if (!buyer || !checkout || !tested || !routeReady(checkout.offer.priceCkb)) return;
    const result = await payForOffer(buyer, checkout.offer, attempt, (hash) => {
      save({ attemptedPaymentHash: hash }); setAttempt(hash);
    }, payment?.status === 'Failed');
    await acceptPayment(result);
    await Promise.all([refresh('buyer'), refresh('seller')]);
  }

  async function checkPayment() {
    const buyer = nodes.current.buyer;
    if (!buyer || !checkout || !attempt) return;
    await validateOffer(buyer, checkout.offer);
    await acceptPayment(await buyer.getPayment({ payment_hash: attempt as `0x${string}` }));
  }

  async function watch() {
    if (!checkout || !key) return;
    const { offer, release, ciphertext } = checkout;
    const contentKey = await unwrapContentKey(offer.wrappedKey, offer.wrapIv, key, licenseAad(offer.filmId, offer.filmSha256, offer.priceCkb, offer.paymentHash));
    const film = await decryptFilm(ciphertext, release.contentIv, contentKey, filmAad(release.film));
    if ((await sha256Hex(film)).toLowerCase() !== release.film.filmSha256.toLowerCase()) throw new Error('The decrypted film does not match its published fingerprint.');
    if (videoUrl.current) URL.revokeObjectURL(videoUrl.current);
    videoUrl.current = URL.createObjectURL(new Blob([film], { type: release.film.mime }));
    setWatchUrl(videoUrl.current);
    setChecks((previous) => [...previous, { what: 'Film key unwrapped, film decrypted, film SHA-256 matches', result: `${formatBytes(film.length)} · ok` }]);
    setStatus(`Enjoy ${release.film.title}.`);
  }

  function resetPurchase() {
    if (videoUrl.current) URL.revokeObjectURL(videoUrl.current);
    videoUrl.current = '';
    setCheckout(null); setOfferJson(''); setAttempt(''); setTested(false); setPayment(null);
    setKey(''); setWatchUrl(''); setChecks([]); setError('');
  }

  function closeCheckout() {
    if (busy || (attempt && payment?.status !== 'Success' && payment?.status !== 'Failed')) return;
    save({ generatedOffer: '', buyerOfferText: '', attemptedPaymentHash: '', triedWithoutKey: false, completedSteps: [] });
    resetPurchase();
    setStatus('Pick another film.');
  }

  // ---------- Render ----------

  const canPay = Boolean(checkout && tested && routeReady(checkout.offer.priceCkb) && !key && (!attempt || payment?.status === 'Failed'));
  const filmInfo = (filmId: string) => sampleFilms.find((film) => film.filmId === filmId);
  const openChannels = (['buyer', 'seller'] as const).filter((role) => channels[role] && ready(channels[role]!) && connected[role]).length;
  const ticketNo = checkout ? String((licenses[checkout.offer.filmId] ?? []).indexOf(checkout.offer.paymentHash) + 1 || 1).padStart(4, '0') : '';
  const checkoutInfo = checkout ? filmInfo(checkout.offer.filmId) : undefined;
  const hero = filmInfo(featured) ?? sampleFilms[0];
  const heroRelease = releases.find((item) => item.film.filmId === hero.filmId);
  const heroPrice = filmPrices[hero.filmId] ?? hero.priceCkb;
  const screenNo = (filmId: string) => { const index = sampleFilms.findIndex((film) => film.filmId === filmId); return index < 0 ? releases.findIndex((r) => r.film.filmId === filmId) + 1 : index + 1; };
  const showTrailer = (filmId: string) => {
    setFeatured(filmId); setTrailer(filmId);
    document.getElementById('feature')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const buy = (release: FilmRelease) => void run(() => requestLicense(release));
  const buyBlocked = (price: number) => busy || !routeReady(price) || Boolean(checkout);
  const buyHint = (price: number) => (checkout ? 'Finish the current ticket first' : routeReady(price) ? '' : 'Open both channels in the projection room first');

  return <div className="page">
    <header className="top">
      <div className="wrap top-row">
        <a className="brand" href="#feature" aria-label="CKB Cinema, back to the feature">
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="12" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="13" cy="6.5" r="2.6" fill="currentColor" /><circle cx="13" cy="19.5" r="2.6" fill="currentColor" /><circle cx="6.5" cy="13" r="2.6" fill="currentColor" /><circle cx="19.5" cy="13" r="2.6" fill="currentColor" /><circle cx="13" cy="13" r="1.4" fill="var(--signal)" /></svg>
          <span className="wordmark">CKB Cinema</span>
        </a>
        <nav className="nav"><a href="#now">Now showing</a><a href="#how">How tickets work</a><a href="#booth">Projection room</a><a href="/litepaper">Litepaper</a></nav>
        <span className="mono small dim">Fiber Testnet · {openChannels}/2 channels open</span>
      </div>
    </header>

    <Intro />

    {(status || error) && <div className="ticker"><div className="wrap">
      {error ? <p className="mono error" role="alert">{error}</p> : <p className="mono" role="status">{status}</p>}
    </div></div>}

    {checkout ? <>
      <section className="theatre" id="checkout" aria-label="Screen">
        <div className="wrap">
          <div className="screen glow">
            {watchUrl
              ? <video src={watchUrl} controls autoPlay playsInline />
              : <>{checkoutInfo && <img src={checkoutInfo.backdrop} alt="" className="screen-still dimmed" />}
                <div className="screen-lock">
                  <p className="mono kicker">Screen {screenNo(checkout.offer.filmId)} · {payment?.status === 'Success' ? 'ticket paid' : 'house lights up'}</p>
                  <p className="screen-title">{checkout.release.film.title}</p>
                  <p className="mono small">{key ? 'Paid. Your key arrived with the payment.' : 'Locked until the payment settles.'}</p>
                  <div className="row center">
                    {!tested && <button className="btn" disabled={busy} onClick={() => void run(tryWithoutPaying)}>Try to play without paying</button>}
                    {canPay && <button className="btn solid big" disabled={busy} onClick={() => void run(pay)}>{attempt ? 'Retry failed payment' : `Pay ${checkout.offer.priceCkb} CKB`}</button>}
                    {attempt && !key && <button className="btn" disabled={busy} onClick={() => void run(checkPayment)}>Check payment status</button>}
                    {key && <button className="btn solid big" disabled={busy} onClick={() => void run(watch)}>Unlock &amp; watch</button>}
                  </div>
                </div></>}
          </div>
          <p className="mono small dim caption">{watchUrl ? `Screen ${screenNo(checkout.offer.filmId)} · playing from memory · ${formatBytes(checkout.release.film.size)} decrypted in this tab, nothing written to disk` : `The encrypted film (${formatBytes(checkout.ciphertext.length)}) is already here. Only the key is missing.`}</p>
        </div>
      </section>
      <div className="sprockets" aria-hidden="true" />
      <main className="wrap ticket-body">
        <aside className="ticket-side">
          <div className={`stub${payment?.status === 'Success' ? '' : ' unpaid'}`}>
            <div className="stub-main">
              <p className="mono stub-meta"><span>Admit one</span><span>Screen {screenNo(checkout.offer.filmId)}</span></p>
              <p className="stub-title">{checkout.release.film.title}</p>
              <p className="small stub-sub">Studio C{checkoutInfo ? ` · ${checkoutInfo.year}` : ''} · single viewing</p>
              <dl>
                <dt>Price</dt><dd className="mono">{ckb(ckbToShannons(checkout.offer.priceCkb))} CKB</dd>
                {payment?.status === 'Success' ? <>
                  <dt>Routing fee</dt><dd className="mono">{ckb(payment.fee)} CKB</dd>
                  <dt className="strong">Paid</dt><dd className="mono strong">{ckb(ckbToShannons(checkout.offer.priceCkb) + BigInt(payment.fee))} CKB</dd>
                </> : <><dt>Status</dt><dd className="mono">{payment?.status ?? (attempt ? 'submitted' : 'not paid')}</dd></>}
              </dl>
            </div>
            <div className="stub-tear"><span className="mono">No. {ticketNo} · keep</span></div>
          </div>
          <p className="mono small dim hash">Payment hash {checkout.offer.paymentHash}</p>
          {(!attempt || payment?.status === 'Success' || payment?.status === 'Failed') && <button className="btn" disabled={busy} onClick={closeCheckout}>{payment?.status === 'Success' ? 'Back to Now showing' : 'Cancel this ticket'}</button>}
          {(licenses[checkout.offer.filmId] ?? []).length > 1 && <p className="small dim">Encrypted once, ticketed {(licenses[checkout.offer.filmId] ?? []).length} times: each ticket had its own payment hash and opened the same encrypted file.</p>}
        </aside>
        <div className="ticket-main">
          <section>
            <h2 className="h-section">What your browser checked</h2>
            <p className="small dim">Before and after paying, nothing taken on trust.</p>
            <table className="ledger"><tbody>{checks.map((check, index) =>
              <tr key={check.what}><td className="mono small dim">{String(index + 1).padStart(2, '0')}</td><td>{check.what}</td><td className="mono small soft">{check.result}</td></tr>)}
            </tbody></table>
          </section>
          <section>
            <h2 className="h-section">Why Bottle B can’t keep your CKB</h2>
            <ol className="why">
              <li><span className="num">1</span><p>Your {checkout.offer.priceCkb} CKB plus fee is locked to Bottle under hash {short(checkout.offer.paymentHash, 6)}. Only the secret behind it unlocks it.</p></li>
              <li><span className="num">2</span><p>Bottle locks {checkout.offer.priceCkb} CKB to Studio C under the same hash.</p></li>
              <li><span className="num">3</span><p>The studio reveals the secret to get paid. That secret is your film key.</p></li>
              <li><span className="num">4</span><p>No secret, no payment: both locks expire and the CKB comes back to you.</p></li>
            </ol>
            <p className="small dim">Bottle sees the secret too, but never your ticket offer, which goes straight from studio to viewer. Without it the secret opens nothing.</p>
          </section>
          <details className="json"><summary className="mono small">Ticket offer JSON · sent from Studio C straight to Viewer A</summary>
            <pre>{offerJson}</pre>
            <button className="btn" onClick={() => void navigator.clipboard.writeText(offerJson).then(() => setStatus('Offer copied.'))}>Copy offer</button>
          </details>
        </div>
      </main>
    </> : <>
      <section className="feature" id="feature" aria-label="Feature presentation">
        <div className="feature-frame">
          {trailer === hero.filmId
            ? <video key={hero.filmId} src={hero.trailer} autoPlay controls playsInline onEnded={() => setTrailer('')} />
            : <>
              <img src={hero.backdrop} alt={`A still from ${hero.title}`} className="screen-still" />
              <div className="feature-scrim" />
              <div className="feature-copy"><div className="wrap"><div className="feature-text">
                <p className="mono kicker">Feature presentation · Screen {screenNo(hero.filmId)}</p>
                <h1>{hero.title}</h1>
                <p className="mono soft">{hero.year} · {hero.genre} · {hero.runtime} · Studio C</p>
                <p className="feature-synopsis">{hero.synopsis}</p>
                <div className="row">
                  {heroRelease
                    ? <button className="btn solid big" disabled={buyBlocked(heroPrice)} title={buyHint(heroPrice)} onClick={() => buy(heroRelease)}>Buy a ticket · {heroPrice} CKB</button>
                    : <span className="btn ghost-static big">Not printed yet</span>}
                  <button className="btn big glass" onClick={() => showTrailer(hero.filmId)}><svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><path d="M1 1l10 6-10 6z" fill="currentColor" /></svg>Watch the trailer, free</button>
                </div>
                {heroRelease && !routeReady(heroPrice) && <p className="mono small dim">Tickets open once both channels are ready in the <a href="#booth">projection room</a>.</p>}
              </div></div></div>
            </>}
        </div>
        {trailer === hero.filmId && <div className="wrap trailer-bar"><span className="mono small dim">Trailer · {hero.title}</span><button className="btn" onClick={() => setTrailer('')}>Close trailer</button></div>}
      </section>
      <div className="sprockets" aria-hidden="true" />

      <main className="wrap">
        <section className="block" id="now">
          <div className="block-head"><h2 className="h-big">Now showing</h2><p className="mono small dim">{releases.length || 'No'} {releases.length === 1 ? 'film' : 'films'} · one ticket per film · no subscription</p></div>
          {restoredOffer && <div className="notice">
            <p>A ticket from before the reload was found{attempt ? ', with a payment attempt' : ''}. Start Viewer A in the projection room, then restore it to check that payment instead of paying again.</p>
            <button className="btn" disabled={busy || !nodes.current.buyer || !releases.length} onClick={() => void run(restoreCheckout)}>Restore ticket</button>
          </div>}
          {!releases.length && <p className="dim">Nothing is showing yet. Print a film in the <a href="#booth">projection room</a> first.</p>}
          <div className="listings">{releases.map((release) => {
            const info = filmInfo(release.film.filmId);
            const price = filmPrices[release.film.filmId] ?? 1;
            return <article className="listing" key={release.film.filmId}>
              <div className="poster">
                {info ? <img src={info.poster} alt={`${info.title} poster`} /> : <div className="blank">{release.film.title}</div>}
                <span className="mono tag-screen">Screen {screenNo(release.film.filmId)}</span>
              </div>
              <div className="listing-title"><h3>{release.film.title}</h3><span className="mono">{price} CKB</span></div>
              <p className="mono small dim">{info ? `${info.year} · ${info.genre} · ${info.runtime}` : `${formatBytes(release.film.size)} · your upload`}</p>
              {info && <p className="soft small">{info.synopsis}</p>}
              <div className="listing-actions">
                {info && <button className="btn" onClick={() => showTrailer(release.film.filmId)}><svg width="10" height="12" viewBox="0 0 12 14" aria-hidden="true"><path d="M1 1l10 6-10 6z" fill="currentColor" /></svg>Trailer</button>}
                <button className="btn solid" disabled={buyBlocked(price)} title={buyHint(price)} onClick={() => buy(release)}>Buy a ticket · {price} CKB</button>
              </div>
            </article>;
          })}</div>
        </section>

        <section className="block" id="how">
          <h2 className="h-mid">How a ticket works</h2>
          <div className="steps3">
            <div><span className="num">01</span><h3>Watch the trailer</h3><p className="soft small">Free, no wallet needed. The full film sits on the CDN already, encrypted once for everyone.</p></div>
            <div><span className="num">02</span><h3>Pay for that film only</h3><p className="soft small">The studio writes you a ticket: a Fiber invoice for 1 to 5 CKB, paid through Bottle B in seconds.</p></div>
            <div><span className="num">03</span><h3>The payment is the key</h3><p className="soft small">Settling the payment reveals the secret that opens your ticket. Your browser decrypts the film and plays it.</p></div>
          </div>
        </section>
      </main>
    </>}

    <section className="wrap block booth-block" id="booth">
      <div className="block-head"><h2 className="h-mid">Projection room</h2><p className="mono small dim">For the operator: nodes, channels and film prints</p></div>

      <h3 className="label">Nodes · each opens one {String(channelFundingCkb)} CKB channel to Bottle B</h3>
      <div className="scroll">
        <table className="booth">
          <thead><tr><th>Node</th><th>Funding address</th><th>Channel</th><th className="w-balance">Balance (node / Bottle)</th><th aria-label="Actions" /></tr></thead>
          <tbody>{(['buyer', 'seller'] as const).map((role) => {
            const channel = channels[role];
            const isReady = Boolean(channel && ready(channel));
            const local = channel ? BigInt(channel.local_balance) : 0n;
            const remote = channel ? BigInt(channel.remote_balance) : 0n;
            const share = local + remote > 0n ? Number(local * 100n / (local + remote)) : 0;
            return <tr key={role}>
              <td className="strong">{role === 'buyer' ? 'A · Viewer' : 'C · Studio'}</td>
              <td className="mono small">{addresses[role] ? <span className="soft address">{addresses[role]}</span> : <span className="dim">not started</span>}</td>
              <td className={`mono small${channel && !isReady ? ' live' : ''}`}>{channel ? (isReady && !connected[role] ? 'CONNECTING_TO_BOTTLE' : channel.state.state_name) : addresses[role] ? <span className="dim">none · on-chain {balances[role] === undefined ? '…' : `${ckb(balances[role])} CKB`}</span> : '—'}</td>
              <td>{channel
                ? <><div className="meter"><i className={isReady ? '' : 'pending'} style={{ width: `${share}%` }} /></div><div className="meter-legend mono"><span>{ckb(local)}</span><span>{ckb(remote)}</span></div></>
                : <span className="dim small">{addresses[role] ? channelFundingGuidance : ''}</span>}</td>
              <td className="actions">
                {!addresses[role] && <button className="btn" disabled={!loaded || busy} onClick={() => void run(() => start(role))}>Start node</button>}
                {addresses[role] && !channel && <>
                  <a className="btn" href="https://faucet.nervos.org" target="_blank" rel="noreferrer">Faucet ↗</a>
                  <button className="btn" disabled={busy} onClick={() => void run(() => open(role))}>Open channel</button>
                </>}
                {channel && !(isReady && connected[role]) && <button className="btn" disabled={busy} onClick={() => void run(() => open(role))}>Reconnect</button>}
                {channel && isReady && connected[role] && <button className="btn" disabled={busy} onClick={() => void run(() => refresh(role))}>Check</button>}
              </td>
            </tr>;
          })}</tbody>
        </table>
      </div>

      <h3 className="label prints-label">Prints · one content key per film; masters come from <code>samples/films/</code> and are never served</h3>
      {sampleFilms.map((film) => {
        const release = releases.find((item) => item.film.filmId === film.filmId);
        const sold = (licenses[film.filmId] ?? []).length;
        return <div className="print-row" key={film.filmId}>
          <img src={film.poster} alt="" width={36} height={54} />
          <div className="print-title">
            <h4>{film.title}</h4>
            <p className="mono small dim">{release ? `${formatBytes(release.ciphertextSize)} encrypted · ${sold} ${sold === 1 ? 'ticket' : 'tickets'} issued` : 'not printed yet'}</p>
          </div>
          <label className="file mono small">
            <span>{masters[film.filmId] ? `✓ ${masters[film.filmId].name}` : 'Choose master file'}</span>
            <input type="file" accept="video/webm" aria-label={`Master file for ${film.title}`} onChange={(event) => { const file = event.target.files?.[0]; if (file) setMasters((previous) => ({ ...previous, [film.filmId]: file })); }} />
          </label>
          <div className="segmented" role="group" aria-label={`Ticket price for ${film.title}`}>{prices.map((price) =>
            <button key={price} aria-pressed={filmPrices[film.filmId] === price} disabled={busy} onClick={() => setFilmPrices((previous) => ({ ...previous, [film.filmId]: price }))}>{price}</button>)}
          </div>
          <button className="btn" disabled={busy || !loaded || !masters[film.filmId]} title={release ? 'Encrypts again with a new content key; tickets issued earlier stop working' : ''} onClick={() => void run(() => publishSample(film))}>{release ? 'Re-print' : 'Encrypt & print'}</button>
        </div>;
      })}
      <details className="own">
        <summary>Print your own video</summary>
        <div className="own-row">
          <label className="field"><span className="label">Title</span><input type="text" value={customTitle} maxLength={80} onChange={(event) => setCustomTitle(event.target.value)} /></label>
          <label className="file mono small"><span>{customFile ? `✓ ${customFile.name}` : `Choose a video (max ${maxFilmBytes / 1024 / 1024} MB)`}</span>
            <input type="file" accept="video/*" aria-label="Your video" onChange={(event) => setCustomFile(event.target.files?.[0] ?? null)} /></label>
          <button className="btn" disabled={busy || !customFile} onClick={() => void run(publishCustom)}>Encrypt & print</button>
        </div>
      </details>
    </section>

    <footer className="foot"><div className="wrap foot-row mono small dim">
      <span>CKB Testnet only. Films are generated for this demo.</span>
      <a href="https://www.fiber.world/docs/build/encrypted-data-payment" target="_blank" rel="noreferrer">Built from the Fiber starter</a>
    </div></footer>
  </div>;
}
