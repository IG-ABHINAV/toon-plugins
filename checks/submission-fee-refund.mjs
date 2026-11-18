// Sends submission-fee refunds (CONTRIBUTING.md). `checks/submission-fee.mjs` decides
// when a refund is due and labels the pull request `fee-refund-due`; this script sends
// the USDC back on Base from the wallet named `refundWallet` in
// `.github/submission-fee.json`, then labels the pull request `fee-refunded`.
//
// It runs only when that settings field is set, in the workflow job that holds the
// wallet's key. The key is read by `checks/refund/sign.mjs` and nowhere else.
//
// The rule that bounds it: a refund goes only to the wallet that sent a fee payment this
// script has checked on chain itself, at most once for each payment, and never for more
// than was paid. A label or a comment alone moves nothing. So the most this wallet can
// ever send out is what was paid in.
//
// Sending twice is prevented without trusting a run to finish. The refund transaction is
// signed first, its hash is written to the pull request (`refund-sending`), and only then
// is it broadcast. A later run that finds that note looks the hash up: mined means sent;
// not mined with the wallet's nonce unused means the same nonce is signed again, and one
// nonce can only ever be spent once.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  LABEL,
  PAID_MARK,
  find,
  github,
  has,
  mark,
  ours,
  paymentProblem,
  rpc,
  settings,
  topicFor,
} from './submission-fee.mjs';

const TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const BASE_CHAIN_ID = 8453;
/** Refund transactions one pull request may have before a person has to look. */
export const MAX_ATTEMPTS = 4;
/** Refunds one run sends. The next run, 15 minutes later, takes the rest. */
export const MAX_PER_RUN = 5;
/** How long an unmined refund whose nonce was spent elsewhere is left before a new one. */
export const DEAD_AFTER = 30 * 60 * 1000;

export const refundMark = {
  sending: (pay, tx, nonce) =>
    `<!-- submission-fee:refund-sending pay=${pay} tx=${tx} nonce=${nonce} -->`,
  sent: (pay, tx) => `<!-- submission-fee:refund-sent pay=${pay} tx=${tx} -->`,
  held: '<!-- submission-fee:refund-held -->',
};
const SENDING = /<!-- submission-fee:refund-sending pay=(0x[0-9a-f]{64}) tx=(0x[0-9a-f]{64}) nonce=([0-9]+) -->/;
const SENT = /<!-- submission-fee:refund-sent pay=(0x[0-9a-f]{64}) tx=(0x[0-9a-f]{64}) -->/;

const numberOf = (comment) => Number(comment.issue_url?.match(/\/issues\/([0-9]+)$/)?.[1]);

/**
 * What this script's own comments across the repository record: `paidOn` maps each
 * accepted payment to the first pull request it paid for, `refunded` holds every payment
 * already sent back, and `started` maps each pull request with a refund transaction
 * signed but not recorded as sent to the lowest nonce it used. `comments` must be oldest
 * first.
 */
export function ledger(comments) {
  const paidOn = new Map();
  const refunded = new Set();
  const signed = [];
  for (const comment of ours(comments)) {
    const paid = comment.body.match(PAID_MARK)?.[1];
    if (paid && !paidOn.has(paid)) paidOn.set(paid, numberOf(comment));
    const sent = comment.body.match(SENT)?.[1];
    if (sent) refunded.add(sent);
    const sending = comment.body.match(SENDING);
    if (sending) signed.push({ pay: sending[1], nonce: Number(sending[3]), number: numberOf(comment) });
  }
  const started = new Map();
  for (const { pay, nonce, number } of signed)
    if (!refunded.has(pay)) started.set(number, Math.min(nonce, started.get(number) ?? nonce));
  return { paidOn, refunded, started };
}

/**
 * The order to work through refunds in: first the ones an earlier run started, lowest
 * nonce first, so a transaction that is holding a nonce is settled before a new refund
 * needs the next one.
 */
export function inOrder(due, started) {
  const rank = (issue) => (started.has(issue.number) ? started.get(issue.number) : Infinity);
  return [...due].sort((a, b) => rank(a) - rank(b) || a.number - b.number);
}

/**
 * How much of the fee `receipt` moved from `wallet` to the fee address, never more than
 * the fee itself. A payment above the fee is refunded up to the fee; the rest is for a
 * person.
 */
export function paidAmount(receipt, wallet, cfg) {
  const log = (receipt?.logs ?? []).find(
    (entry) =>
      entry.address?.toLowerCase() === cfg.token &&
      entry.topics?.length === 3 &&
      entry.topics[0] === TRANSFER &&
      entry.topics[1].toLowerCase() === topicFor(wallet) &&
      entry.topics[2].toLowerCase() === topicFor(cfg.feeAddress) &&
      BigInt(entry.data) >= cfg.amount,
  );
  return log ? cfg.amount : 0n;
}

/** `transfer(to, amount)` on an ERC-20, as call data. */
export function transferData(to, amount) {
  return `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;
}

/** Whether `receipt` is a successful transfer of `amount` of the fee token to `wallet`. */
function refundLanded(receipt, wallet, amount, cfg) {
  return (
    receipt?.status === '0x1' &&
    (receipt.logs ?? []).some(
      (entry) =>
        entry.address?.toLowerCase() === cfg.token &&
        entry.topics?.[0] === TRANSFER &&
        entry.topics[1]?.toLowerCase() === topicFor(cfg.refundWallet) &&
        entry.topics[2]?.toLowerCase() === topicFor(wallet) &&
        BigInt(entry.data) === amount,
    )
  );
}

const hold = (reason) => ({ status: 'held', reason });

/**
 * Sends the refund for one pull request, or finishes one an earlier run started. `pr` is
 * the issue record of a pull request labelled `fee-refund-due`.
 *
 * `deps` supplies `comments(number)`, `receipt(hash)`, `block(number)`, the newest block
 * `head`, the time `now`, the `ledger`, `nonce()` (the wallet's next unused nonce among
 * mined transactions), `funds(amount)` (null, or why the wallet cannot pay),
 * `sign({ to, amount, nonce })` giving `{ raw, hash }`, `broadcast(raw)`,
 * `mined(hash)` (the receipt once mined, null if not within the wait), and
 * `comment(number, body)`.
 *
 * Returns `{ status }`: `sent` (with `tx`), `pending` (broadcast, not mined yet), `retry`
 * (nothing owed changed; try next run), or `held` (with `reason`; a person must look).
 * `inFlight` is set when a transaction was signed this run and is not known to be mined
 * or failed, so the caller sends nothing more: the next refund would need its nonce.
 */
export async function refund(pr, deps, cfg) {
  const comments = await deps.comments(pr.number);
  const paid = ours(comments).find((comment) => PAID_MARK.test(comment.body));
  if (!paid) return hold('this pull request has no record of a fee payment');
  const [, pay, wallet] = paid.body.match(PAID_MARK);

  const done = ours(comments).find((comment) => comment.body.match(SENT)?.[1] === pay);
  if (done) return { status: 'sent', tx: done.body.match(SENT)[2], already: true };
  if (deps.ledger.refunded.has(pay)) return hold('this payment was already refunded on another pull request');
  if (deps.ledger.paidOn.get(pay) !== pr.number) return hold('this payment was accepted for another pull request');

  // Is it due? Decided here again, from the pull request and the dates, not from the label.
  const merged = Boolean(pr.pull_request?.merged_at);
  const lapsed =
    Boolean(find(comments, mark.refund)) &&
    deps.now - Date.parse(paid.created_at) >= cfg.refundUndecidedAfter;
  if (!merged && !lapsed) return hold('this pull request is neither merged nor undecided for long enough');

  // Was it paid? Read from Base again, not from the comment.
  const receipt = await deps.receipt(pay);
  const block = receipt ? await deps.block(receipt.blockNumber) : null;
  const problem = paymentProblem({ receipt, block, head: deps.head, wallet, cfg });
  if (problem) return hold(`the fee payment does not check out: ${problem}`);
  const amount = paidAmount(receipt, wallet, cfg);
  if (amount <= 0n) return hold('the fee payment does not check out');

  // Refund transactions an earlier run signed for this payment.
  const attempts = ours(comments)
    .map((comment) => ({ match: comment.body.match(SENDING), at: Date.parse(comment.created_at) }))
    .filter(({ match }) => match?.[1] === pay)
    .map(({ match, at }) => ({ tx: match[2], nonce: Number(match[3]), at }));

  const finish = async (tx) => {
    await deps.comment(
      pr.number,
      `${refundMark.sent(pay, tx)}\n**Refund sent:** ${cfg.display} to \`${wallet}\` in \`${tx}\`.`,
    );
    deps.ledger.refunded.add(pay);
    return { status: 'sent', tx };
  };

  let open = null; // an attempt that could still be mined
  for (const attempt of attempts) {
    const outcome = await deps.receipt(attempt.tx);
    if (refundLanded(outcome, wallet, amount, cfg)) return finish(attempt.tx);
    if (outcome) continue; // mined and failed: it moved nothing, and its nonce is spent
    open = attempt;
  }

  let nonce = await deps.nonce();
  if (open) {
    if (open.nonce > nonce) return { status: 'retry', why: 'an earlier transaction from the wallet is not mined yet' };
    if (open.nonce < nonce) {
      // Its nonce was spent by another transaction, so it can never be mined. Wait a
      // while first, in case the node answering is behind.
      if (deps.now - open.at < DEAD_AFTER) return { status: 'retry', why: 'waiting to be sure an earlier refund transaction is dead' };
    } else {
      nonce = open.nonce; // same nonce again: at most one of the two can ever be mined
    }
  }
  if (attempts.length >= MAX_ATTEMPTS) return hold(`${attempts.length} refund transactions did not go through`);

  const short = await deps.funds(amount);
  if (short) return hold(`the refund wallet cannot pay: ${short}`);

  const signed = await deps.sign({ to: wallet, amount, nonce });
  if (!attempts.some((attempt) => attempt.tx === signed.hash))
    await deps.comment(pr.number, refundMark.sending(pay, signed.hash, nonce));
  try {
    await deps.broadcast(signed.raw);
  } catch (error) {
    return { status: 'retry', inFlight: true, why: `Base did not accept the transaction: ${error.message}` };
  }
  const outcome = await deps.mined(signed.hash);
  if (!outcome) return { status: 'pending', inFlight: true, tx: signed.hash };
  if (refundLanded(outcome, wallet, amount, cfg)) return finish(signed.hash);
  return { status: 'retry', why: 'the refund transaction failed on Base' };
}

// ---- Everything below talks to GitHub and Base. ----

async function main() {
  const file =
    process.env.SUBMISSION_FEE_CONFIG ||
    fileURLToPath(new URL('../.github/submission-fee.json', import.meta.url));
  const repo = process.env.GITHUB_REPOSITORY;
  const cfg = settings(JSON.parse(readFileSync(file, 'utf8')), repo);
  if (!cfg) return console.log('The submission fee is off (.github/submission-fee.json).');
  if (!cfg.refundWallet)
    return console.log('Automatic refunds are off: the settings name no refundWallet.');

  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  if (!process.env.REFUND_WALLET_KEY)
    throw new Error('The settings name a refundWallet, but this job has no REFUND_WALLET_KEY.');
  const dryRun = process.env.DRY_RUN === '1';
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  const call = (method, params = []) => rpc(rpcUrl, method, params);

  const { signer } = await import('./refund/sign.mjs');
  const wallet = signer(process.env.REFUND_WALLET_KEY);
  if (wallet.address !== cfg.refundWallet)
    throw new Error('REFUND_WALLET_KEY is not the key of the refundWallet in the settings.');
  if (Number(BigInt(await call('eth_chainId'))) !== BASE_CHAIN_ID)
    throw new Error('The endpoint is not Base mainnet.');

  const api = github(repo, token);
  if (!dryRun)
    for (const name of [LABEL.refunded, LABEL.refundCheck])
      await api.json('POST', '/labels', { name, color: 'c9a24a' }, [422]);

  const since = new Date(cfg.startAt).toISOString();
  const all = await api.pages(`/issues/comments?since=${since}&sort=created&direction=asc&per_page=100`, 50);
  const due = (
    await api.pages(`/issues?labels=${encodeURIComponent(LABEL.refundDue)}&state=all&per_page=100`)
  ).filter((issue) => !has(issue, LABEL.refunded) && !has(issue, LABEL.refundCheck));

  const from = cfg.refundWallet;
  const usdc = async () =>
    BigInt(await call('eth_call', [{ to: cfg.token, data: `0x70a08231${from.slice(2).padStart(64, '0')}` }, 'latest']));
  console.log(
    `Refund wallet ${from}: key matches, ${await usdc()} USDC base units, ${BigInt(await call('eth_getBalance', [from, 'latest']))} wei for gas, ${due.length} refund(s) waiting.`,
  );
  const fees = async () => {
    const price = BigInt(await call('eth_gasPrice'));
    const tip = price / 10n > 1_000_000n ? price / 10n : 1_000_000n;
    return { maxFeePerGas: price * 2n + tip, maxPriorityFeePerGas: tip };
  };
  const gasFor = async (to, amount) =>
    (BigInt(await call('eth_estimateGas', [{ from, to: cfg.token, data: transferData(to, amount) }])) * 3n) / 2n;

  const deps = {
    now: Date.now(),
    head: BigInt(await call('eth_blockNumber')),
    ledger: ledger(all),
    comments: (number) => api.pages(`/issues/${number}/comments?per_page=100`),
    receipt: (tx) => call('eth_getTransactionReceipt', [tx]),
    block: (number) => call('eth_getBlockByNumber', [number, false]),
    nonce: async () => Number(BigInt(await call('eth_getTransactionCount', [from, 'latest']))),
    funds: async (amount) => {
      if ((await usdc()) < amount) return 'it holds too little USDC';
      const { maxFeePerGas } = await fees();
      const ether = BigInt(await call('eth_getBalance', [from, 'latest']));
      return ether < 100_000n * maxFeePerGas ? 'it holds too little ETH for gas' : null;
    },
    sign: async ({ to, amount, nonce }) =>
      wallet.transfer({
        token: cfg.token,
        to,
        amount,
        nonce,
        gas: await gasFor(to, amount),
        chainId: BASE_CHAIN_ID,
        ...(await fees()),
      }),
    broadcast: async (raw) => {
      if (dryRun) return;
      await call('eth_sendRawTransaction', [raw]);
    },
    mined: async (hash) => {
      if (dryRun) return null;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const receipt = await call('eth_getTransactionReceipt', [hash]);
        if (receipt) return receipt;
      }
      return null;
    },
    comment: async (number, body) => {
      console.log(`#${number} comment: ${body.split('\n').at(-1).replace(/<!--.*?-->/g, 'refund note')}`);
      if (!dryRun) await api.json('POST', `/issues/${number}/comments`, { body });
    },
  };
  const label = async (number, name) => {
    if (!dryRun) await api.json('POST', `/issues/${number}/labels`, { labels: [name] });
  };

  let failed = false;
  let sent = 0;
  for (const pr of inOrder(due, deps.ledger.started)) {
    if (!pr.pull_request) continue;
    if (sent >= MAX_PER_RUN) {
      console.log(`Stopping at ${MAX_PER_RUN} refunds; the next run takes the rest.`);
      break;
    }
    let result;
    try {
      result = await refund(pr, deps, cfg);
    } catch (error) {
      failed = true;
      console.error(`#${pr.number} skipped: ${error.message}`);
      continue;
    }
    if (result.status === 'sent') {
      await label(pr.number, LABEL.refunded);
      if (!result.already) sent += 1;
      console.log(`#${pr.number} refunded in ${result.tx}`);
    } else if (result.status === 'held') {
      failed = true;
      console.error(`#${pr.number} needs a person: ${result.reason}`);
      await deps.comment(
        pr.number,
        `${refundMark.held}\n**Refund not sent automatically:** ${result.reason}. A maintainer will look at it. Removing the \`${LABEL.refundCheck}\` label makes the workflow try again.`,
      );
      await label(pr.number, LABEL.refundCheck);
    } else {
      console.log(`#${pr.number} ${result.status}: ${result.why ?? result.tx}`);
      // One transaction in flight at a time: the next refund would need the next nonce.
      if (result.inFlight) break;
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
