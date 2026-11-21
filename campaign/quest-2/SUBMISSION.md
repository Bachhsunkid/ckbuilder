# Quest 2 (Advanced) submission: CKB Cinema

Build on CKB Campaign #8 · Unlock Encrypted Data with a Fiber Payment

## Links

| What | Link |
| --- | --- |
| GitHub repository (README) | https://github.com/Bachhsunkid/ckbuilder/tree/main/campaign/quest-2/ckb-cinema |
| Live demo (CKB Testnet) | https://ckb-cinema.vercel.app/ |
| Litepaper | https://ckb-cinema.vercel.app/litepaper |
| Demo screenshots (encrypted offer → payment → unlock) | https://github.com/Bachhsunkid/ckbuilder/tree/main/campaign/quest-2/ckb-cinema/docs/demo |
| Basic screenshots and reflection | https://github.com/Bachhsunkid/ckbuilder/tree/main/campaign/quest-2/ckb-cinema/docs/quest-1 |

## What I built

**CKB Cinema** is a pay-per-view film site on Fiber Testnet. Viewers watch any
trailer for free and pay 1 to 5 CKB to unlock one full film. There is no
subscription and no account. The Fiber payment itself delivers the key: the
studio can only claim the payment by revealing the preimage, and the preimage
is what unlocks the film.

The use case is the one I proposed in my Basic reflection: occasional viewers,
for whom pay-as-you-go makes more sense than a monthly subscription.

## Full flow shown in the demo

Nine screenshots of one 2 CKB purchase of *Neon Tide* (payment hash
`0x541de717…d31f43`) are in `docs/demo`.

1. **Seller creates an encrypted offer.** Studio C encrypts the film once with a
   random content key (AES-256-GCM) and publishes the ciphertext. When a viewer
   buys, the studio creates a fresh preimage, uses it as the preimage of a Fiber
   invoice for the film's price, and wraps the content key with it. The ticket
   (invoice, payment hash, wrapped key) goes to the viewer.
2. **Buyer checks and tries to cheat.** The viewer's browser checks the film
   fingerprint, the invoice network, amount and hash, and the ciphertext hash.
   *Try to play without paying* is rejected.
3. **Buyer pays a Fiber Testnet invoice** through Bottle B.
4. **The revealed key unlocks the content.** The browser checks
   `SHA-256(preimage) == payment hash`, unwraps the content key, decrypts the
   film, checks its fingerprint and plays it.

## What I changed from the starter

- **New use case:** a film catalog with free trailers and in-browser playback
  instead of one text result.
- **Envelope encryption:** a film is encrypted once and sold many times. Each
  purchase gets its own preimage that wraps the same content key, so the large
  file is never re-encrypted per buyer and the offer stays a few hundred bytes.
- **Binding and integrity:** the film description is the GCM additional data;
  each ticket is bound to film, film hash, price and payment hash. Masters,
  ciphertext and the decrypted film are all checked by SHA-256.
- **Pricing:** the studio picks 1, 2, 3 or 5 CKB, and the buyer rejects an
  invoice that does not ask exactly the listed price.
- **Extra key check:** `SHA-256(preimage) == payment hash` before the key is used.
- **Reliability:** channel opening retries the "waiting for peer Init" race;
  status polls while funds and channels are pending.
- **UI:** a cinema front of house (feature screen, poster listings, paper ticket
  stub, a numbered ledger of every check, a "Why Bottle B can't keep your CKB"
  explainer), a step-by-step first-visit guide, and an on-site litepaper.
- **Tests:** 18 (9 starter payment tests, plus price mismatch, envelope,
  binding, tamper and release-parsing tests).
- **Media:** films, trailers and posters are procedurally generated, so there
  are no copyright issues.

The starter's payment safety logic (never resend a payment whose outcome is
unknown, restore checkout after reload) is unchanged.

## How to run

```sh
cd campaign/quest-2/ckb-cinema
npm install
npm run dev   # http://localhost:3001
```

Then, in the **Projection room**: start Viewer A and Studio C, fund both from
the Testnet faucet, open both channels to Bottle B, and print a film from
`samples/films/`. Full steps are in the README.

## Basic quest

Screenshots (setup, before payment, after payment, after decryption) and my
reflection are in
[docs/quest-1](https://github.com/Bachhsunkid/ckbuilder/tree/main/campaign/quest-2/ckb-cinema/docs/quest-1).
