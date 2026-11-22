# How to play CKB Mines (testnet)

CKB Mines is a 3×3 mines game on the CKB **testnet**. The CKB you play with is free and has no value.

## 1. Get a wallet and testnet CKB

1. Open the site and press **Connect wallet**. [JoyID](https://joy.id) works in the browser with a passkey (Face ID, Touch ID or a security key), nothing to install. Other CKB wallets in the list work too.
2. Open the wallet menu (your address, top right), press **Copy address**, and paste it into the [Nervos testnet faucet](https://faucet.nervos.org).
3. Wait for the faucet transaction. Your balance in the header updates by itself. A 150 CKB session needs about 212 CKB in the wallet (deposit, 61 CKB change, fee).

## 2. Open a session

- Pick a **deposit** (what you bring to the table) and a **max bet** (the largest stake for one round).
- The operator locks enough CKB to pay your best possible win at that max bet.
- Press **Open session** and sign once in your wallet. The deposit lands in about 30–60 s.

## 3. Play rounds

- Choose a difficulty: Easy (2 mines), Medium (3), Hard (4).
- Choose a stake and press **Start round**. Open tiles one by one; every safe tile raises the multiplier.
- **Bank** whenever you like, or hit a mine and lose the stake. Rounds are instant and need no wallet popup.
- The operator keeps 5% of your profit on a win. No cash-out strategy beats the game: you only choose how much risk to take.
- After each round, five checks run in your browser: the layout was fixed before your seed existed, it has the right number of mines, your picks match, the receipts are valid, and the payout follows the rules.

## 4. Withdraw

- Press **Withdraw** any time between rounds. Your balance comes back to your wallet in one transaction.
- If you stop playing, the operator closes the session for you after 15 minutes of inactivity and pays your balance.
- If the operator stops answering, the page offers **Close alone**: it posts your latest signed state on chain and collects after the challenge window (1 hour in this playtest).

## Good to know

- Your session key and signed states live in this browser. Use the same browser to resume a session; **Download session backup** keeps a copy.
- One live session per wallet.
- If all tables are taken, try again in a minute: each session reserves operator capacity.
- Found a bug or something confusing? Please report it with the session number (shown as "No. xxxxxxxx").
