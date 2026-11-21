import Link from 'next/link';

export const metadata = {
  title: 'Litepaper · CKB Cinema',
  description: 'Pay per film, keyed by the payment: how CKB Cinema uses Fiber to trade a film key for a payment in one step.',
};

const flow: { from: string; to: string; what: string }[] = [
  { from: 'Studio', to: 'CDN', what: 'Encrypted film, once' },
  { from: 'Viewer', to: 'Studio', what: 'Buy one film' },
  { from: 'Studio', to: 'Viewer', what: 'Ticket: invoice H = SHA-256(P), content key wrapped with P' },
  { from: 'Viewer', to: 'Bottle B', what: 'Pay, locked to H' },
  { from: 'Bottle B', to: 'Studio', what: 'Forward, locked to H' },
  { from: 'Studio', to: 'Bottle B', what: 'Reveal P to get paid' },
  { from: 'Bottle B', to: 'Viewer', what: 'P arrives, payment settles' },
  { from: 'Viewer', to: 'Viewer', what: 'Unwrap key, decrypt, play' },
];

export default function Litepaper() {
  return <div className="page">
    <header className="top">
      <div className="wrap top-row">
        <Link className="brand" href="/" aria-label="CKB Cinema home">
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="12" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="13" cy="6.5" r="2.6" fill="currentColor" /><circle cx="13" cy="19.5" r="2.6" fill="currentColor" /><circle cx="6.5" cy="13" r="2.6" fill="currentColor" /><circle cx="19.5" cy="13" r="2.6" fill="currentColor" /><circle cx="13" cy="13" r="1.4" fill="var(--signal)" /></svg>
          <span className="wordmark">CKB Cinema</span>
        </Link>
        <nav className="nav"><Link href="/">Now showing</Link><Link href="/litepaper" aria-current="page">Litepaper</Link></nav>
        <span className="mono small dim">Build on CKB · Campaign #8</span>
      </div>
    </header>
    <div className="sprockets" aria-hidden="true" />

    <main className="wrap paper">
      <p className="mono kicker">Litepaper · CKB Testnet demo</p>
      <h1 className="paper-title">Pay per film,<br />keyed by the payment</h1>

      <section>
        <h2 className="h-section">Problem</h2>
        <p>People who watch a few films a year are badly served. A monthly subscription charges them for months they don’t use. Buying one title by card costs more in fees and friction than a 1 to 5 CKB rental is worth. And every pay-then-receive model asks the buyer to trust the seller to deliver after the money has gone.</p>
      </section>

      <section>
        <h2 className="h-section">Idea</h2>
        <p className="paper-lead">Watch the trailer for free. Pay for one film only. <strong>The payment itself is the key</strong>: settling it is what hands the viewer the secret that unlocks the film, so money and key change hands in the same step.</p>
      </section>

      <section>
        <h2 className="h-section">How it works</h2>
        <ol className="paper-steps">
          <li><span className="num">1</span><div><h3>Encrypt once</h3><p>The studio encrypts each film with its own random content key (AES-256-GCM) and publishes the ciphertext on a public CDN, with a release record of fingerprints. Anyone can download it; nobody can watch it.</p></div></li>
          <li><span className="num">2</span><div><h3>Issue a ticket per purchase</h3><p>When a viewer buys, the studio creates a fresh 32-byte secret and uses it twice: as the <strong>preimage of a Fiber invoice</strong> for the film’s price, and as the key that <strong>wraps the content key</strong>. The ticket (invoice, payment hash, wrapped key) is a few hundred bytes and goes straight to the viewer.</p></div></li>
          <li><span className="num">3</span><div><h3>Verify, then pay</h3><p>The viewer’s browser checks the film against the catalog fingerprint, the invoice’s network, amount and hash, and the downloaded ciphertext’s hash. It then pays over Fiber (viewer → Bottle B → studio) in seconds, without an on-chain transaction.</p></div></li>
          <li><span className="num">4</span><div><h3>Unlock</h3><p>To be paid, the studio’s node must reveal the preimage, and Fiber returns it to the viewer. The browser checks <code>SHA-256(preimage) = payment hash</code>, unwraps the content key, decrypts the film, checks its fingerprint and plays it from memory.</p></div></li>
        </ol>

        <figure className="flow" aria-labelledby="flow-caption">
          <figcaption id="flow-caption" className="label">One purchase, message by message</figcaption>
          <ol>{flow.map((step, index) =>
            <li key={step.what}>
              <span className="mono dim">{String(index + 1).padStart(2, '0')}</span>
              <span className="flow-hop mono"><b>{step.from}</b><i aria-hidden="true">{step.from === step.to ? '↺' : '→'}</i><b>{step.to}</b></span>
              <span>{step.what}</span>
            </li>)}
          </ol>
        </figure>
      </section>

      <section>
        <h2 className="h-section">Why it can be trusted</h2>
        <ul className="paper-list">
          <li><strong>The studio</strong> cannot take the money without revealing the key: claiming the payment <em>is</em> revealing it.</li>
          <li><strong>The viewer</strong> cannot get the key without paying: the wrapped key opens only with the preimage, which only a settled payment reveals.</li>
          <li><strong>Bottle B</strong>, the routing node, cannot keep the money: its incoming payment is locked to the same hash, so it is paid only after the studio reveals the secret. If the secret never appears, both locks expire and the viewer is refunded. Bottle never sees the ticket, so the secret alone opens nothing.</li>
        </ul>
      </section>

      <section>
        <h2 className="h-section">Why envelope encryption</h2>
        <p>A per-buyer key would mean re-encrypting and re-uploading a whole film for every sale. Here a film is encrypted once and sold many times; each sale only adds a ticket with its own payment hash. Every ticket is bound to its film, price and payment hash, so it cannot be reused for another film or another price.</p>
      </section>

      <section>
        <h2 className="h-section">What the demo shows</h2>
        <p>A working Next.js app on CKB Testnet, built from the Fiber starter: two browser Fiber nodes, three generated short films with free trailers, tickets at 1 to 5 CKB, a checkout that lists every check, and a second purchase of the same film opening the same encrypted file with a different payment hash.</p>
      </section>

      <section>
        <h2 className="h-section">Limits</h2>
        <ul className="paper-list">
          <li><strong>Not DRM.</strong> A viewer who has paid can share the key or the decrypted film. Payment guarantees delivery of the key, not protection against copying.</li>
          <li><strong>One browser, both roles.</strong> In production the studio runs its own node and keeps content keys off the viewer’s machine.</li>
          <li><strong>Testnet only.</strong> Liquidity, invoice expiry (one hour) and routing fees follow Fiber Testnet today.</li>
        </ul>
      </section>

      <section>
        <h2 className="h-section">Next steps</h2>
        <p>Studio-side server for keys and ticket issuing; streaming decryption in chunks for full-length films; previews and reviews so buyers can judge a film before paying; stablecoin pricing over Fiber.</p>
      </section>

      <p className="paper-cta"><Link className="btn solid big" href="/">Go to Now showing</Link></p>
    </main>

    <footer className="foot"><div className="wrap foot-row mono small dim">
      <span>CKB Testnet only. Films are generated for this demo.</span>
      <a href="https://www.fiber.world/docs/build/encrypted-data-payment" target="_blank" rel="noreferrer">Built from the Fiber starter</a>
    </div></footer>
  </div>;
}
