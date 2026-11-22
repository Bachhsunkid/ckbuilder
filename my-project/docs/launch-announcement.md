# Launch announcement (draft)

Site: https://ckb-mines.vercel.app. Short version for Discord / Telegram / X, long version for Nervos Talk.

## Short

> **CKB Mines is open for playtesting on testnet** 💣
>
> A 3×3 mines game where the operator can't rig the board or keep your winnings.
> Deposit once, play instant rounds with no wallet popup, withdraw any time. If the operator disappears, the page closes the session alone with the states you both signed.
>
> ▶️ Play: https://ckb-mines.vercel.app
> 📖 How to play: https://github.com/Bachhsunkid/ckbuilder/blob/main/my-project/docs/PLAY.md
>
> Testnet CKB only (free from the faucet). Bug reports and UX feedback very welcome; include your session number.

## Long

**CKB Mines: a provably fair mines game on a state channel in one cell**

I built CKB Mines during CKBuilders and it is now open for anyone to try on testnet: https://ckb-mines.vercel.app

**How it plays**
- Connect a wallet (JoyID works in the browser), get testnet CKB from the faucet.
- Open a session with one signature. The operator locks enough CKB to cover your best possible win.
- Play rounds instantly: pick Easy, Medium or Hard, open tiles, bank whenever you like. No wallet popup per round.
- Withdraw in one transaction whenever you want.

**Why you don't have to trust the operator**
- The operator commits to each board before it sees your seed. After every round your browser runs five checks; the Verify tab lets anyone re-check a game.
- Your deposit and the operator's collateral sit in one session cell. Every round is a new state both sides sign.
- If the operator stops answering, you post your latest signed state on chain. After the challenge window (1 hour in this playtest) the lock script pays you what that state says. Posting an old state does not pay: the other side answers with the newer one.
- The CKB-specific parts: the cell model holds both sides' money under one lock script, and a relative `since` timelock runs the challenge window with no keeper bot.

**What I'd love feedback on**
- Anything confusing in the first five minutes: wallet, faucet, opening a session.
- Wallets other than JoyID: does the deposit sign and land?
- Phone experience.

Code, protocol and ADRs: https://github.com/Bachhsunkid/ckbuilder/tree/main/my-project

Testnet only. The CKB involved has no value.
