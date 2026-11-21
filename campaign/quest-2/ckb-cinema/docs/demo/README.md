# Demo: one purchase, from encrypted offer to unlock

Screenshots of one purchase of *Neon Tide* (2 CKB) on CKB Testnet, taken in
order on `localhost`. Steps 04 to 09 belong to the same ticket, with payment hash
`0x541de717a4870b4433d418ac33f1137759dfba9a08e4b3546018c5dc96d31f43`.

| # | Step | Screenshot |
| --- | --- | --- |
| 01 | Setup: Viewer A and Studio C each have a channel to Bottle B in `CHANNEL_READY`; the three films are printed (encrypted once, ciphertext on the CDN) | [01](01-network-both-channels-ready.jpg) |
| 02 | Front of house: the feature screen, with a free trailer and the ticket price | [02](02-feature-free-trailer.jpg) |
| 03 | Now showing: each film has a free trailer and its own price | [03](03-now-showing-listings.jpg) |
| 04 | **Encrypted offer.** Studio C issues a ticket (Fiber invoice for 2 CKB, wrapped film key). The browser checks the release fingerprint, the invoice network and amount, and the ciphertext hash | [04](04-encrypted-offer-received-checks.jpg) |
| 05 | The ticket offer JSON sent straight from Studio C to Viewer A: `film-license` v3, film hash, price, wrapped key, invoice | [05](05-encrypted-offer-json.jpg) |
| 06 | **Before payment:** *Try to play without paying*. A guessed key is rejected and the film stays locked | [06](06-play-without-paying-rejected.jpg) |
| 07 | **Payment.** Paid 2 CKB plus a 0.002 CKB routing fee through Bottle B. `SHA-256(revealed key) == payment hash` | [07](07-payment-settled-key-revealed.jpg) |
| 08 | **Unlock.** The revealed key unwraps the film key; the film is decrypted in the tab, its SHA-256 matches, and it plays from memory | [08](08-unlocked-film-playing.jpg) |
| 09 | All six checks on the ticket, and why Bottle B cannot keep the CKB, using this payment's hash | [09](09-all-checks-and-bottle-explainer.jpg) |

![Setup](01-network-both-channels-ready.jpg)
![Feature](02-feature-free-trailer.jpg)
![Now showing](03-now-showing-listings.jpg)
![Encrypted offer](04-encrypted-offer-received-checks.jpg)
![Offer JSON](05-encrypted-offer-json.jpg)
![Play without paying](06-play-without-paying-rejected.jpg)
![Payment settled](07-payment-settled-key-revealed.jpg)
![Film playing](08-unlocked-film-playing.jpg)
![All checks](09-all-checks-and-bottle-explainer.jpg)
