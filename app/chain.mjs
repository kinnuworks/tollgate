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
} from '@solana/kit';
import {
  findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction, getApproveInstruction, getTransferCheckedInstruction,
  getRevokeInstruction, TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';

export const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
export const MINT = address(process.env.MINT || '37y7f51uFjHJ8QjYSPtf49261f3jphqYZrQXgXuM7Jd8');
export const DECIMALS = 6;
export const DEPOSIT = 250_000n; // 0.25 test USDC

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

export async function openSession() {
  const operator = await operatorP;
  const payee = await payeeP;
  const payer = await generateKeyPairSigner();
  const payerAta = await ata(payer.address);
  const { sig, ms } = await send(operator, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: operator, owner: payer.address, mint: MINT }),
    getMintToInstruction({ mint: MINT, token: payerAta, mintAuthority: operator, amount: DEPOSIT }),
    getApproveInstruction({ source: payerAta, delegate: payee.address, owner: payer, amount: DEPOSIT }),
  ]);
  return { payer, payerAddress: payer.address, payee: payee.address, openSig: sig, openMs: ms };
}

async function ensurePayeeAta() {
  const operator = await operatorP;
  const payee = await payeeP;
  return { ix: await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: operator, owner: payee.address, mint: MINT }), payeeAta: await ata(payee.address) };
}

// The provider tries to pull more than the on-chain cap. The token program refuses.
export async function tryOvercharge(payer) {
  const operator = await operatorP;
  const payee = await payeeP;
  const { ix, payeeAta } = await ensurePayeeAta();
  const amount = DEPOSIT + 50_000n;
  try {
    const r = await send(operator, [ix, getTransferCheckedInstruction({
      source: await ata(payer.address), mint: MINT, destination: payeeAta, authority: payee, amount, decimals: DECIMALS,
    })], { skipPreflight: true });
    return { sig: r.sig, failed: false, amount: amount.toString() };
  } catch (e) {
    const sig = e.sig;
    return { failed: true, error: e.chainErr || e.message, amount: amount.toString(), sig };
  }
}

export async function settle(payer, amount) {
  const operator = await operatorP;
  const payee = await payeeP;
  const { ix, payeeAta } = await ensurePayeeAta();
  const ixs = [ix];
  if (amount > 0n) {
    ixs.push(getTransferCheckedInstruction({
      source: await ata(payer.address), mint: MINT, destination: payeeAta, authority: payee, amount, decimals: DECIMALS,
    }));
  }
  ixs.push(getRevokeInstruction({ source: await ata(payer.address), owner: payer }));
  return send(operator, ixs);
}

export { rpc };
