// End-to-end test of a Tollgate server: open, stream with vouchers, pause, resume, overcharge, settle.
const BASE = process.argv[2] || 'http://localhost:3077';

const { ed25519 } = await import('@noble/curves/ed25519.js');
const bs58 = (await import('bs58')).default;
const { encodeVoucherMessageBytes } = await import('@solana/mpp/server');

const priv = ed25519.utils.randomSecretKey();
const sessionKey = bs58.encode(ed25519.getPublicKey(priv));
const post = async (p, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); const j = await r.json(); if (!r.ok) throw new Error(p + ' ' + JSON.stringify(j)); return j; };

const s = await post('/api/open', { sessionKey });
console.log('open ok', s.openSig.slice(0, 12));
let vouchers = 0, paused = false, pausedAt = null, text = '';
async function pay(d) {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const msg = encodeVoucherMessageBytes({ channelId: s.payer, cumulativeAmount: BigInt(d.cumulativeAmount), expiresAt: BigInt(expiresAt) });
  await post('/api/voucher', { id: s.id, cumulativeAmount: d.cumulativeAmount, expiresAt, signature: bs58.encode(ed25519.sign(msg, priv)) });
  vouchers++;
}
const res = await fetch(`${BASE}/api/chat?id=${s.id}&q=${encodeURIComponent('Explain how a payment channel works, in about 200 words.')}`);
const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
for (;;) {
  const { value, done } = await reader.read(); if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const block = buf.slice(0, i); buf = buf.slice(i + 2);
    const ev = /event: (\w+)/.exec(block)?.[1]; const data = JSON.parse(/data: (.*)/.exec(block)?.[1] || '{}');
    if (ev === 'text') text += data.chunk;
    if (ev === 'error') console.log('ERROR', data.message);
    if (ev === 'pay') {
      if (vouchers === 2 && !paused) { paused = true; pausedAt = text.length; console.log('pausing payment at', text.length, 'chars'); setTimeout(async () => { console.log('chars after 3 s unpaid:', text.length, '(was', pausedAt + ')'); await pay(data); }, 3000); }
      else await pay(data);
    }
    if (ev === 'done') console.log('done', data);
  }
}
console.log('answer start:', JSON.stringify(text.slice(0, 120)));
console.log('overcharge', await post('/api/overcharge', { id: s.id }));
const st = await post('/api/settle', { id: s.id });
console.log('settle', st.settled, 'vouchers', vouchers);
