import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BOT, LABEL, decide, refundsPending, settings } from './submission-fee.mjs';
import {
  DEAD_AFTER,
  MAX_ATTEMPTS,
  inOrder,
  ledger,
  paidAmount,
  refund,
  refundMark,
  transferData,
} from './submission-fee-refund.mjs';

const FEE = '0x00000000000000000000000000000000000000fe';
const WALLET = '0x00000000000000000000000000000000000000aa';
const OTHER = '0x00000000000000000000000000000000000000bb';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const PAY = `0x${'1'.repeat(64)}`;
const R1 = `0x${'a'.repeat(64)}`;
const R2 = `0x${'b'.repeat(64)}`;
const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-12-01T00:00:00Z');
const NOW = START + 20 * DAY;

const raw = {
  enabled: true,
  feeAddress: FEE,
  refundWallet: FEE,
  startAt: '2026-12-01T00:00:00Z',
  token: USDC,
  amountMinor: '2000000',
  amountDisplay: '2 USDC',
};
const cfg = settings(raw);

const pad = (account) => `0x${account.slice(2).padStart(64, '0')}`;
const transfer = (from, to, amount) => ({
  address: USDC,
  topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(from), pad(to)],
  data: `0x${amount.toString(16).padStart(64, '0')}`,
});
const receiptOf = (...logs) => ({ status: '0x1', blockNumber: '0x64', logs });
const feePaid = receiptOf(transfer(WALLET, FEE, 2_000_000n));
const refundMined = receiptOf(transfer(FEE, WALLET, 2_000_000n));
const failedOnChain = { status: '0x0', blockNumber: '0x65', logs: [] };

const at = (days) => new Date(START + days * DAY).toISOString();
const bot = (body, when = at(2), number = 7) => ({
  user: { login: BOT },
  body,
  created_at: when,
  issue_url: `https://api.github.com/repos/o/r/issues/${number}`,
});
const paidNote = (when = at(2), number = 7) =>
  bot(`<!-- submission-fee:paid tx=${PAY} from=${WALLET} -->\n**Submission fee received.**`, when, number);
const dueNote = bot('<!-- submission-fee:refund-due -->\n**Refund due:** ...', at(16));
const sending = (tx, nonce, when = at(19)) => bot(refundMark.sending(PAY, tx, nonce), when);

const mergedPr = { number: 7, state: 'closed', pull_request: { merged_at: at(3) }, labels: [{ name: LABEL.refundDue }] };
const openPr = { number: 7, state: 'open', pull_request: { merged_at: null }, labels: [{ name: LABEL.refundDue }] };

/** The outside world, and a record of what the refund did to it, in order. */
function world({ comments = [paidNote()], receipts = { [PAY]: feePaid }, nonce = 5, short = null, mined = refundMined, broadcastFails = false, now = NOW, books } = {}) {
  const did = [];
  const deps = {
    now,
    head: 1000n,
    ledger: books ?? ledger(comments),
    comments: async () => comments,
    receipt: async (tx) => receipts[tx] ?? null,
    block: async () => ({ timestamp: `0x${Math.floor((START + DAY) / 1000).toString(16)}` }),
    nonce: async () => nonce,
    funds: async () => short,
    sign: async (request) => {
      did.push({ sign: request });
      return { raw: `raw:${request.nonce}`, hash: R1 };
    },
    broadcast: async (signed) => {
      did.push({ broadcast: signed });
      if (broadcastFails) throw new Error('nonce too low');
    },
    mined: async () => mined,
    comment: async (number, body) => did.push({ comment: body, number }),
  };
  return { deps, did };
}
const kinds = (did) => did.map((entry) => Object.keys(entry)[0]);

test('settings: a refund wallet turns automatic refunds on, and the notice says which', async () => {
  assert.equal(cfg.refundWallet, FEE);
  assert.equal(settings({ ...raw, refundWallet: undefined }).refundWallet, null);
  assert.equal(settings({ ...raw, refundWallet: '0x12' }).refundWallet, null);

  const merged = {
    number: 7, state: 'closed', draft: false, merged_at: at(3), closed_at: at(3), created_at: at(1),
    author_association: 'NONE', user: { id: 42, type: 'User' }, body: '', labels: [{ name: LABEL.paid }],
  };
  const notice = async (config) =>
    (await decide(merged, { now: NOW, comments: async () => [paidNote()] }, config))[0].body;
  assert.match(await notice(cfg), /sent automatically/);
  assert.match(await notice(settings({ ...raw, refundWallet: undefined })), /by hand once a month/);
});

test('the refund job is wanted only while a refund is due and neither sent nor set aside', () => {
  const issue = (...names) => ({ labels: names.map((name) => ({ name })) });
  assert.equal(refundsPending([]), false);
  assert.equal(refundsPending([issue(LABEL.refundDue)]), true);
  assert.equal(refundsPending([issue(LABEL.refundDue, LABEL.refunded)]), false);
  assert.equal(refundsPending([issue(LABEL.refundDue, LABEL.refundCheck)]), false);
});

test('call data is transfer(to, amount)', () => {
  assert.equal(
    transferData(WALLET, 2_000_000n),
    `0xa9059cbb${'0'.repeat(62)}aa${'0'.repeat(58)}1e8480`,
  );
});

test('the refund is the fee, never more, and nothing when the payment does not match', () => {
  assert.equal(paidAmount(feePaid, WALLET, cfg), 2_000_000n);
  assert.equal(paidAmount(receiptOf(transfer(WALLET, FEE, 9_000_000n)), WALLET, cfg), 2_000_000n);
  assert.equal(paidAmount(receiptOf(transfer(OTHER, FEE, 2_000_000n)), WALLET, cfg), 0n);
  assert.equal(paidAmount(receiptOf(transfer(WALLET, FEE, 1_000_000n)), WALLET, cfg), 0n);
});

test('a merged, paid pull request: note the hash, then broadcast, then record it sent', async () => {
  const { deps, did } = world();
  const result = await refund(mergedPr, deps, cfg);
  assert.deepEqual(result, { status: 'sent', tx: R1 });
  assert.deepEqual(kinds(did), ['sign', 'comment', 'broadcast', 'comment']);
  assert.deepEqual(did[0].sign, { to: WALLET, amount: 2_000_000n, nonce: 5 });
  assert.equal(did[1].comment, refundMark.sending(PAY, R1, 5));
  assert.ok(did[3].comment.startsWith(refundMark.sent(PAY, R1)));
  assert.ok(deps.ledger.refunded.has(PAY));
});

test('a refund already recorded as sent is never sent again', async () => {
  const comments = [paidNote(), bot(`${refundMark.sent(PAY, R1)}\n**Refund sent:** ...`)];
  const { deps, did } = world({ comments });
  assert.deepEqual(await refund(mergedPr, deps, cfg), { status: 'sent', tx: R1, already: true });
  assert.deepEqual(did, []);
});

test('fourteen days undecided: refunded once the workflow has said it is due', async () => {
  const early = world({ comments: [paidNote(at(10)), dueNote] });
  assert.equal((await refund(openPr, early.deps, cfg)).status, 'held');
  const noNotice = world({ comments: [paidNote(at(2))] });
  assert.equal((await refund(openPr, noNotice.deps, cfg)).status, 'held');
  const due = world({ comments: [paidNote(at(2)), dueNote] });
  assert.equal((await refund(openPr, due.deps, cfg)).status, 'sent');
  for (const { did } of [early, noNotice]) assert.deepEqual(did, []);
});

test('a label alone moves nothing: no payment record, or one somebody pasted', async () => {
  const none = world({ comments: [] });
  assert.match((await refund(mergedPr, none.deps, cfg)).reason, /no record of a fee payment/);
  const pasted = world({ comments: [{ ...paidNote(), user: { login: 'outsider' } }] });
  assert.equal((await refund(mergedPr, pasted.deps, cfg)).status, 'held');
  assert.deepEqual([...none.did, ...pasted.did], []);
});

test('the payment is checked on Base again before anything is signed', async () => {
  const missing = world({ receipts: {} });
  assert.match((await refund(mergedPr, missing.deps, cfg)).reason, /does not check out/);
  const fromSomeoneElse = world({ receipts: { [PAY]: receiptOf(transfer(OTHER, FEE, 2_000_000n)) } });
  assert.equal((await refund(mergedPr, fromSomeoneElse.deps, cfg)).status, 'held');
  const toSomewhereElse = world({ receipts: { [PAY]: receiptOf(transfer(WALLET, OTHER, 2_000_000n)) } });
  assert.equal((await refund(mergedPr, toSomewhereElse.deps, cfg)).status, 'held');
  for (const { did } of [missing, fromSomeoneElse, toSomewhereElse]) assert.deepEqual(did, []);
});

test('one payment, one refund, on the pull request it paid for', async () => {
  const elsewhere = world({ books: { paidOn: new Map([[PAY, 3]]), refunded: new Set(), started: new Map() } });
  assert.match((await refund(mergedPr, elsewhere.deps, cfg)).reason, /another pull request/);
  const refunded = world({ books: { paidOn: new Map([[PAY, 7]]), refunded: new Set([PAY]), started: new Map() } });
  assert.match((await refund(mergedPr, refunded.deps, cfg)).reason, /already refunded/);
  assert.deepEqual([...elsewhere.did, ...refunded.did], []);
});

test('a wallet that cannot pay is set aside for a person, and nothing is signed', async () => {
  const { deps, did } = world({ short: 'it holds too little USDC' });
  assert.match((await refund(mergedPr, deps, cfg)).reason, /too little USDC/);
  assert.deepEqual(did, []);
});

test('a run that died after the note: the same nonce is signed again', async () => {
  const { deps, did } = world({ comments: [paidNote(), sending(R2, 5)], nonce: 5 });
  assert.equal((await refund(mergedPr, deps, cfg)).status, 'sent');
  assert.equal(did[0].sign.nonce, 5);
});

test('a run that died after the broadcast: the mined transaction is recorded, nothing is signed', async () => {
  const { deps, did } = world({
    comments: [paidNote(), sending(R2, 5)],
    receipts: { [PAY]: feePaid, [R2]: refundMined },
    nonce: 6,
  });
  assert.deepEqual(await refund(mergedPr, deps, cfg), { status: 'sent', tx: R2 });
  assert.deepEqual(kinds(did), ['comment']);
});

test('an unmined refund whose nonce went elsewhere waits, then is replaced', async () => {
  const young = world({ comments: [paidNote(), sending(R2, 5, new Date(NOW - DEAD_AFTER / 2).toISOString())], nonce: 6 });
  assert.equal((await refund(mergedPr, young.deps, cfg)).status, 'retry');
  assert.deepEqual(young.did, []);
  const old = world({ comments: [paidNote(), sending(R2, 5, new Date(NOW - 2 * DEAD_AFTER).toISOString())], nonce: 6 });
  assert.equal((await refund(mergedPr, old.deps, cfg)).status, 'sent');
  assert.equal(old.did[0].sign.nonce, 6);
});

test('a refund waiting behind an earlier nonce is left for the next run', async () => {
  const { deps, did } = world({ comments: [paidNote(), sending(R2, 6)], nonce: 5 });
  assert.equal((await refund(mergedPr, deps, cfg)).status, 'retry');
  assert.deepEqual(did, []);
});

test('a refund that failed on Base is tried again, up to a limit', async () => {
  const once = world({ comments: [paidNote(), sending(R2, 5)], receipts: { [PAY]: feePaid, [R2]: failedOnChain }, nonce: 6 });
  assert.equal((await refund(mergedPr, once.deps, cfg)).status, 'sent');
  assert.equal(once.did[0].sign.nonce, 6);

  const hashes = Array.from({ length: MAX_ATTEMPTS }, (_, index) => `0x${String(index + 2).repeat(64)}`);
  const many = world({
    comments: [paidNote(), ...hashes.map((tx, index) => sending(tx, 5 + index))],
    receipts: { [PAY]: feePaid, ...Object.fromEntries(hashes.map((tx) => [tx, failedOnChain])) },
    nonce: 9,
  });
  assert.match((await refund(mergedPr, many.deps, cfg)).reason, /did not go through/);
  assert.deepEqual(many.did, []);
});

test('a mined transaction that is not this refund does not count as one', async () => {
  const wrong = receiptOf(transfer(FEE, OTHER, 2_000_000n));
  const { deps, did } = world({ comments: [paidNote(), sending(R2, 5)], receipts: { [PAY]: feePaid, [R2]: wrong }, nonce: 6 });
  assert.deepEqual(await refund(mergedPr, deps, cfg), { status: 'sent', tx: R1 });
  assert.equal(did[0].sign.nonce, 6);
});

test('Base refusing or not mining the transaction stops the run from sending more', async () => {
  const refused = world({ broadcastFails: true });
  const first = await refund(mergedPr, refused.deps, cfg);
  assert.equal(first.status, 'retry');
  assert.equal(first.inFlight, true);
  assert.deepEqual(kinds(refused.did), ['sign', 'comment', 'broadcast']);

  const slow = world({ mined: null });
  assert.deepEqual(await refund(mergedPr, slow.deps, cfg), { status: 'pending', inFlight: true, tx: R1 });

  const reverted = world({ mined: failedOnChain });
  const third = await refund(mergedPr, reverted.deps, cfg);
  assert.equal(third.status, 'retry');
  assert.equal(third.inFlight, undefined);
});

test('the ledger reads only the workflow\'s own notes, and started refunds go first', () => {
  const comments = [
    paidNote(at(2), 7),
    paidNote(at(3), 9), // the same payment offered again: the first pull request keeps it
    { ...bot(refundMark.sent(PAY, R1)), user: { login: 'outsider' } },
    bot(refundMark.sending(PAY, R2, 8), at(4), 7),
    bot(refundMark.sending(PAY, R1, 6), at(5), 7),
  ];
  const books = ledger(comments);
  assert.equal(books.paidOn.get(PAY), 7);
  assert.equal(books.refunded.size, 0);
  assert.deepEqual([...books.started], [[7, 6]]);
  assert.equal(ledger([...comments, bot(refundMark.sent(PAY, R1))]).started.size, 0);

  const order = inOrder([{ number: 3 }, { number: 12 }, { number: 7 }], new Map([[12, 9], [7, 6]]));
  assert.deepEqual(order.map((issue) => issue.number), [7, 12, 3]);
});
