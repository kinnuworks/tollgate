# Tollgate

Pay for AI by the token in USDC on Solana. Stop paying and the answer stops. Whatever you don't use never leaves your wallet.

Why Solana: paying a fraction of a cent per answer only works if settling costs less than the answer. On Solana the whole session settles in one transaction in about a second, for well under a cent, and a small on-chain program checks the signed voucher before any money moves.

**Live demo (devnet):** https://tollgate-production-6271.up.railway.app

| Stop paying: the answer waits | Settle: paid for 350 tokens, the rest never left the wallet |
|---|---|
| ![Answer paused while unpaid](docs/paused.jpg) | ![Settled with explorer links](docs/settled.jpg) |

## Try it in 30 seconds

Open the link and press **Run the 20-second demo**. It does the steps below on its own, with an explorer link for each one. To do it by hand:

1. Open the link. The page opens a session for you on Solana devnet: a fresh wallet gets $0.50 of test USDC and approves the Tollgate program to spend at most $0.25 of it.
2. Click **Ask**. The answer streams in while the tab signs a payment voucher every 50 tokens. The meter shows what you've paid so far.
3. Untick **Keep paying** while it's answering. The text stops with "Waiting for payment…". Tick it again and it carries on.
4. Click **Provider tries $0.30**. Your tab co-signs a $0.30 settle, and the Tollgate program still refuses it on-chain (error 1: above your signed voucher). You get the failed transaction's link.
5. Click **Settle**. One transaction checks your voucher on-chain, pays the provider exactly the signed amount and revokes the approval. The rest never left your wallet. You get explorer links for every step.

## Pay from your own agent (SDK)

[`sdk/tollgate.mjs`](sdk/tollgate.mjs) lets any program or AI agent buy an answer per token with its own Solana key. The key never leaves the agent: it signs the approval, one voucher per 50 tokens, and the revoke. Every transaction the provider builds is decoded and checked before it is signed.

```js
import { TollgateClient } from './sdk/tollgate.mjs';
const tg = new TollgateClient('https://tollgate-production-6271.up.railway.app');
await tg.open('haiku');                                   // or 'sonnet'
const { text } = await tg.ask('List three uses of payment channels.', {
  shouldPay: (soFar, nextUnits) => nextUnits <= 5_000n,   // the agent's own budget rule
});
const receipt = await tg.settle();                        // { paid, sig, ms, explorer }
```

`node sdk/agent-example.mjs` runs this against the live site. A recent run paid 300 units and settled in 836 ms ([transaction](https://explorer.solana.com/tx/3joF7XUhNYkr4DVxSpvMUd2fJmk84Fx9aEceviJY5CPs2P2pp9FCdcroapzRzofPizzc3aN6uh7kY8cReHgrtDZh?cluster=devnet)).

## Any provider can sell through Tollgate

The program has no built-in provider. Each provider gets its own delegate PDA, derived from its wallet (`["tollgate", provider wallet]`), so a payer's approval can only ever pay the provider it chose. The live site has two: Claude Haiku at $2 per million tokens and Claude Sonnet at $6 per million, each paid to its own wallet.

## Agent mode

Press **Let an AI agent buy an answer**. The tab's wallet now belongs to a buying agent with a task ("learn what a payment channel is; one clear sentence is enough"). Before signing each next voucher, the agent (Claude Haiku) reads the answer so far and decides whether it already has what the task needs. When it does, it stops paying, the stream halts, and it settles on its own. In our test run it bought 50 tokens of a roughly 400-token answer and paid $0.000100. The page shows each of the agent's decisions and its reason.

## How it works

```
browser tab                         gateway (Node)                      Solana devnet
-----------                         --------------                      -------------
makes its own wallet key   ───────► open: tab signs approve          ──► mint $0.50 + approve(Tollgate PDA, cap $0.25)
                                    stream AI answer, 50 tokens
◄── "pay up to N tokens"            at a time; waits for a voucher
signs voucher (amount, expiry) ───► checks the signature, releases
                                    the next block
                                    settle: tab signs revoke        ───► ed25519 verify(voucher)
                                                                         tollgate.settle(amount ≤ signed)
                                                                         revoke
```

- **Vouchers.** Each voucher is the 50-byte format the Solana Foundation's payment channels use (`0x56 0x01 · channel id · cumulative amount u64 · expiry i64`). The tab signs it with its own ed25519 key. The gateway won't stream past what the latest voucher covers.
- **Tollgate program** ([`program/src/lib.rs`](program/src/lib.rs), devnet [`58S2R4oQRDYts3qXK6PYwq9SwZg1oPnLGvYRdbxpFNWj`](https://explorer.solana.com/address/58S2R4oQRDYts3qXK6PYwq9SwZg1oPnLGvYRdbxpFNWj?cluster=devnet)). A 20 KB Pinocchio program with one instruction, `settle`. It reads the instructions sysvar, finds the Ed25519 check of a voucher signed by this payer for this payer's channel, and pays the provider at most the signed amount from the payer's token account, signing as its PDA. It refuses a settle the payer didn't sign (error 6, so nobody holding a voucher can replay it), a different payer, a different provider, a missing voucher, or an amount above the voucher (error 1). It also refuses an expired voucher (error 7). It keeps no record of past payouts; the payer's signature on each settle and the revoke in the same transaction cover that. Unit tests for the voucher parser: `cd program && cargo test` (6 pass).
- **Your tab checks before it signs.** The page decodes every transaction the server builds before the tab signs it: the approval must go only to the Tollgate program and be at most $0.25, and a settle must ask for no more than the tab's last voucher. It shows what it checked.
- **On-chain cap.** At open, the tab's wallet approves the program's PDA (not the provider) as a token delegate for $0.25, so the total can never pass that either.
- **Settle.** One transaction: Ed25519 verify, `tollgate.settle`, and the tab's revoke.
- **Price.** $2 per million tokens (2 base units of 6-decimal USDC per token), paid in 50-token blocks.

## What is real and what isn't

- Every transaction is real and on Solana devnet. Sessions are funded with Circle's devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) while the operator's faucet balance lasts, and with a test token this project minted (6 decimals) after that. The app says which one your session got. The Tollgate program works with either mint.
- Your browser tab makes its own wallet. Its key never leaves the tab, and it signs the on-chain approval, every voucher and the revoke at settle. The server only pays network fees and mints test USDC into the wallet, so you don't need a wallet extension. The key lives in page memory, so a reload starts a new wallet.
- The token count during streaming is an estimate (about 4 characters per token). When the answer ends, the tab signs one last voucher that tops the total up to the model's own count (rounded up to the 50-token block), so you never pay for less than the model produced.
- The gateway decides when to stop streaming; the chain decides how much can be paid. The settle amount is checked on-chain against the signed voucher.
- We first tried the Solana Foundation's payment-channels program on devnet and opened a channel on it ([open transaction](https://explorer.solana.com/tx/5NtC5ZKkgZqm4gMSPJFh9cGHACmUeKDLKiKuW2NJ1qaReur1KZ3EDREZktxcV1MGcz6KNx2AmGS39nsr3QSrzhgx?cluster=devnet)). Its payout step failed on devnet's treasury account check (`TreasuryAccountMismatch`), so we wrote the small settle program above instead, keeping the same voucher format.
- Two providers, both run by this project for the demo (Claude Haiku and Claude Sonnet, separate wallets).

## Tests

`node app/e2e.mjs <server url>` runs a full session against a live server on devnet. It opens a wallet, streams an answer while signing vouchers, stops paying for 3 seconds, and resumes. It then checks three things:

- the text held while no voucher was signed
- a $0.30 settle co-signed by the tab fails at the Tollgate program with error 1
- the real settle pays exactly the last signed amount

All three pass against the live site.

## Run it locally

```bash
cd app
npm install --legacy-peer-deps
mkdir -p keys && solana-keygen new -s --no-bip39-passphrase -o keys/operator.json && solana-keygen new -s --no-bip39-passphrase -o keys/payee.json
# fund keys/operator.json with devnet SOL, create a 6-decimal mint with it as mint authority, then:
echo "ANTHROPIC_API_KEY=..." > .env && echo "MINT=<your mint>" >> .env
npm start   # http://localhost:3000
```

Built for the MLH × Solana Hackathon, November 2026.
