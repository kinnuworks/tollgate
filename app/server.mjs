// Tollgate gateway: streams an AI answer only while the browser keeps signing
// payment vouchers, then settles the last signed amount on Solana devnet.
import fs from 'node:fs';
const envFile = new URL('./.env', import.meta.url);
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
import express from 'express';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import Anthropic from '@anthropic-ai/sdk';
import { ed25519 } from '@noble/curves/ed25519.js';
import { encodeVoucherMessageBytes } from '@solana/mpp/server';
import { prepareOpen, prepareSettle, submitWithPayerSignature, prepareOvercharge, pickMint, USDC_MINT, stats, DEPOSIT, FUNDING, MINT } from './chain.mjs';

const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || 'claude-haiku-5-5';
const UNITS_PER_TOKEN = 2n;         // 2 base units (0.000002 test USDC) per token = $2 per million
const BLOCK = 50;                   // tokens per voucher
const CHARS_PER_TOKEN = 4;          // live estimate; reconciled to the model's count at the end

const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: 'https://api.anthropic.com' });
const sessions = new Map();
const app = express();
app.use(express.json());
app.use(express.static(new URL('./public', import.meta.url).pathname));

const pub = s => ({
  id: s.id, payer: s.payerAddress, payee: s.payee, mint: s.mint, realUsdc: s.mint === USDC_MINT, deposit: DEPOSIT.toString(), funding: FUNDING.toString(),
  paidAmount: s.paidAmount.toString(), paidTokens: s.paidTokens, tokens: s.tokens, vouchers: s.vouchers.length,
  openSig: s.openSig, settled: s.settled || null,
});

app.post('/api/open', async (req, res) => {
  try {
    const sessionKey = String(req.body.sessionKey || '');
    if (bs58.decode(sessionKey).length !== 32) throw new Error('bad session key');
    const id = crypto.randomUUID();
    const mint = await pickMint();
    const { tx, message } = await prepareOpen(sessionKey, mint);
    const s = { id, sessionKey, mint, payerAddress: sessionKey, payee: null, paidAmount: 0n, paidTokens: 0, tokens: 0, vouchers: [], waiters: [], history: [], pending: tx };
    sessions.set(id, s);
    res.json({ id, message });
  } catch (e) {
    console.error('open', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Browser posts a signed voucher for a running total.
app.post('/api/voucher', (req, res) => {
  const s = sessions.get(req.body.id);
  if (!s || s.settled) return res.status(404).json({ error: 'no open session' });
  const amount = BigInt(req.body.cumulativeAmount);
  const expiresAt = Number(req.body.expiresAt);
  const msg = encodeVoucherMessageBytes({ channelId: s.payerAddress, cumulativeAmount: amount, expiresAt: BigInt(expiresAt) });
  let ok = false;
  try { ok = ed25519.verify(bs58.decode(req.body.signature), msg, bs58.decode(s.sessionKey)); } catch { ok = false; }
  if (!ok) return res.status(400).json({ error: 'signature does not match this tab\'s key' });
  if (amount <= s.paidAmount) return res.status(400).json({ error: 'voucher total must go up' });
  if (amount > DEPOSIT) return res.status(400).json({ error: 'voucher is above the deposit' });
  s.paidAmount = amount;
  s.paidTokens = Number(amount / UNITS_PER_TOKEN);
  s.vouchers.push({ amount: amount.toString(), expiresAt, signature: req.body.signature, at: Date.now() });
  s.waiters.splice(0).forEach(w => w());
  res.json({ ok: true, paidTokens: s.paidTokens });
});

// Server-sent events: text arrives only up to the token count the vouchers cover.
app.get('/api/chat', async (req, res) => {
  const s = sessions.get(req.query.id);
  if (!s || s.settled) return res.status(404).end();
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  let closed = false;
  req.on('close', () => { closed = true; });

  let buffer = '';
  let done = false;
  let finalTokens = null;
  s.history.push({ role: 'user', content: String(req.query.q || '').slice(0, 2000) });
  (async () => {
    try {
      const stream = ai.messages.stream({ model: MODEL, max_tokens: 1200, thinking: { type: 'disabled' }, messages: s.history,
        system: 'Answer clearly and helpfully in plain prose. No markdown headings.' });
      stream.on('text', t => { buffer += t; });
      const final = await stream.finalMessage();
      finalTokens = final.usage?.output_tokens ?? null;
    } catch (e) {
      send('error', { message: String(e.message || e) });
    } finally { done = true; }
  })();

  let sentChars = 0;
  let answer = '';
  let lastAsk = -1;
  while (!closed) {
    const allowedChars = s.paidTokens * CHARS_PER_TOKEN;
    const available = buffer.length;
    if (sentChars < available && sentChars < allowedChars) {
      const chunk = buffer.slice(sentChars, Math.min(available, allowedChars, sentChars + 8));
      sentChars += chunk.length;
      answer += chunk;
      s.tokens = Math.ceil(sentChars / CHARS_PER_TOKEN) + (s.tokensBefore || 0);
      send('text', { chunk, tokens: s.tokens });
      await new Promise(r => setTimeout(r, 30));
      continue;
    }
    if (done && sentChars >= available) break;
    if (sentChars >= allowedChars && sentChars < available || (!done && sentChars >= allowedChars)) {
      const need = s.paidTokens + BLOCK;
      if (need !== lastAsk) {
        lastAsk = need;
        send('pay', { cumulativeTokens: need, cumulativeAmount: (BigInt(need) * UNITS_PER_TOKEN).toString() });
      }
      await new Promise(r => { s.waiters.push(r); setTimeout(r, 1500); });
      continue;
    }
    await new Promise(r => setTimeout(r, 30));
  }
  s.tokensBefore = s.tokens;
  s.history.push({ role: 'assistant', content: answer || '…' });
  send('done', { tokens: s.tokens, modelTokens: finalTokens, paidTokens: s.paidTokens, paidAmount: s.paidAmount.toString() });
  res.end();
});

// The tab signs the transaction message with its own key; the server adds nothing but fees.
app.post('/api/open/confirm', async (req, res) => {
  const s = sessions.get(req.body.id);
  if (!s || !s.pending) return res.status(404).json({ error: 'no pending open' });
  try {
    const r = await submitWithPayerSignature(s.pending, s.payerAddress, bs58.decode(req.body.signature));
    s.pending = null; s.openSig = r.sig; s.openMs = r.ms; s.payee = (await stats()).payee || s.payee;
    res.json(pub(s));
  } catch (e) {
    console.error('open/confirm', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/overcharge', async (req, res) => {
  const s = sessions.get(req.body.id);
  if (!s) return res.status(404).json({ error: 'no session' });
  try {
    if (!req.body.signature) {
      const { tx, message } = await prepareOvercharge(s.payerAddress, s.vouchers.at(-1), s.mint);
      s.pendingOver = tx;
      return res.json({ message, amount: (DEPOSIT + 50_000n).toString(), signedFor: s.paidAmount.toString() });
    }
    try {
      const r = await submitWithPayerSignature(s.pendingOver, s.payerAddress, bs58.decode(req.body.signature), { skipPreflight: true });
      res.json({ failed: false, sig: r.sig });
    } catch (e) { res.json({ failed: true, sig: e.sig, error: e.chainErr || String(e.message || e) }); }
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/settle', async (req, res) => {
  const s = sessions.get(req.body.id);
  if (!s) return res.status(404).json({ error: 'no session' });
  if (s.settled) return res.json(pub(s));
  try {
    if (!req.body.signature) {
      const { tx, message } = await prepareSettle(s.payerAddress, s.paidAmount, s.vouchers.at(-1), s.mint);
      s.pendingSettle = tx;
      return res.json({ message, amount: s.paidAmount.toString() });
    }
    const r = await submitWithPayerSignature(s.pendingSettle, s.payerAddress, bs58.decode(req.body.signature));
    s.settled = { sig: r.sig, ms: r.ms, paid: s.paidAmount.toString(), refunded: (FUNDING - s.paidAmount).toString() };
    res.json(pub(s));
  } catch (e) {
    console.error('settle', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/stats', async (_, res) => {
  try { res.json(await stats()); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/health', (_, res) => res.json({ ok: true, model: MODEL, hasKey: !!process.env.ANTHROPIC_API_KEY }));
app.listen(PORT, () => console.log(`tollgate on :${PORT}`));
