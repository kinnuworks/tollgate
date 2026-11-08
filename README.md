# Tollgate

Pay for AI by the token in USDC on Solana. Stop paying and the answer stops. Whatever you don't use never leaves your wallet.

Why Solana: paying a fraction of a cent per answer only works if settling costs less than the answer. On Solana the whole session settles in one transaction in about a second, for well under a cent.

**Live demo (devnet):** https://tollgate-production-6271.up.railway.app

| Stop paying: the answer waits | Settle: paid for 350 tokens, the rest never left the wallet |
|---|---|
| ![Answer paused while unpaid](docs/paused.jpg) | ![Settled with explorer links](docs/settled.jpg) |

## Try it in 30 seconds

Open the link and press **Run the 20-second demo**. It does the steps below on its own, with an explorer link for each one. To do it by hand:

1. Open the link. The page opens a session for you on Solana devnet: a fresh wallet gets $0.50 of test USDC, and the AI provider is approved on-chain to take at most $0.25 of it.
2. Click **Ask**. The answer streams in while the tab signs a payment voucher every 50 tokens. The meter shows what you've paid so far.
3. Untick **Keep paying** while it's answering. The text stops with "Waiting for payment…". Tick it again and it carries on.
4. Click **Provider tries to take $0.30**. The token program refuses it on-chain, and you get the failed transaction's link.
5. Click **Settle**. One transaction moves exactly the amount you signed for to the provider and removes the provider's permission. The rest never left your wallet. You get explorer links for every step.

## How it works

```
browser tab                         gateway (Node)                      Solana devnet
-----------                         --------------                      -------------
makes its own wallet key   ───────► open: tab signs approve          ──► mint $0.50 + approve(provider, cap $0.25)
                                    stream AI answer, 50 tokens
◄── "pay up to N tokens"            at a time; waits for a voucher
signs voucher (amount, expiry) ───► checks the signature against the
                                    tab's key, releases the next block
                                    settle: tab signs revoke        ───► transferChecked + revoke, one tx
```

- **Vouchers.** Each voucher is the 50-byte format used by the Solana Foundation's payment channels (`0x56 0x01 · channel id · cumulative amount u64 · expiry i64`), signed with the tab's own ed25519 key. The gateway won't stream past what the latest voucher covers.
- **On-chain cap.** At open, a fresh wallet gets $0.50 of test USDC and approves the provider as an SPL token delegate for $0.25. The provider can't take more than that. The "take $0.30" button proves it with a real failed transaction.
- **Settle.** One transaction transfers the last signed total to the provider and revokes the approval.
- **Price.** $2 per million tokens (2 base units of 6-decimal USDC per token).

## What is real and what isn't

- Every transaction is real and on Solana devnet. The USDC is a test token this project minted on devnet ("test USDC", 6 decimals). It is not Circle's USDC.
- Your browser tab makes its own wallet. Its key never leaves the tab, and it signs the on-chain approval, every voucher and the revoke at settle. The server only pays network fees and mints test USDC into the wallet, so you don't need a wallet extension.
- The token count during streaming is an estimate (about 4 characters per token). The model's own count is shown under the answer when it ends. You pay in 50-token blocks.
- The voucher limit is enforced by the gateway. The chain enforces the $0.25 cap (the demo wallet holds $0.50, so the refused $0.30 pull fails because of the cap, not the balance) and the final transfer. A dishonest provider could pull up to the cap, not more.
- Settling against a signed voucher on-chain is the job of the Solana Foundation's payment-channels program. We opened a channel on it on devnet with this same voucher format ([open transaction](https://explorer.solana.com/tx/5NtC5ZKkgZqm4gMSPJFh9cGHACmUeKDLKiKuW2NJ1qaReur1KZ3EDREZktxcV1MGcz6KNx2AmGS39nsr3QSrzhgx?cluster=devnet)). Its settle-and-payout transaction failed on devnet's treasury account check (`TreasuryAccountMismatch`), so the demo moves money with SPL token delegation instead.
- One provider (this project) and one model.

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
