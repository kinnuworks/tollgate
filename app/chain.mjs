// Solana side of Tollgate.
// open:   fund a fresh payer with test USDC and approve the provider as a
//         delegate for at most the deposit (the on-chain spending cap).
// settle: the provider pulls exactly the last signed voucher amount, and the
//         approval is revoked in the same transaction. The rest never leaves
//         the payer's account.
import fs from 'node:fs';
import {
  address, createSolanaRpc, createKeyPairSignerFromBytes, generateKeyPairSigner,
  pipe, createTransactionMessage, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions,
  signTransactionMessageWithSigners, getBase64EncodedWireTransaction, getSignatureFromTransaction,
  createNoopSigner, partiallySignTransactionMessageWithSigners, getBase64Decoder,
} from '@solana/kit';
import {
  findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction, getApproveInstruction, getTransferCheckedInstruction,
  getRevokeInstruction, TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';

export const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
export const MINT = address(process.env.MINT || '37y7f51uFjHJ8QjYSPtf49261f3jphqYZrQXgXuM7Jd8');
export const DECIMALS = 6;
export const DEPOSIT = 250_000n; // the on-chain cap: 0.25 test USDC
export const FUNDING = 500_000n; // the wallet holds more than the cap, so a refusal can only come from the cap

const rpc = createSolanaRpc(RPC_URL);

function loadKey(envName, file) {
  const raw = process.env[envName] ? JSON.parse(process.env[envName]) : JSON.parse(fs.readFileSync(file, 'utf8'));
  return createKeyPairSignerFromBytes(Uint8Array.from(raw));
}
const operatorP = loadKey('OPERATOR_KEY', new URL('./keys/operator.json', import.meta.url).pathname);
const payeeP = loadKey('PAYEE_KEY', new URL('./keys/payee.json', import.meta.url).pathname);

const ata = async (owner) => (await findAssociatedTokenPda({ mint: MINT, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

async function retry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries - 1 || !/429|fetch failed|ECONNRESET|blockhash/i.test(String(e?.message) + String(e?.cause))) throw e;
      await new Promise(r => setTimeout(r, 1200 * (i + 1)));
    }
  }
}

async function build(feePayer, ixs) {
  const { value: bh } = await retry(() => rpc.getLatestBlockhash({ commitment: 'confirmed' }).send());
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    m => appendTransactionMessageInstructions(ixs, m),
  );
  return signTransactionMessageWithSigners(msg);
}

async function confirm(sig, timeoutMs = 45_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { value } = await retry(() => rpc.getSignatureStatuses([sig]).send());
    const st = value[0];
    if (st?.err) {
      const err = new Error('failed on-chain');
      err.chainErr = JSON.stringify(st.err, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
      throw err;
    }
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error(`not confirmed in time: ${sig}`);
}

async function send(feePayer, ixs, { skipPreflight = false } = {}) {
  const tx = await build(feePayer, ixs);
  const sig = getSignatureFromTransaction(tx);
  await retry(() => rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', skipPreflight, preflightCommitment: 'confirmed' }).send());
  try {
    return { sig, ms: await timed(() => confirm(sig)) };
  } catch (e) { e.sig = sig; throw e; }
}
async function timed(fn) { const t = Date.now(); await fn(); return Date.now() - t; }

// The browser tab owns the payer wallet: its key signs the approval here and the
// revoke at settle. The server only pays fees and mints test USDC into it.
async function prepare(ixs) {
  const operator = await operatorP;
  const { value: bh } = await retry(() => rpc.getLatestBlockhash({ commitment: 'confirmed' }).send());
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(operator, m),
    m => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    m => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await partiallySignTransactionMessageWithSigners(msg);
  return { tx, message: getBase64Decoder().decode(tx.messageBytes) };
}

export async function submitWithPayerSignature(tx, payerAddress, signatureBytes) {
  const signed = { ...tx, signatures: { ...tx.signatures, [payerAddress]: signatureBytes } };
  const sig = getSignatureFromTransaction(signed);
  await retry(() => rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', preflightCommitment: 'confirmed' }).send());
  return { sig, ms: await timed(() => confirm(sig)) };
}

export async function prepareOpen(payerAddress) {
  const operator = await operatorP;
  const payee = await payeeP;
  const owner = createNoopSigner(address(payerAddress));
  const payerAta = await ata(owner.address);
  return prepare([
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: operator, owner: owner.address, mint: MINT }),
    getMintToInstruction({ mint: MINT, token: payerAta, mintAuthority: operator, amount: FUNDING }),
    getApproveInstruction({ source: payerAta, delegate: payee.address, owner, amount: DEPOSIT }),
  ]);
}

export async function prepareSettle(payerAddress, amount) {
  const payee = await payeeP;
  const owner = createNoopSigner(address(payerAddress));
  const { ix, payeeAta } = await ensurePayeeAta();
  const ixs = [ix];
  if (amount > 0n) {
    ixs.push(getTransferCheckedInstruction({
      source: await ata(owner.address), mint: MINT, destination: payeeAta, authority: payee, amount, decimals: DECIMALS,
    }));
  }
  ixs.push(getRevokeInstruction({ source: await ata(owner.address), owner }));
  return prepare(ixs);
}

async function ensurePayeeAta() {
  const operator = await operatorP;
  const payee = await payeeP;
  return { ix: await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: operator, owner: payee.address, mint: MINT }), payeeAta: await ata(payee.address) };
}

// The provider tries to pull more than the on-chain cap. The token program refuses.
export async function tryOvercharge(payerAddress) {
  const operator = await operatorP;
  const payee = await payeeP;
  const { ix, payeeAta } = await ensurePayeeAta();
  const amount = DEPOSIT + 50_000n;
  try {
    const r = await send(operator, [ix, getTransferCheckedInstruction({
      source: await ata(address(payerAddress)), mint: MINT, destination: payeeAta, authority: payee, amount, decimals: DECIMALS,
    })], { skipPreflight: true });
    return { sig: r.sig, failed: false, amount: amount.toString() };
  } catch (e) {
    const sig = e.sig;
    return { failed: true, error: e.chainErr || e.message, amount: amount.toString(), sig };
  }
}


// Public proof of use: successful payouts into the provider's token account.
let statsCache = { at: 0, value: null };
export async function stats() {
  if (statsCache.value && Date.now() - statsCache.at < 20_000) return statsCache.value;
  const payee = await payeeP;
  const payeeAccount = await ata(payee.address);
  const sigs = await retry(() => rpc.getSignaturesForAddress(payeeAccount, { limit: 1000 }).send());
  const ok = sigs.filter(s => !s.err);
  const value = { settledSessions: ok.length, refusedOvercharges: sigs.length - ok.length, payeeAccount, payee: payee.address };
  statsCache = { at: Date.now(), value };
  return value;
}

export { rpc };
