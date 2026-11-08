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
  getProgramDerivedAddress, AccountRole, getBase58Encoder,
} from '@solana/kit';
import { encodeVoucherMessageBytes } from '@solana/mpp/server';
import {
  findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction, getApproveInstruction, getTransferCheckedInstruction,
  getRevokeInstruction, TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';

export const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
export const TEST_MINT = address(process.env.MINT || '37y7f51uFjHJ8QjYSPtf49261f3jphqYZrQXgXuM7Jd8');
// Circle's USDC on Solana devnet. Sessions use it while the operator holds enough; otherwise the test mint.
export const USDC_MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
export const MINT = TEST_MINT;
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

const ata = async (owner, mint = MINT) => (await findAssociatedTokenPda({ mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

// Which mint to fund the next session with: Circle's devnet USDC when the operator holds enough.
export async function pickMint() {
  try {
    const operator = await operatorP;
    const opAta = await ata(operator.address, USDC_MINT);
    const { value } = await retry(() => rpc.getTokenAccountBalance(opAta, { commitment: 'confirmed' }).send());
    return BigInt(value.amount) >= FUNDING ? USDC_MINT : TEST_MINT;
  } catch { return TEST_MINT; }
}


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

export async function submitWithPayerSignature(tx, payerAddress, signatureBytes, { skipPreflight = false } = {}) {
  const signed = { ...tx, signatures: { ...tx.signatures, [payerAddress]: signatureBytes } };
  const sig = getSignatureFromTransaction(signed);
  await retry(() => rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', skipPreflight, preflightCommitment: 'confirmed' }).send());
  try { return { sig, ms: await timed(() => confirm(sig)) }; } catch (e) { e.sig = sig; throw e; }
}

export const PROGRAM_ID = address(process.env.PROGRAM_ID || '58S2R4oQRDYts3qXK6PYwq9SwZg1oPnLGvYRdbxpFNWj');
const ED25519_PROGRAM = address('Ed25519SigVerify111111111111111111111111111');
const INSTRUCTIONS_SYSVAR = address('Sysvar1nstructions1111111111111111111111111');
const pdaP = getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: ['tollgate'] });
const b58 = getBase58Encoder();

// The tab approves the Tollgate program's PDA (not the provider) to spend at most the cap.
export async function prepareOpen(payerAddress, mint = MINT) {
  const operator = await operatorP;
  const [pda] = await pdaP;
  const owner = createNoopSigner(address(payerAddress));
  const payerAta = await ata(owner.address, mint);
  const fund = mint === USDC_MINT
    ? getTransferCheckedInstruction({ source: await ata(operator.address, mint), mint, destination: payerAta, authority: operator, amount: FUNDING, decimals: DECIMALS })
    : getMintToInstruction({ mint, token: payerAta, mintAuthority: operator, amount: FUNDING });
  return prepare([
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: operator, owner: owner.address, mint }),
    fund,
    getApproveInstruction({ source: payerAta, delegate: pda, owner, amount: DEPOSIT }),
  ]);
}

// Ed25519 precompile instruction that verifies the tab's voucher signature in-transaction.
function ed25519Ix(pubkeyB58, sigB58, message) {
  const pk = b58.encode(pubkeyB58), sig = b58.encode(sigB58);
  const data = new Uint8Array(16 + 32 + 64 + message.length);
  const dv = new DataView(data.buffer);
  data[0] = 1; data[1] = 0;
  dv.setUint16(2, 48, true); dv.setUint16(4, 0xffff, true);   // signature offset / ix index
  dv.setUint16(6, 16, true); dv.setUint16(8, 0xffff, true);   // public key offset / ix index
  dv.setUint16(10, 112, true); dv.setUint16(12, message.length, true); dv.setUint16(14, 0xffff, true);
  data.set(pk, 16); data.set(sig, 48); data.set(message, 112);
  return { programAddress: ED25519_PROGRAM, accounts: [], data };
}

async function settleIxs(ownerSigner, amount, voucher, mint = MINT) {
  const [pda, bump] = await pdaP;
  const { ix, payeeAta } = await ensurePayeeAta(mint);
  const owner = ownerSigner.address;
  const payerAddress = owner;
  const data = new Uint8Array(11); const dv = new DataView(data.buffer);
  data[0] = 1; dv.setBigUint64(1, BigInt(amount), true); data[9] = DECIMALS; data[10] = bump;
  return [ix,
    ed25519Ix(payerAddress, voucher.signature, encodeVoucherMessageBytes({ channelId: payerAddress, cumulativeAmount: BigInt(voucher.amount), expiresAt: BigInt(voucher.expiresAt) })),
    { programAddress: PROGRAM_ID, data, accounts: [
      { address: await ata(owner, mint), role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: payeeAta, role: AccountRole.WRITABLE },
      { address: pda, role: AccountRole.READONLY },
      { address: owner, role: AccountRole.READONLY_SIGNER, signer: ownerSigner },
      { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ] }];
}

// Settle: Tollgate checks the voucher on-chain and pays at most the signed amount; the tab signs the revoke.
export async function prepareSettle(payerAddress, amount, voucher, mint = MINT) {
  const owner = createNoopSigner(address(payerAddress));
  const ixs = amount > 0n && voucher ? await settleIxs(owner, amount, voucher, mint) : [];
  ixs.push(getRevokeInstruction({ source: await ata(owner.address, mint), owner }));
  return prepare(ixs);
}

async function ensurePayeeAta(mint = MINT) {
  const operator = await operatorP;
  const payee = await payeeP;
  return { ix: await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: operator, owner: payee.address, mint }), payeeAta: await ata(payee.address, mint) };
}

// A settle for $0.30 against the tab's latest voucher. The tab co-signs it (as it
// would sign anything the server sends), and the Tollgate program still refuses.
export async function prepareOvercharge(payerAddress, voucher, mint = MINT) {
  const owner = createNoopSigner(address(payerAddress));
  const v = voucher || { amount: '0', expiresAt: 0, signature: '1111111111111111111111111111111111111111111111111111111111111111' };
  return prepare(await settleIxs(owner, DEPOSIT + 50_000n, v, mint));
}

// Public proof of use: successful payouts into the provider's token account.
let statsCache = { at: 0, value: null };
export async function stats() {
  if (statsCache.value && Date.now() - statsCache.at < 20_000) return statsCache.value;
  const payee = await payeeP;
  let ok = 0, failed = 0;
  for (const mint of [TEST_MINT, USDC_MINT]) {
    const acct = await ata(payee.address, mint);
    const sigs = await retry(() => rpc.getSignaturesForAddress(acct, { limit: 1000 }).send()).catch(() => []);
    ok += sigs.filter(x => !x.err).length; failed += sigs.filter(x => x.err).length;
  }
  const value = { settledSessions: ok, refusedOvercharges: failed, payeeAccount: payee.address, payee: payee.address };
  statsCache = { at: Date.now(), value };
  return value;
}

export { rpc };
