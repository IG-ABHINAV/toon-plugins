// Sends what the submission fee owes (CONTRIBUTING.md). `checks/submission-fee.mjs`
// decides when a refund or a burn is due and labels the pull request `fee-refund-due` or
// `fee-burn-due`; this script sends the fee back to the wallet that paid, or sends a kept
// fee to the burn address, from the wallet named `refundWallet` in
// `.github/submission-fee.json`, on the chain the fee was paid on. Then it labels the
// pull request `fee-refunded` or `fee-burned`.
//
// It runs only when that settings field is set, in the workflow job that holds the
// wallet's key. The key is read by `checks/refund/sign.mjs` and nowhere else.
//
// The rule that bounds it: for each fee payment this script has checked on chain itself
// it sends at most one transfer, of the fee recorded when the payment was accepted and
// never more than was paid, either back to the wallet that paid or, for a way to pay
// whose kept fees are burned, to the burn address. A label or a comment alone moves
// nothing. So the most this wallet can ever send out is what was paid in.
//
// Sending twice is prevented without trusting a run to finish. The transaction is signed
// first, its hash is written to the pull request (`refund-sending` or `burn-sending`),
// and only then is it broadcast. A later run that finds that note looks the hash up:
// mined means sent; not mined with the wallet's nonce unused means the same nonce is
// signed again, and one nonce can only ever be spent once.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BURN_ADDRESS,
  CHAINS,
  LABEL,
  PAID_MARK,
  endpoint,
  find,
  github,
  has,
  mark,
  ours,
  paidRecord,
  paymentProblem,
  rpc,
  settings,
  show,
  topicFor,
} from './submission-fee.mjs';

const TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** Transactions one pull request may have before a person has to look. */
export const MAX_ATTEMPTS = 4;
/** Transfers one run sends. The next run, 15 minutes later, takes the rest. */
export const MAX_PER_RUN = 5;
/** How long an unmined transaction whose nonce was spent elsewhere is left before a new one. */
export const DEAD_AFTER = 30 * 60 * 1000;

const notes = (kind) => ({
  kind,
  sending: (pay, tx, nonce) => `<!-- submission-fee:${kind}-sending pay=${pay} tx=${tx} nonce=${nonce} -->`,
  sent: (pay, tx) => `<!-- submission-fee:${kind}-sent pay=${pay} tx=${tx} -->`,
  SENDING: new RegExp(`<!-- submission-fee:${kind}-sending pay=(0x[0-9a-f]{64}) tx=(0x[0-9a-f]{64}) nonce=([0-9]+) -->`),
  SENT: new RegExp(`<!-- submission-fee:${kind}-sent pay=(0x[0-9a-f]{64}) tx=(0x[0-9a-f]{64}) -->`),
});
const REFUND = notes('refund');
const BURN = notes('burn');
export const refundMark = { sending: REFUND.sending, sent: REFUND.sent, held: '<!-- submission-fee:refund-held -->' };
export const burnMark = { sending: BURN.sending, sent: BURN.sent };

const numberOf = (comment) => Number(comment.issue_url?.match(/\/issues\/([0-9]+)$/)?.[1]);

/**
 * What this script's own comments across the repository record: `paidOn` maps each
 * accepted payment to the first pull request it paid for, `refunded` and `burned` hold
 * every payment already sent back or burned, and `started` maps each pull request with a
 * transaction signed but not recorded as sent to the lowest nonce it used. `comments`
 * must be oldest first.
 */
export function ledger(comments) {
  const paidOn = new Map();
  const refunded = new Set();
  const burned = new Set();
  const signed = [];
  for (const comment of ours(comments)) {
    const paid = comment.body.match(PAID_MARK)?.[1];
    if (paid && !paidOn.has(paid)) paidOn.set(paid, numberOf(comment));
    for (const [kind, done] of [[REFUND, refunded], [BURN, burned]]) {
      const sent = comment.body.match(kind.SENT)?.[1];
      if (sent) done.add(sent);
      const sending = comment.body.match(kind.SENDING);
      if (sending) signed.push({ pay: sending[1], nonce: Number(sending[3]), number: numberOf(comment) });
    }
  }
  const started = new Map();
  for (const { pay, nonce, number } of signed)
    if (!refunded.has(pay) && !burned.has(pay))
      started.set(number, Math.min(nonce, started.get(number) ?? nonce));
  return { paidOn, refunded, burned, started };
}

/**
 * The order to work through pull requests in: first the ones an earlier run started,
 * lowest nonce first, so a transaction that is holding a nonce is settled before a new
 * one needs the next.
 */
export function inOrder(due, started) {
  const rank = (issue) => (started.has(issue.number) ? started.get(issue.number) : Infinity);
  return [...due].sort((a, b) => rank(a) - rank(b) || a.number - b.number);
}

/** `transfer(to, amount)` on an ERC-20, as call data. */
export function transferData(to, amount) {
  return `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;
}

/** Whether `receipt` is a successful transfer of exactly `amount` of `token` from the refund wallet to `to`. */
function landed(receipt, to, amount, token, cfg) {
  return (
    receipt?.status === '0x1' &&
    (receipt.logs ?? []).some(
      (entry) =>
        entry.address?.toLowerCase() === token &&
        entry.topics?.[0] === TRANSFER &&
        entry.topics[1]?.toLowerCase() === topicFor(cfg.refundWallet) &&
        entry.topics[2]?.toLowerCase() === topicFor(to) &&
        BigInt(entry.data) === amount,
    )
  );
}

const hold = (reason) => ({ status: 'held', reason });

/**
 * Sends the refund or the burn for one pull request, or finishes one an earlier run
 * started. `pr` is the issue record of a pull request labelled `fee-refund-due` or
 * `fee-burn-due`.
 *
 * Which of the two is decided here again, from the pull request and the dates, not from
 * the label: a refund when it was merged or went undecided for long enough; a burn when
 * the fee was paid a way whose kept fees are burned and the pull request has stayed
 * closed, unmerged, for that way's waiting time. A burn that an earlier run signed is
 * always finished, and a payment with a burn started is never refunded.
 *
 * `deps` supplies `comments(number)`, the time `now`, the `ledger`, `comment(number,
 * body)`, the set `busy` of chains with a transaction still in flight this run, and
 * `chain(key)`, which gives for one chain: `receipt(hash)`, `block(number)`, `head()`,
 * `nonce()` (the wallet's next unused nonce among mined transactions), `funds(option,
 * amount)` (null, or why the wallet cannot pay), `sign({ token, to, amount, nonce })`
 * giving `{ raw, hash }`, `broadcast(raw)`, and `mined(hash)` (the receipt once mined,
 * null if not within the wait).
 *
 * Returns `{ status }`: `sent` (with `tx` and `kind`, `refund` or `burn`), `pending`
 * (broadcast, not mined yet), `retry` (nothing changed; try next run), or `held` (with
 * `reason`; a person must look). `inFlight` names the chain when a transaction was signed
 * this run and is not known to be mined or failed, so the caller sends nothing more
 * there: the next transfer would need its nonce.
 */
export async function settle(pr, deps, cfg) {
  const comments = await deps.comments(pr.number);
  const paid = paidRecord(comments, cfg);
  if (!paid) return hold('this pull request has no record of a fee payment');
  const { tx: pay, wallet, option, amount } = paid;
  const mine = ours(comments);

  for (const kind of [REFUND, BURN]) {
    const done = mine.find((comment) => comment.body.match(kind.SENT)?.[1] === pay);
    if (done) return { status: 'sent', kind: kind.kind, tx: done.body.match(kind.SENT)[2], already: true };
  }
  if (deps.ledger.refunded.has(pay)) return hold('this payment was already refunded on another pull request');
  if (deps.ledger.burned.has(pay)) return hold('this payment was already burned on another pull request');
  if (deps.ledger.paidOn.get(pay) !== pr.number) return hold('this payment was accepted for another pull request');
  if (!option) return hold('this fee was paid a way the settings no longer list');

  // Transactions an earlier run signed for this payment.
  const attemptsOf = (kind) =>
    mine
      .map((comment) => ({ match: comment.body.match(kind.SENDING), at: Date.parse(comment.created_at) }))
      .filter(({ match }) => match?.[1] === pay)
      .map(({ match, at }) => ({ tx: match[2], nonce: Number(match[3]), at }));
  const burns = attemptsOf(BURN);
  const refunds = attemptsOf(REFUND);
  if (burns.length && refunds.length) return hold('both a refund and a burn were started for this payment');

  // What is due? Decided here again, from the pull request and the dates, not from the label.
  const merged = Boolean(pr.pull_request?.merged_at);
  const lapsed = Boolean(find(comments, mark.refund)) && deps.now - paid.at >= cfg.refundUndecidedAfter;
  const closedFor =
    pr.state === 'closed' && !merged && pr.closed_at ? deps.now - Date.parse(pr.closed_at) : -1;
  let kind;
  if (burns.length) kind = BURN;
  else if (merged || lapsed) kind = REFUND;
  else if (option.kept === 'burn' && closedFor >= option.burnAfter) kind = BURN;
  else if (has(pr, LABEL.burnDue) && !has(pr, LABEL.refundDue))
    // Reopened since it was labelled. The fee check takes the label off on its next run.
    return { status: 'retry', why: 'no longer closed for long enough to burn the fee' };
  else return hold('this pull request is neither merged nor undecided for long enough');
  const burning = kind === BURN;
  const to = burning ? BURN_ADDRESS : wallet;
  const attempts = burning ? burns : refunds;

  const key = option.chain.key;
  if (deps.busy?.has(key))
    return { status: 'retry', why: `an earlier transaction on ${option.chain.name} is not settled yet` };
  const chain = deps.chain(key);

  // Was it paid? Read from the chain again, not from the comment.
  const receipt = await chain.receipt(pay);
  const block = receipt ? await chain.block(receipt.blockNumber) : null;
  const problem = paymentProblem({ receipt, block, head: await chain.head(), wallet, cfg, option, amount });
  if (problem) return hold(`the fee payment does not check out: ${problem}`);

  const finish = async (tx) => {
    await deps.comment(
      pr.number,
      burning
        ? `${BURN.sent(pay, tx)}\n**Fee burned:** ${show(option, amount)} sent to the burn address \`${BURN_ADDRESS}\` in \`${tx}\`.`
        : `${REFUND.sent(pay, tx)}\n**Refund sent:** ${show(option, amount)} to \`${wallet}\` in \`${tx}\`.`,
    );
    (burning ? deps.ledger.burned : deps.ledger.refunded).add(pay);
    return { status: 'sent', kind: kind.kind, tx };
  };

  let open = null; // an attempt that could still be mined
  for (const attempt of attempts) {
    const outcome = await chain.receipt(attempt.tx);
    if (landed(outcome, to, amount, option.token, cfg)) return finish(attempt.tx);
    if (outcome) continue; // mined and failed: it moved nothing, and its nonce is spent
    open = attempt;
  }

  let nonce = await chain.nonce();
  if (open) {
    if (open.nonce > nonce) return { status: 'retry', why: 'an earlier transaction from the wallet is not mined yet' };
    if (open.nonce < nonce) {
      // Its nonce was spent by another transaction, so it can never be mined. Wait a
      // while first, in case the node answering is behind.
      if (deps.now - open.at < DEAD_AFTER) return { status: 'retry', why: 'waiting to be sure an earlier transaction is dead' };
    } else {
      nonce = open.nonce; // same nonce again: at most one of the two can ever be mined
    }
  }
  if (attempts.length >= MAX_ATTEMPTS) return hold(`${attempts.length} ${kind.kind} transactions did not go through`);

  const short = await chain.funds(option, amount);
  if (short) return hold(`the refund wallet cannot pay: ${short}`);

  const signed = await chain.sign({ token: option.token, to, amount, nonce });
  if (!attempts.some((attempt) => attempt.tx === signed.hash))
    await deps.comment(pr.number, kind.sending(pay, signed.hash, nonce));
  try {
    await chain.broadcast(signed.raw);
  } catch (error) {
    return { status: 'retry', inFlight: key, why: `${option.chain.name} did not accept the transaction: ${error.message}` };
  }
  const outcome = await chain.mined(signed.hash);
  if (!outcome) return { status: 'pending', inFlight: key, tx: signed.hash };
  if (landed(outcome, to, amount, option.token, cfg)) return finish(signed.hash);
  return { status: 'retry', why: `the ${kind.kind} transaction failed on ${option.chain.name}` };
}

// ---- Everything below talks to GitHub and the chains. ----

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

  const { signer } = await import('./refund/sign.mjs');
  const wallet = signer(process.env.REFUND_WALLET_KEY);
  if (wallet.address !== cfg.refundWallet)
    throw new Error('REFUND_WALLET_KEY is not the key of the refundWallet in the settings.');
  const from = cfg.refundWallet;

  // One set of calls for each chain, made when first needed. Nothing is read from or
  // signed for a chain until its endpoint has said it is that chain.
  const chains = new Map();
  const chain = (key) => {
    if (chains.has(key)) return chains.get(key);
    const info = CHAINS[key];
    const call = (method, params = []) => rpc(endpoint(info), method, params, info.name);
    let checked = null;
    let head = null;
    const ready = () =>
      (checked ??= call('eth_chainId').then((id) => {
        if (Number(BigInt(id)) !== info.chainId) throw new Error(`The endpoint is not ${info.name} mainnet.`);
      }));
    const balance = async (asset) =>
      BigInt(await call('eth_call', [{ to: asset, data: `0x70a08231${from.slice(2).padStart(64, '0')}` }, 'latest']));
    const ether = async () => BigInt(await call('eth_getBalance', [from, 'latest']));
    const fees = async () => {
      const price = BigInt(await call('eth_gasPrice'));
      const tip = price / 10n > 1_000_000n ? price / 10n : 1_000_000n;
      return { maxFeePerGas: price * 2n + tip, maxPriorityFeePerGas: tip };
    };
    const made = {
      balance,
      ether,
      head: async () => {
        await ready();
        head ??= BigInt(await call('eth_blockNumber'));
        return head;
      },
      receipt: (tx) => call('eth_getTransactionReceipt', [tx]),
      block: (number) => call('eth_getBlockByNumber', [number, false]),
      nonce: async () => Number(BigInt(await call('eth_getTransactionCount', [from, 'latest']))),
      funds: async (option, amount) => {
        if ((await balance(option.token)) < amount) return `it holds too little ${option.symbol ?? 'of the fee token'}`;
        const { maxFeePerGas } = await fees();
        return (await ether()) < 100_000n * maxFeePerGas ? `it holds too little ETH for gas on ${info.name}` : null;
      },
      sign: async ({ token: asset, to, amount, nonce }) => {
        await ready();
        const gas =
          (BigInt(await call('eth_estimateGas', [{ from, to: asset, data: transferData(to, amount) }])) * 3n) / 2n;
        return wallet.transfer({ token: asset, to, amount, nonce, gas, chainId: info.chainId, ...(await fees()) });
      },
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
    };
    chains.set(key, made);
    return made;
  };

  const api = github(repo, token);
  if (!dryRun)
    for (const name of [LABEL.refunded, LABEL.burned, LABEL.refundCheck])
      await api.json('POST', '/labels', { name, color: 'c9a24a' }, [422]);

  const since = new Date(cfg.startAt).toISOString();
  const all = await api.pages(`/issues/comments?since=${since}&sort=created&direction=asc&per_page=100`, 50);
  const due = new Map();
  for (const [wanted, done] of [[LABEL.refundDue, LABEL.refunded], [LABEL.burnDue, LABEL.burned]])
    for (const issue of await api.pages(`/issues?labels=${encodeURIComponent(wanted)}&state=all&per_page=100`))
      if (!has(issue, done) && !has(issue, LABEL.refundCheck)) due.set(issue.number, issue);

  console.log(`Refund wallet ${from}: key matches, ${due.size} refund(s) or burn(s) waiting.`);
  // What the wallet holds on each chain. An endpoint that does not answer is only noted
  // here: anything owed on that chain fails below and is tried again on the next run.
  for (const option of cfg.options) {
    try {
      const on = chain(option.chain.key);
      await on.head();
      console.log(
        `  ${option.chain.name}: ${await on.balance(option.token)} base units of ${option.symbol ?? option.token}, ${await on.ether()} wei for gas.`,
      );
    } catch (error) {
      console.error(`  ${option.chain.name}: not read (${error.message}).`);
    }
  }

  const deps = {
    now: Date.now(),
    ledger: ledger(all),
    busy: new Set(),
    chain,
    comments: (number) => api.pages(`/issues/${number}/comments?per_page=100`),
    comment: async (number, body) => {
      console.log(`#${number} comment: ${body.split('\n').at(-1).replace(/<!--.*?-->/g, 'sending note')}`);
      if (!dryRun) await api.json('POST', `/issues/${number}/comments`, { body });
    },
  };
  const label = async (number, name) => {
    if (!dryRun) await api.json('POST', `/issues/${number}/labels`, { labels: [name] });
  };

  let failed = false;
  let sent = 0;
  for (const pr of inOrder([...due.values()], deps.ledger.started)) {
    if (!pr.pull_request) continue;
    if (sent >= MAX_PER_RUN) {
      console.log(`Stopping at ${MAX_PER_RUN} transfers; the next run takes the rest.`);
      break;
    }
    let result;
    try {
      result = await settle(pr, deps, cfg);
    } catch (error) {
      failed = true;
      console.error(`#${pr.number} skipped: ${error.message}`);
      continue;
    }
    if (result.status === 'sent') {
      const burned = result.kind === 'burn';
      await label(pr.number, burned ? LABEL.burned : LABEL.refunded);
      if (!result.already) sent += 1;
      console.log(`#${pr.number} ${burned ? 'burned' : 'refunded'} in ${result.tx}`);
    } else if (result.status === 'held') {
      failed = true;
      console.error(`#${pr.number} needs a person: ${result.reason}`);
      await deps.comment(
        pr.number,
        `${refundMark.held}\n**Not sent automatically:** ${result.reason}. A maintainer will look at it. Removing the \`${LABEL.refundCheck}\` label makes the workflow try again.`,
      );
      await label(pr.number, LABEL.refundCheck);
    } else {
      console.log(`#${pr.number} ${result.status}: ${result.why ?? result.tx}`);
      // One transaction in flight at a time on each chain: the next would need the next nonce.
      if (result.inFlight) deps.busy.add(result.inFlight);
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
