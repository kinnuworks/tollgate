# Tollgate

Pay for AI by the token in USDC on Solana. Stop paying and the answer stops. Whatever you don't use never leaves your wallet.

Why Solana: paying a fraction of a cent per answer only works if settling costs less than the answer. On Solana the whole session settles in one transaction in about a second, for well under a cent.

**Live demo (devnet):** https://tollgate-production-6271.up.railway.app

## Try it in 30 seconds

1. Open the link. The page opens a session for you on Solana devnet: a fresh wallet gets $0.25 of test USDC, and the AI provider is approved on-chain to take at most that.
2. Click **Ask**. The answer streams in while the tab signs a payment voucher every 50 tokens. The meter shows what you've paid so far.
3. Untick **Keep paying** while it's answering. The text stops with "Waiting for payment…". Tick it again and it carries on.
4. Click **Provider tries to take $0.30**. The token program refuses it on-chain, and you get the failed transaction's link.
5. Click **Settle**. One transaction moves exactly the amount you signed for to the provider and removes the provider's permission. The rest never left your wallet. You get explorer links for every step.

## How it works

```
browser tab                         gateway (Node)                      Solana devnet
-----------                         --------------                      -------------
makes its own ed25519 key  ───────► open: fund payer with test USDC ──► mint + approve(provider, cap $0.25)
                                    stream AI answer, 50 tokens
◄── "pay up to N tokens"            at a time; waits for a voucher
signs voucher (amount, expiry) ───► checks the signature against the
                                    tab's key, releases the next block
                                    settle: pull the signed total  ───► transferChecked + revoke, one tx
```

- **Vouchers.** Each voucher is the 50-byte format used by the Solana Foundation's payment channels (`0x56 0x01 · channel id · cumulative amount u64 · expiry i64`), signed with the tab's own ed25519 key. The gateway won't stream past what the latest voucher covers.
- **On-chain cap.** At open, the payer approves the provider as an SPL token delegate for the deposit, $0.25. The provider can't take more than that. The "take $0.30" button proves it with a real failed transaction.
- **Settle.** One transaction transfers the last signed total to the provider and revokes the approval.
- **Price.** $2 per million tokens (2 base units of 6-decimal USDC per token).

## What is real and what isn't

- Every transaction is real and on Solana devnet. The USDC is a test token this project minted on devnet ("test USDC", 6 decimals). It is not Circle's USDC.
- In the demo, the server funds the payer wallet and holds its key so you don't need a wallet. The voucher key is generated in your browser tab and never leaves it.
- The token count during streaming is an estimate (about 4 characters per token). The model's own count is shown when the answer ends.
- The voucher limit is enforced by the gateway. The chain enforces the $0.25 cap and the final transfer. A dishonest provider could pull up to the cap, not more. Settling against a signed voucher on-chain is the job of the Solana Foundation's payment-channels program. We opened and settled channels on it on devnet. Its payout step failed against devnet's treasury account, so the demo uses token delegation instead.
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
