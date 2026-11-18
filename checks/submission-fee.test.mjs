import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  BOT,
  BURN_ADDRESS,
  LABEL,
  decide,
  exempt,
  hashesIn,
  paidRecord,
  paymentProblem,
  settings,
  show,
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
// `receipts` and `wallet` are Base's; `robinhood` holds the same two for Robinhood Chain.
const world = ({ comments = [], wallet = WALLET, receipts = {}, robinhood = {}, used = [], now = NOW, head = 1000n } = {}) => ({
  now,
  head: async () => head,
  used: new Set(used),
  comments: async () => comments,
  wallet: async (id, chain) => (chain === 'robinhood' ? (robinhood.wallet ?? null) : wallet),
  receipt: async (tx, chain) => (chain === 'robinhood' ? robinhood.receipts : receipts)?.[tx] ?? null,
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
    const parsed = settings(raw);
    assert.ok(parsed, 'an enabled settings file must be complete');
    assert.equal(parsed.options.length, 1 + (raw.alsoAccepted ?? []).length, 'every way to pay must be complete');
    // The address a contributor is told to pay, and each token and amount, must be the
    // ones written in the rules.
    const rules = readFileSync(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8');
    assert.ok(rules.toLowerCase().includes(raw.feeAddress.toLowerCase()));
    for (const way of parsed.options) {
      assert.ok(rules.includes(way.display), `CONTRIBUTING.md must name ${way.display}`);
      if (way.id !== 'usdc') assert.ok(rules.toLowerCase().includes(way.token), `CONTRIBUTING.md must name the ${way.display} token`);
    }
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

  const noWallet = await decide(
    pull({ body: TX }),
    world({ comments: [asked], receipts: { [TX]: paid }, wallet: null }),
    cfg,
  );
  assert.match(noWallet[0].body, /no Base wallet registered/);

  const nowhere = await decide(pull({ body: TX }), world({ comments: [asked] }), cfg);
  assert.match(nowhere[0].body, /not found on Base\./);

  const answered = [asked, bot(`<!-- submission-fee:rejected tx=${TX} -->`, 19)];
  assert.deepEqual(await decide(pull({ body: TX }), world({ comments: answered, used: [TX] }), cfg), []);
});

test('a payment too recent to trust is retried silently', async () => {
  const asked = [bot('<!-- submission-fee:needed -->', 18)];
  const deps = world({ comments: asked, receipts: { [TX]: paid }, head: 110n });
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

// ---- A second way to pay: SLOP on Robinhood Chain, burned when kept. ----

const SLOP = '0xfeb4e36fa4a2a494ff25ae4a63491e4c584a67ae';
const RC_WALLET = '0x00000000000000000000000000000000000000cc';
const SEVENTY_FIVE = 75n * 10n ** 18n;
const two = settings({
  enabled: true,
  feeAddress: FEE,
  refundWallet: FEE,
  startAt: '2026-12-01T00:00:00Z',
  token: USDC,
  amountMinor: '2000000',
  amountDisplay: '2 USDC',
  symbol: 'USDC',
  decimals: 6,
  alsoAccepted: [
    {
      id: 'slop',
      chain: 'robinhood',
      token: SLOP,
      amountMinor: SEVENTY_FIVE.toString(),
      amountDisplay: '75 SLOP',
      symbol: 'SLOP',
      decimals: 18,
      confirmations: 600,
      keptFees: 'burn',
      burnAfterDays: 7,
    },
  ],
});
const slopPaid = receiptOf(transfer(RC_WALLET, FEE, SEVENTY_FIVE, SLOP));
const slopNote = (days = 2) =>
  bot(`<!-- submission-fee:paid tx=${TX} from=${RC_WALLET} via=slop amt=${SEVENTY_FIVE} -->`, days);

test('a second way to pay is read from alsoAccepted; an incomplete one is left out', () => {
  assert.deepEqual(two.options.map((way) => [way.id, way.chain.key, way.kept]), [
    ['usdc', 'base', 'keep'],
    ['slop', 'robinhood', 'burn'],
  ]);
  assert.equal(two.options[1].amount, SEVENTY_FIVE);
  const broken = (extra) =>
    settings({ enabled: true, feeAddress: FEE, startAt: '2026-12-01T00:00:00Z', token: USDC, amountMinor: '2000000', alsoAccepted: [extra] });
  for (const extra of [
    { id: 'slop', chain: 'robinhood', token: SLOP },
    { id: 'slop', chain: 'moon', token: SLOP, amountMinor: '1' },
    { id: 'slop', chain: 'robinhood', token: '0x12', amountMinor: '1' },
    { id: 'usdc', chain: 'robinhood', token: SLOP, amountMinor: '1' },
    null,
  ])
    assert.deepEqual(broken(extra).options.map((way) => way.id), ['usdc']);
});

test('amounts are shown in words', () => {
  const [usdc, slop] = two.options;
  assert.equal(show(slop, SEVENTY_FIVE), '75 SLOP');
  assert.equal(show(slop, 100n * 10n ** 18n), '100 SLOP');
  assert.equal(show(slop, 125n * 10n ** 17n), '12.5 SLOP');
  assert.equal(show(usdc, 1_500_000n), '1.5 USDC');
  assert.equal(show(cfg.options[0], 1_500_000n), '1500000 base units');
  assert.equal(show(null, 1n), 'the fee');
});

test('the notice lists both ways to pay, and says a kept SLOP fee is burned', async () => {
  const [ask] = await decide(pull(), world(), two);
  assert.match(ask.body, /2 USDC on Base, or 75 SLOP on Robinhood Chain/);
  assert.ok(ask.body.includes(SLOP));
  assert.match(ask.body, /paid in SLOP is burned once the pull request has stayed closed for 7 days/);
});

test('SLOP on Robinhood Chain from the wallet registered there pays the fee', async () => {
  const deps = world({ robinhood: { wallet: RC_WALLET, receipts: { [TX]: slopPaid } } });
  const actions = await decide(pull({ body: TX }), deps, two);
  assert.deepEqual(types(actions), ['comment', 'label']);
  assert.ok(actions[0].body.includes(`tx=${TX} from=${RC_WALLET} via=slop amt=${SEVENTY_FIVE} -->`));
  assert.match(actions[0].body, /75 SLOP on Robinhood Chain/);
  assert.deepEqual(actions[1].add, [LABEL.paid]);
});

test('a SLOP payment that does not count says why', async () => {
  const asked = [bot('<!-- submission-fee:needed -->', 18)];
  const reason = async (robinhood) =>
    (await decide(pull({ body: TX }), world({ comments: asked, robinhood }), two))[0].body;
  assert.match(await reason({ receipts: { [TX]: slopPaid } }), /no Robinhood Chain wallet registered/);
  assert.match(await reason({ wallet: OTHER, receipts: { [TX]: slopPaid } }), /no transfer of at least 75 SLOP/);
  const short = receiptOf(transfer(RC_WALLET, FEE, SEVENTY_FIVE - 1n, SLOP));
  assert.match(await reason({ wallet: RC_WALLET, receipts: { [TX]: short } }), /no transfer of at least 75 SLOP/);
  // The right amount of another token on that chain is not the fee.
  const imitation = receiptOf(transfer(RC_WALLET, FEE, SEVENTY_FIVE, OTHER));
  assert.match(await reason({ wallet: RC_WALLET, receipts: { [TX]: imitation } }), /no transfer/);
  assert.match(await reason({}), /not found on Base or Robinhood Chain/);
  // The Base wallet is not asked about a Robinhood Chain payment, nor the other way round.
  const usdcOnRobinhood = receiptOf(transfer(WALLET, FEE, 2_000_000n));
  assert.match(await reason({ wallet: WALLET, receipts: { [TX]: usdcOnRobinhood } }), /no transfer of at least 75 SLOP/);
});

test('the payment note records the way paid and the amount; an older note means USDC', () => {
  const now = paidRecord([slopNote()], two);
  assert.deepEqual([now.tx, now.wallet, now.option.id, now.amount], [TX, RC_WALLET, 'slop', SEVENTY_FIVE]);
  const older = paidRecord([bot(`<!-- submission-fee:paid tx=${TX} from=${WALLET} -->`)], two);
  assert.deepEqual([older.option.id, older.amount], ['usdc', 2_000_000n]);
  assert.equal(paidRecord([slopNote()], cfg).option, null, 'a way the settings no longer list');
  assert.equal(paidRecord([author(slopNote().body)], two), null);
});

test('a merged pull request paid in SLOP is refunded what was paid then, whatever the fee is now', async () => {
  const dearer = settings({
    enabled: true, feeAddress: FEE, startAt: '2026-12-01T00:00:00Z', token: USDC, amountMinor: '2000000',
    alsoAccepted: [{ id: 'slop', chain: 'robinhood', token: SLOP, amountMinor: (100n * 10n ** 18n).toString(), amountDisplay: '100 SLOP', symbol: 'SLOP', decimals: 18 }],
  });
  const merged = pull({ state: 'closed', merged_at: at(3), closed_at: at(3), labels: labelled(LABEL.paid) });
  const [notice] = await decide(merged, world({ comments: [slopNote()] }), dearer);
  assert.match(notice.body, /\*\*Refund due:\*\* 75 SLOP to/);
  assert.ok(notice.body.includes(RC_WALLET));
});

test('a kept SLOP fee is marked for burning once the pull request has stayed closed seven days', async () => {
  const closed = (days, ...names) =>
    pull({ state: 'closed', closed_at: at(days), labels: labelled(LABEL.paid, ...names) });
  assert.deepEqual(await decide(closed(15), world({ comments: [slopNote()] }), two), [], 'five days closed');
  const due = await decide(closed(13), world({ comments: [slopNote()] }), two);
  assert.deepEqual(types(due), ['comment', 'label']);
  assert.match(due[0].body, /\*\*Fee to be burned:\*\* 75 SLOP/);
  assert.ok(due[0].body.includes(BURN_ADDRESS));
  assert.deepEqual(due[1].add, [LABEL.burnDue]);
  // Said once.
  assert.deepEqual(await decide(closed(13, LABEL.burnDue), world({ comments: [slopNote()] }), two), []);
  // A kept USDC fee stays in the fee wallet: nothing is burned.
  const usdcNote = bot(`<!-- submission-fee:paid tx=${TX} from=${WALLET} -->`, 2);
  assert.deepEqual(await decide(closed(5), world({ comments: [usdcNote] }), two), []);
});

test('reopening before the burn is signed calls it off; after, the burn stands and nothing is refunded', async () => {
  const signed = bot(`<!-- submission-fee:burn-sending pay=${TX} tx=${TX2} nonce=3 -->`, 14);
  const reopened = pull({ labels: labelled(LABEL.paid, LABEL.burnDue) });
  assert.deepEqual(await decide(reopened, world({ comments: [slopNote()] }), two), [
    { type: 'label', remove: [LABEL.burnDue] },
  ]);
  assert.deepEqual(await decide(reopened, world({ comments: [slopNote(), signed] }), two), []);

  const mergedAfter = (...names) =>
    pull({ state: 'closed', merged_at: at(18), closed_at: at(18), labels: labelled(LABEL.paid, ...names) });
  assert.deepEqual(await decide(mergedAfter(LABEL.burnDue), world({ comments: [slopNote(), signed] }), two), []);
  assert.deepEqual(await decide(mergedAfter(LABEL.burnDue, LABEL.burned), world({ comments: [slopNote(), signed] }), two), []);
  // Someone took the label off by hand: still no refund once a burn was signed.
  assert.deepEqual(await decide(mergedAfter(), world({ comments: [slopNote(), signed] }), two), []);
  // Reopened and merged before anything was signed: the label comes off, then the refund falls due.
  assert.deepEqual(types(await decide(mergedAfter(LABEL.burnDue), world({ comments: [slopNote()] }), two)), ['label']);
  assert.match((await decide(mergedAfter(), world({ comments: [slopNote()] }), two))[0].body, /Refund due/);
});
