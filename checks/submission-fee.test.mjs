import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  BOT,
  LABEL,
  decide,
  exempt,
  hashesIn,
  paymentProblem,
  settings,
  usedHashes,
} from './submission-fee.mjs';

const FEE = '0x00000000000000000000000000000000000000fe';
const WALLET = '0x00000000000000000000000000000000000000aa';
const OTHER = '0x00000000000000000000000000000000000000bb';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TX = `0x${'1'.repeat(64)}`;
const TX2 = `0x${'2'.repeat(64)}`;
const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-12-01T00:00:00Z');
const NOW = START + 20 * DAY;

const cfg = settings({
  enabled: true,
  feeAddress: FEE,
  startAt: '2026-12-01T00:00:00Z',
  token: USDC,
  amountMinor: '2000000',
  amountDisplay: '2 USDC',
});

const pad = (account) => `0x${account.slice(2).padStart(64, '0')}`;
const transfer = (from, to, amount, token = USDC) => ({
  address: token,
  topics: [
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    pad(from),
    pad(to),
  ],
  data: `0x${amount.toString(16).padStart(64, '0')}`,
});
const receiptOf = (...logs) => ({ status: '0x1', blockNumber: '0x64', logs });
const blockAt = (time) => ({ timestamp: `0x${Math.floor(time / 1000).toString(16)}` });
const paid = receiptOf(transfer(WALLET, FEE, 2_000_000n));

const at = (days) => new Date(START + days * DAY).toISOString();
const pull = (over = {}) => ({
  number: 7,
  state: 'open',
  draft: false,
  merged_at: null,
  closed_at: null,
  created_at: at(1),
  author_association: 'NONE',
  user: { id: 42, login: 'outsider', type: 'User' },
  body: '',
  labels: [],
  ...over,
});
const labelled = (...names) => names.map((name) => ({ name }));
const bot = (body, days = 1) => ({ user: { login: BOT }, body, created_at: at(days) });
const author = (body) => ({ user: { id: 42, login: 'outsider' }, body, created_at: at(1) });

/** The outside world: comments on the pull request, a registered wallet, receipts by hash. */
const world = ({ comments = [], wallet = WALLET, receipts = {}, used = [], now = NOW } = {}) => ({
  now,
  head: 1000n,
  used: new Set(used),
  comments: async () => comments,
  wallet: async () => wallet,
  receipt: async (tx) => receipts[tx] ?? null,
  block: async () => blockAt(START + DAY),
});
const types = (actions) => actions.map((action) => action.type);

test('the fee is off unless the settings are complete', () => {
  const whole = {
    enabled: true,
    feeAddress: FEE,
    startAt: '2026-12-01T00:00:00Z',
    token: USDC,
    amountMinor: '2000000',
  };
  assert.ok(settings(whole));
  assert.equal(settings({ ...whole, enabled: false }), null);
  assert.equal(settings({ ...whole, feeAddress: null }), null);
  assert.equal(settings({ ...whole, feeAddress: '0x12' }), null);
  assert.equal(settings({ ...whole, startAt: null }), null);
  assert.equal(settings({ ...whole, amountMinor: '0' }), null);
  assert.equal(settings(undefined), null);
});

test('the committed settings file parses, and is off until an address and a start are set', () => {
  const raw = JSON.parse(readFileSync(new URL('../.github/submission-fee.json', import.meta.url)));
  assert.equal(raw.amountMinor, '2000000');
  assert.equal(raw.token.toLowerCase(), USDC);
  if (raw.enabled) {
    assert.ok(settings(raw), 'an enabled settings file must be complete');
    // The address a contributor is told to pay must be the one written in the rules.
    const rules = readFileSync(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8');
    assert.ok(rules.toLowerCase().includes(raw.feeAddress.toLowerCase()));
  } else {
    assert.equal(settings(raw), null);
  }
});

test('hashes are found once each, and an address is not a hash', () => {
  assert.deepEqual(hashesIn(`paid ${TX.toUpperCase().replace('0X', '0x')} and ${TX} to ${FEE}`), [TX]);
  assert.deepEqual(hashesIn(null), []);
});

test('maintainers, members and bots are exempt; everyone else pays', () => {
  assert.ok(exempt(pull({ author_association: 'MEMBER' })));
  assert.ok(exempt(pull({ author_association: 'COLLABORATOR' })));
  assert.ok(exempt(pull({ user: { id: 1, type: 'Bot' } })));
  assert.ok(!exempt(pull({ author_association: 'CONTRIBUTOR' })));
  assert.ok(!exempt(pull({ author_association: 'FIRST_TIME_CONTRIBUTOR' })));
});

test('a payment is a USDC transfer of the fee from the registered wallet to the fee address', () => {
  const check = (receipt, over = {}) =>
    paymentProblem({ receipt, block: blockAt(START + DAY), head: 1000n, wallet: WALLET, cfg, ...over });
  assert.equal(check(paid), null);
  assert.equal(check(receiptOf(transfer(WALLET, FEE, 5_000_000n))), null);
  assert.match(check(null), /not found/);
  assert.match(check({ ...paid, status: '0x0' }), /failed/);
  assert.match(check(paid, { head: 120n }), /too recent/);
  assert.match(check(paid, { block: blockAt(START - DAY) }), /older than the submission fee/);
  assert.match(check(receiptOf(transfer(WALLET, FEE, 1_999_999n))), /no transfer/);
  assert.match(check(receiptOf(transfer(OTHER, FEE, 2_000_000n))), /no transfer/);
  assert.match(check(receiptOf(transfer(WALLET, OTHER, 2_000_000n))), /no transfer/);
  // A token that only imitates USDC's event does not count.
  assert.match(check(receiptOf(transfer(WALLET, FEE, 2_000_000n, OTHER))), /no transfer/);
});

test('exempt authors, drafts and pull requests from before the start are left alone', async () => {
  assert.deepEqual(await decide(pull({ author_association: 'MEMBER' }), world(), cfg), []);
  assert.deepEqual(await decide(pull({ draft: true }), world(), cfg), []);
  assert.deepEqual(await decide(pull({ created_at: at(-1) }), world(), cfg), []);
});

test('an unpaid pull request is asked once', async () => {
  const first = await decide(pull(), world(), cfg);
  assert.deepEqual(types(first), ['comment', 'label']);
  assert.match(first[0].body, /2 USDC/);
  assert.ok(first[0].body.includes(FEE));
  assert.deepEqual(first[1].add, [LABEL.needed]);

  const asked = [bot('<!-- submission-fee:needed -->', 18)];
  assert.deepEqual(await decide(pull({ labels: labelled(LABEL.needed) }), world({ comments: asked }), cfg), []);
});

test('a marker pasted by someone other than the workflow is ignored', async () => {
  const forged = [author('<!-- submission-fee:needed -->')];
  assert.deepEqual(types(await decide(pull(), world({ comments: forged }), cfg)), ['comment', 'label']);
  const fake = `<!-- submission-fee:paid tx=${TX} from=${WALLET} -->`;
  assert.equal(usedHashes([author(fake)]).size, 0);
  assert.deepEqual([...usedHashes([bot(fake)])], [TX]);
});

test('a hash in the body or in the author\'s comment marks the pull request paid', async () => {
  for (const [body, comments] of [
    [`fee: ${TX}`, []],
    ['', [author(`here ${TX}`)]],
  ]) {
    const deps = world({ comments, receipts: { [TX]: paid } });
    const actions = await decide(pull({ body }), deps, cfg);
    assert.deepEqual(types(actions), ['comment', 'label']);
    assert.ok(actions[0].body.includes(`tx=${TX} from=${WALLET}`));
    assert.deepEqual(actions[1], { type: 'label', add: [LABEL.paid], remove: [LABEL.needed] });
    assert.ok(deps.used.has(TX), 'the hash cannot pay for a second pull request in the same run');
  }
});

test('a hash posted by someone else is not read', async () => {
  const stranger = [{ user: { id: 99, login: 'x' }, body: TX, created_at: at(1) }];
  const actions = await decide(pull(), world({ comments: stranger, receipts: { [TX]: paid } }), cfg);
  assert.deepEqual(actions.at(-1).add, [LABEL.needed]);
});

test('a hash that does not count is answered once, with the reason', async () => {
  const asked = bot('<!-- submission-fee:needed -->', 18);
  const reused = await decide(
    pull({ body: TX }),
    world({ comments: [asked], receipts: { [TX]: paid }, used: [TX] }),
    cfg,
  );
  assert.deepEqual(types(reused), ['comment']);
  assert.match(reused[0].body, /already paid for another pull request/);

  const noWallet = await decide(pull({ body: TX }), world({ comments: [asked], wallet: null }), cfg);
  assert.match(noWallet[0].body, /no Base wallet registered/);

  const answered = [asked, bot(`<!-- submission-fee:rejected tx=${TX} -->`, 19)];
  assert.deepEqual(await decide(pull({ body: TX }), world({ comments: answered, used: [TX] }), cfg), []);
});

test('a payment too recent to trust is retried silently', async () => {
  const asked = [bot('<!-- submission-fee:needed -->', 18)];
  const deps = { ...world({ comments: asked, receipts: { [TX]: paid } }), head: 110n };
  assert.deepEqual(await decide(pull({ body: TX }), deps, cfg), []);
});

test('the second of two hashes can be the payment', async () => {
  const actions = await decide(pull({ body: `${TX2} ${TX}` }), world({ receipts: { [TX]: paid } }), cfg);
  assert.ok(actions[0].body.includes(`tx=${TX}`));
});

test('unpaid after seven days: closed, and paying later reopens it', async () => {
  const asked = [bot('<!-- submission-fee:needed -->', 12)];
  const closing = await decide(pull({ labels: labelled(LABEL.needed) }), world({ comments: asked }), cfg);
  assert.deepEqual(types(closing), ['comment', 'close']);

  const closed = pull({ state: 'closed', closed_at: at(19), body: TX, labels: labelled(LABEL.needed) });
  const comments = [...asked, bot('<!-- submission-fee:closed-unpaid -->', 19)];
  const reopened = await decide(closed, world({ comments, receipts: { [TX]: paid } }), cfg);
  assert.deepEqual(types(reopened), ['reopen', 'comment', 'label']);
});

test('a pull request a person closed is decided, paid or not', async () => {
  const byPerson = pull({ state: 'closed', closed_at: at(5), body: TX });
  assert.deepEqual(await decide(byPerson, world({ receipts: { [TX]: paid } }), cfg), []);
  const paidThenClosed = pull({ state: 'closed', closed_at: at(5), labels: labelled(LABEL.paid) });
  assert.deepEqual(await decide(paidThenClosed, world(), cfg), []);
});

test('a merged paid pull request gets one refund notice', async () => {
  const receipt = [bot(`<!-- submission-fee:paid tx=${TX} from=${WALLET} -->`, 2)];
  const merged = pull({ state: 'closed', merged_at: at(3), closed_at: at(3), labels: labelled(LABEL.paid) });
  const actions = await decide(merged, world({ comments: receipt }), cfg);
  assert.deepEqual(types(actions), ['comment', 'label']);
  assert.ok(actions[0].body.includes(WALLET));
  assert.match(actions[0].body, /was merged/);
  assert.deepEqual(actions[1].add, [LABEL.refundDue]);

  const again = pull({ ...merged, labels: labelled(LABEL.paid, LABEL.refundDue) });
  assert.deepEqual(await decide(again, world({ comments: receipt }), cfg), []);
});

test('a paid pull request nobody decided in fourteen days gets a refund notice', async () => {
  const receipt = (days) => [bot(`<!-- submission-fee:paid tx=${TX} from=${WALLET} -->`, days)];
  const open = pull({ labels: labelled(LABEL.paid) });
  assert.deepEqual(await decide(open, world({ comments: receipt(10) }), cfg), []);
  const overdue = await decide(open, world({ comments: receipt(5) }), cfg);
  assert.match(overdue[0].body, /no maintainer decided it within 14 days/);
});

test('a pull request merged without the fee is left alone', async () => {
  const merged = pull({ state: 'closed', merged_at: at(3), closed_at: at(3) });
  assert.deepEqual(await decide(merged, world(), cfg), []);
});
