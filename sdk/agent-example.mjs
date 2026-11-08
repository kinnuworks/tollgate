// An agent buys an answer per token with its own key, stops when it has enough, and settles.
// Run: node agent-example.mjs [server url]
import { TollgateClient } from './tollgate.mjs';

const tg = new TollgateClient(process.argv[2] || 'https://tollgate-production-6271.up.railway.app');
await tg.open('haiku');
console.log('agent wallet', tg.address);
const { text, paidUnits, stopped } = await tg.ask('List three uses of Solana payment channels, one line each.', {
  // Budget rule: keep paying until the answer has three lines, never past half a cent.
  shouldPay: (soFar, next) => next <= 5_000n && soFar.split('\n').filter(l => l.trim()).length < 3,
});
console.log(text.trim(), '\n---');
console.log('paid', paidUnits, 'units', stopped ? `(${stopped})` : '');
const receipt = await tg.settle();
console.log('settled', receipt.paid, 'units in', receipt.ms, 'ms →', receipt.explorer);
console.log(tg.log.join('\n'));
