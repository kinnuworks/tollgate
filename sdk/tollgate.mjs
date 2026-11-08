// Tollgate client: lets any program or AI agent buy an AI answer per token from a Tollgate
// provider, with its own Solana key. The key never leaves this process: it signs the
// on-chain approval, one voucher per 50 tokens, and the revoke at settle. Every transaction
// the provider builds is decoded and checked here before it is signed.
//
//   import { TollgateClient } from './tollgate.mjs';
//   const tg = new TollgateClient('https://tollgate-production-6271.up.railway.app');
//   await tg.open();
//   const { text } = await tg.ask('What is a payment channel?', { maxUsd: 0.0005 });
//   const receipt = await tg.settle();
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOLLGATE = '58S2R4oQRDYts3qXK6PYwq9SwZg1oPnLGvYRdbxpFNWj';
// Each provider's spender: a Tollgate PDA derived from the provider's wallet (pinned, not trusted from the server).
export const PROVIDERS = {
  haiku: { pda: '7oiVMCH4XDhaptH4MQh1AcC61M1FifayFRQCoXKfN2eD' },
  sonnet: { pda: 'Az5BE3LYihAePbJqg8K9XCieZFVQRaPP5tHZJVa49CyA' },
};
const CAP = 250_000n;

/** 50-byte voucher, Solana Foundation payment-channel layout. */
export function voucherBytes(channel, amount, expiresAt) {
  const out = new Uint8Array(50);
  const dv = new DataView(out.buffer);
  out[0] = 0x56; out[1] = 0x01; out.set(bs58.decode(channel), 2);
  dv.setBigUint64(34, BigInt(amount), true); dv.setBigInt64(42, BigInt(expiresAt), true);
  return out;
}

/** Decode a v0/legacy Solana message into instructions {program, accounts, data}. */
export function parseMessage(b64) {
  const m = Uint8Array.from(Buffer.from(b64, 'base64')); let i = 0;
  const cu16 = () => { let v = 0, sh = 0; for (;;) { const b = m[i++]; v |= (b & 0x7f) << sh; if (!(b & 0x80)) return v; sh += 7; } };
  if (m[0] & 0x80) i = 1;
  i += 3;
  const keys = []; for (let n = cu16(); n > 0; n--) { keys.push(bs58.encode(m.slice(i, i + 32))); i += 32; }
  i += 32;
  const ixs = [];
  for (let n = cu16(); n > 0; n--) {
    const program = keys[m[i++]]; const accounts = []; for (let a = cu16(); a > 0; a--) accounts.push(keys[m[i++]]);
    const len = cu16(); const data = m.slice(i, i + len); i += len; ixs.push({ program, accounts, data });
  }
  return ixs;
}
const u64 = (d, at) => new DataView(d.buffer, d.byteOffset).getBigUint64(at, true);

/** Refuse anything this client did not agree to. Throws on a bad transaction. */
export function checkTransaction(kind, b64, me, signedUnits, pda = PROVIDERS.haiku.pda) {
  const notes = [];
  for (const x of parseMessage(b64)) {
    if (x.program === TOKEN && x.data[0] === 4) {
      if (x.accounts[1] !== pda || x.accounts[2] !== me || u64(x.data, 1) > CAP) throw new Error('refused: approval is not to the Tollgate program or is above the cap');
      notes.push(`approve Tollgate program up to ${u64(x.data, 1)} units`);
    } else if (x.program === TOKEN && (x.data[0] === 3 || x.data[0] === 12) && x.accounts.includes(me)) {
      throw new Error('refused: a transfer signed by this wallet');
    } else if (x.program === TOLLGATE) {
      if (u64(x.data, 1) > BigInt(signedUnits)) throw new Error('refused: settle asks for more than this client signed');
      notes.push(`settle ${u64(x.data, 1)} units (signed ${signedUnits})`);
    } else if (x.program === TOKEN && x.data[0] === 5) notes.push('revoke');
    else if (x.program === TOKEN && (x.data[0] === 7 || x.data[0] === 12)) { /* funding this wallet */ }
    else if (x.program === TOKEN) throw new Error(`refused: unexpected token instruction ${x.data[0]}`);
    else if (!['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'Ed25519SigVerify111111111111111111111111111', 'ComputeBudget111111111111111111111111111111'].includes(x.program)) throw new Error(`refused: unknown program ${x.program}`);
  }
  if (kind === 'open' && !notes.some(n => n.startsWith('approve'))) throw new Error('refused: no approval in the open transaction');
  return notes;
}

export class TollgateClient {
  constructor(baseUrl, secretKey = ed25519.utils.randomSecretKey()) {
    this.base = baseUrl.replace(/\/$/, '');
    this.secret = secretKey;
    this.address = bs58.encode(ed25519.getPublicKey(secretKey));
    this.signed = 0n;
    this.log = [];
  }
  async #post(path, body) {
    const r = await fetch(this.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`); return j;
  }
  #sign(b64) { return bs58.encode(ed25519.sign(Uint8Array.from(Buffer.from(b64, 'base64')), this.secret)); }

  /** Opens a session: the provider funds this wallet and asks it to approve the Tollgate program. */
  async open(provider = 'haiku') {
    this.provider = provider;
    const o = await this.#post('/api/open', { sessionKey: this.address, provider });
    this.log.push(...checkTransaction('open', o.message, this.address, 0n, PROVIDERS[provider].pda).map(n => 'checked: ' + n));
    const s = await this.#post('/api/open/confirm', { id: o.id, signature: this.#sign(o.message) });
    this.session = s;
    return s;
  }

  /**
   * Streams an answer. Before each 50-token block the client decides whether to pay:
   * shouldPay(textSoFar, nextUnits) — default: stay under maxUsd.
   */
  async ask(question, { maxUsd = 0.25, shouldPay, onText } = {}) {
    const maxUnits = BigInt(Math.floor(maxUsd * 1e6));
    const decide = shouldPay || ((_t, next) => next <= maxUnits);
    const res = await fetch(`${this.base}/api/chat?id=${this.session.id}&q=${encodeURIComponent(question)}`);
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = '', text = '', stopped = null;
    outer: for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (\w+)/.exec(block)?.[1]; const data = JSON.parse(/data: (.*)/.exec(block)?.[1] || '{}');
        if (ev === 'text') { text += data.chunk; onText?.(data.chunk); }
        if (ev === 'pay') {
          const next = BigInt(data.cumulativeAmount);
          if (!(await decide(text, next))) { stopped = `stopped paying at ${this.signed} units`; await reader.cancel(); break outer; }
          const expiresAt = Math.floor(Date.now() / 1000) + 3600;
          const sig = bs58.encode(ed25519.sign(voucherBytes(this.address, next, expiresAt), this.secret));
          await this.#post('/api/voucher', { id: this.session.id, cumulativeAmount: data.cumulativeAmount, expiresAt, signature: sig });
          this.signed = next;
        }
        if (ev === 'done') break outer;
      }
    }
    return { text, paidUnits: this.signed, stopped };
  }

  /** Settles on-chain: pays exactly the last signed voucher, revokes the approval. */
  async settle() {
    const p = await this.#post('/api/settle', { id: this.session.id });
    this.log.push(...checkTransaction('settle', p.message, this.address, this.signed, PROVIDERS[this.provider].pda).map(n => 'checked: ' + n));
    const r = await this.#post('/api/settle', { id: this.session.id, signature: this.#sign(p.message) });
    return { ...r.settled, explorer: `https://explorer.solana.com/tx/${r.settled.sig}?cluster=devnet` };
  }
}
