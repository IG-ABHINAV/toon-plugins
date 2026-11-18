// The submission fee (CONTRIBUTING.md). A pull request from an outside contributor
// needs a small USDC fee on Base, sent from the wallet its author registered on
// slop.cash to the address in `.github/submission-fee.json`. This script reads the open
// pull requests, checks each payment on chain, and labels, comments, closes or reopens.
//
// It moves no money. A refund is a "refund due" comment; a person sends it.
//
// Run by `.github/workflows/submission-fee.yml` on a schedule with the repository's own
// token. It never checks out or runs a pull request's code. Text from a pull request is
// only ever searched for transaction hashes; nothing from it reaches a shell.
//
// What it trusts:
//   - labels, which only people with triage rights can set;
//   - its own comments, recognised by the author `github-actions[bot]`, never by text
//     alone, since anyone can paste a marker into a comment;
//   - a `Transfer` log emitted by the USDC contract itself.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LABEL = { paid: 'fee-paid', needed: 'fee-needed', refundDue: 'fee-refund-due' };
export const BOT = 'github-actions[bot]';
const TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DAY = 24 * 60 * 60 * 1000;
const EXEMPT = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const mark = {
  needed: '<!-- submission-fee:needed -->',
  closed: '<!-- submission-fee:closed-unpaid -->',
  refund: '<!-- submission-fee:refund-due -->',
  paid: (tx, from) => `<!-- submission-fee:paid tx=${tx} from=${from} -->`,
  rejected: (tx) => `<!-- submission-fee:rejected tx=${tx} -->`,
};
const PAID_MARK = /<!-- submission-fee:paid tx=(0x[0-9a-f]{64}) from=(0x[0-9a-f]{40}) -->/;

const address = (value) => /^0x[0-9a-fA-F]{40}$/.test(value ?? '');

/**
 * The settings in `.github/submission-fee.json`, or `null` when the fee is off. It is
 * off unless `enabled` is true and the address, start time and amount are all valid, so a
 * half-filled file does nothing.
 */
export function settings(raw, repo = 'toon-protocol/toon-plugins') {
  if (raw?.enabled !== true) return null;
  const startAt = Date.parse(raw.startAt ?? '');
  if (!address(raw.feeAddress) || !address(raw.token) || Number.isNaN(startAt)) return null;
  if (!/^[1-9][0-9]*$/.test(raw.amountMinor ?? '')) return null;
  const days = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);
  return {
    repo,
    feeAddress: raw.feeAddress.toLowerCase(),
    token: raw.token.toLowerCase(),
    amount: BigInt(raw.amountMinor),
    display: raw.amountDisplay ?? `${raw.amountMinor} base units`,
    startAt,
    confirmations: days(raw.confirmations, 60),
    closeUnpaidAfter: days(raw.closeUnpaidAfterDays, 7) * DAY,
    refundUndecidedAfter: days(raw.refundUndecidedAfterDays, 14) * DAY,
  };
}

/** Every distinct transaction hash in `text`, lower case, in order. */
export function hashesIn(text) {
  return [...new Set((text ?? '').match(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g) ?? [])].map((hash) =>
    hash.toLowerCase(),
  );
}

/** Maintainers, organisation members and bots pay nothing. */
export function exempt(pr) {
  return EXEMPT.has(pr.author_association) || pr.user?.type === 'Bot';
}

const topicFor = (account) => `0x${account.slice(2).toLowerCase().padStart(64, '0')}`;

/**
 * Why `receipt` is not a payment of the fee from `wallet`, or `null` when it is one.
 * `block` is the block the receipt names and `head` the newest block number.
 */
export function paymentProblem({ receipt, block, head, wallet, cfg }) {
  if (!receipt) return 'the transaction was not found on Base';
  if (receipt.status !== '0x1') return 'the transaction failed';
  if (head - BigInt(receipt.blockNumber) < BigInt(cfg.confirmations))
    return 'the transaction is too recent; it is checked again on the next run';
  if (!block || Number(BigInt(block.timestamp)) * 1000 < cfg.startAt)
    return 'the transaction is older than the submission fee';
  const paid = (receipt.logs ?? []).some(
    (log) =>
      log.address?.toLowerCase() === cfg.token &&
      log.topics?.length === 3 &&
      log.topics[0] === TRANSFER &&
      log.topics[1].toLowerCase() === topicFor(wallet) &&
      log.topics[2].toLowerCase() === topicFor(cfg.feeAddress) &&
      BigInt(log.data) >= cfg.amount,
  );
  return paid
    ? null
    : `it holds no transfer of at least ${cfg.display} from your registered wallet to the fee address`;
}

const has = (pr, label) => (pr.labels ?? []).some((entry) => entry.name === label);
const ours = (comments) => comments.filter((comment) => comment.user?.login === BOT);
const find = (comments, text) => ours(comments).find((comment) => comment.body.includes(text));

function neededBody(cfg) {
  return [
    mark.needed,
    `**This pull request needs a ${cfg.display} submission fee before a maintainer reviews it.**`,
    '',
    `This repository has a submission fee for pull requests from outside contributors. The rules are in [CONTRIBUTING.md](https://github.com/${cfg.repo}/blob/main/CONTRIBUTING.md#submission-fee).`,
    '',
    '1. Register a Base wallet for your GitHub account at https://slop.cash/earnings, if you have not.',
    `2. From that wallet, send ${cfg.display} on Base to \`${cfg.feeAddress}\`.`,
    '3. Paste the transaction hash in a comment on this pull request.',
    '',
    `- **Merged:** ${cfg.display} is sent back to the wallet that paid.`,
    '- **Closed without a merge:** the fee is not sent back. Check for an open pull request on the same topic before you pay.',
    `- **No maintainer decision ${cfg.refundUndecidedAfter / DAY} days after payment:** the fee is sent back.`,
    `- **Unpaid after ${cfg.closeUnpaidAfter / DAY} days:** this pull request is closed. Paying reopens it.`,
    '',
    'The fee does not change how the work is scored. The only valid fee address is the one in `.github/submission-fee.json` on `main`: ignore any other address posted here.',
  ].join('\n');
}

const paidBody = (cfg, tx, wallet) =>
  [
    mark.paid(tx, wallet),
    `**Submission fee received.** ${cfg.display} from \`${wallet}\` in \`${tx}\`. This pull request is in the review queue.`,
  ].join('\n');

const refundBody = (cfg, wallet, reason) =>
  [
    mark.refund,
    `**Refund due:** ${cfg.display} to \`${wallet}\`, because ${reason}. Refunds are sent by hand once a month.`,
  ].join('\n');

/**
 * A payment for `pr` among the hashes its author posted, as `{ tx, wallet }`; otherwise
 * `{ wallet, rejected }`, where `rejected` lists each hash not yet answered with why it
 * does not count. `wallet` is `null` when the author has registered none.
 */
async function payment(pr, comments, deps, cfg) {
  const wallet = (await deps.wallet(pr.user.id))?.toLowerCase() ?? null;
  const texts = [
    pr.body,
    ...comments.filter((comment) => comment.user?.id === pr.user.id).map((comment) => comment.body),
  ];
  const offered = hashesIn(texts.join('\n'));
  const rejected = [];
  for (const tx of offered) {
    let problem;
    if (deps.used.has(tx)) problem = 'it already paid for another pull request';
    else if (!wallet) problem = 'your GitHub account has no Base wallet registered on slop.cash';
    else {
      const receipt = await deps.receipt(tx);
      const block = receipt ? await deps.block(receipt.blockNumber) : null;
      problem = paymentProblem({ receipt, block, head: deps.head, wallet, cfg });
    }
    if (!problem) return { tx, wallet };
    const waiting = problem.startsWith('the transaction is too recent');
    if (!waiting && !find(comments, mark.rejected(tx))) rejected.push({ tx, problem });
  }
  return { wallet, rejected };
}

/**
 * What to do with one pull request, as a list of actions. `deps` supplies
 * `comments(number)`, `wallet(githubId)`, `receipt(hash)`, `block(number)`, the newest
 * block `head`, the set of hashes already `used`, and the time `now`.
 */
export async function decide(pr, deps, cfg) {
  if (exempt(pr) || Date.parse(pr.created_at) < cfg.startAt) return [];
  const open = pr.state === 'open';
  const merged = Boolean(pr.merged_at);
  if (open && pr.draft) return [];

  if (has(pr, LABEL.paid)) {
    if (has(pr, LABEL.refundDue) || (!open && !merged)) return [];
    const comments = await deps.comments(pr.number);
    const paid = ours(comments).find((comment) => PAID_MARK.test(comment.body));
    if (!paid) return [];
    const undecided = open && deps.now - Date.parse(paid.created_at) >= cfg.refundUndecidedAfter;
    if (!merged && !undecided) return [];
    const reason = merged
      ? 'this pull request was merged'
      : `no maintainer decided it within ${cfg.refundUndecidedAfter / DAY} days of payment`;
    return [
      { type: 'comment', body: refundBody(cfg, paid.body.match(PAID_MARK)[2], reason) },
      { type: 'label', add: [LABEL.refundDue] },
    ];
  }

  // This script labels every pull request it closes, so an unlabelled closed one was
  // decided by a person.
  if (merged || (!open && !has(pr, LABEL.needed))) return [];
  const comments = await deps.comments(pr.number);
  const closedByUs = find(comments, mark.closed);
  // A pull request someone else closed is decided. One this script closed for an unpaid
  // fee can still be paid, for 30 days.
  if (!open && (!closedByUs || deps.now - Date.parse(pr.closed_at) > 30 * DAY)) return [];

  const result = await payment(pr, comments, deps, cfg);
  if (result.tx) {
    deps.used.add(result.tx);
    return [
      ...(open ? [] : [{ type: 'reopen' }]),
      { type: 'comment', body: paidBody(cfg, result.tx, result.wallet) },
      { type: 'label', add: [LABEL.paid], remove: [LABEL.needed] },
    ];
  }

  const actions = result.rejected.map(({ tx, problem }) => ({
    type: 'comment',
    body: `${mark.rejected(tx)}\n\`${tx}\` does not count as the submission fee: ${problem}.`,
  }));
  if (!open) return actions;
  const asked = find(comments, mark.needed);
  if (!asked) {
    return [...actions, { type: 'comment', body: neededBody(cfg) }, { type: 'label', add: [LABEL.needed] }];
  }
  if (deps.now - Date.parse(asked.created_at) >= cfg.closeUnpaidAfter) {
    return [
      ...actions,
      {
        type: 'comment',
        body: `${mark.closed}\nClosed: the submission fee was not paid within ${cfg.closeUnpaidAfter / DAY} days. Paying it and pasting the transaction hash here reopens this pull request.`,
      },
      { type: 'close' },
    ];
  }
  return actions;
}

/** Every transaction hash this script has already accepted, from its own comments. */
export function usedHashes(comments) {
  return new Set(
    ours(comments)
      .map((comment) => comment.body.match(PAID_MARK)?.[1])
      .filter(Boolean),
  );
}

// ---- Everything below talks to GitHub, slop.cash and Base. ----

function github(repo, token) {
  const call = async (method, path, body) => {
    const response = await fetch(path.startsWith('https://') ? path : `https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'toon-plugins-submission-fee',
        'x-github-api-version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response;
  };
  const json = async (method, path, body, allowed = []) => {
    const response = await call(method, path, body);
    if (!response.ok && !allowed.includes(response.status))
      throw new Error(`GitHub ${method} ${path}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  const pages = async (path, limit = 20) => {
    const rows = [];
    let next = path;
    for (let page = 0; next && page < limit; page += 1) {
      const response = await call('GET', next);
      if (!response.ok) throw new Error(`GitHub GET ${next}: ${response.status}`);
      rows.push(...(await response.json()));
      next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    }
    return rows;
  };
  return { json, pages };
}

// The public Base endpoint answers "request limit reached" under load, so each call is
// tried a few times. A run that still fails is repeated by the next scheduled one.
async function rpc(url, method, params) {
  let problem;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const answer = await response.json();
      if (!answer.error) return answer.result;
      problem = answer.error.message;
    } catch (error) {
      problem = error.message;
    }
  }
  throw new Error(`Base ${method}: ${problem}`);
}

async function registeredWallet(githubId) {
  const response = await fetch(
    `https://api.slop.cash/api/v1/wallet-claims/actors/${Number(githubId)}/current?chain=base`,
    { headers: { 'user-agent': 'toon-plugins-submission-fee' } },
  );
  if (!response.ok) throw new Error(`slop.cash wallet lookup: ${response.status}`);
  const claim = await response.json();
  return address(claim?.address) ? claim.address : null;
}

async function apply(api, pr, action) {
  const issue = `/issues/${pr.number}`;
  if (action.type === 'comment') await api.json('POST', `${issue}/comments`, { body: action.body });
  if (action.type === 'close') await api.json('PATCH', `/pulls/${pr.number}`, { state: 'closed' });
  // GitHub refuses to reopen a pull request whose branch is gone; the labels still record
  // the payment, so say so and carry on.
  if (action.type === 'reopen')
    await api.json('PATCH', `/pulls/${pr.number}`, { state: 'open' }, [422]);
  if (action.type === 'label') {
    if (action.add?.length) await api.json('POST', `${issue}/labels`, { labels: action.add });
    for (const name of action.remove ?? [])
      await api.json('DELETE', `${issue}/labels/${encodeURIComponent(name)}`, undefined, [404]);
  }
}

async function main() {
  // SUBMISSION_FEE_CONFIG points a rehearsal at another settings file; the workflow
  // never sets it.
  const file =
    process.env.SUBMISSION_FEE_CONFIG ||
    fileURLToPath(new URL('../.github/submission-fee.json', import.meta.url));
  const repo = process.env.GITHUB_REPOSITORY;
  const cfg = settings(JSON.parse(readFileSync(file, 'utf8')), repo);
  if (!cfg) return console.log('The submission fee is off (.github/submission-fee.json).');

  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const dryRun = process.env.DRY_RUN === '1';
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  const api = github(repo, token);

  if (!dryRun)
    for (const name of Object.values(LABEL))
      await api.json('POST', '/labels', { name, color: 'c9a24a' }, [422]);

  const since = new Date(cfg.startAt).toISOString();
  const deps = {
    now: Date.now(),
    head: BigInt(await rpc(rpcUrl, 'eth_blockNumber', [])),
    used: usedHashes(await api.pages(`/issues/comments?since=${since}&per_page=100`)),
    comments: (number) => api.pages(`/issues/${number}/comments?per_page=100`),
    wallet: registeredWallet,
    receipt: (tx) => rpc(rpcUrl, 'eth_getTransactionReceipt', [tx]),
    block: (number) => rpc(rpcUrl, 'eth_getBlockByNumber', [number, false]),
  };

  const pulls = [
    ...(await api.pages('/pulls?state=open&per_page=100')),
    ...(await api.pages('/pulls?state=closed&sort=updated&direction=desc&per_page=50', 1)),
  ];
  let failed = false;
  for (const pr of pulls) {
    try {
      const actions = await decide(pr, deps, cfg);
      for (const action of actions) {
        const summary = action.type === 'comment' ? action.body.split('\n')[1] : JSON.stringify(action);
        console.log(`#${pr.number} ${action.type}: ${summary}`);
        if (!dryRun) await apply(api, pr, action);
      }
    } catch (error) {
      failed = true;
      console.error(`#${pr.number} skipped: ${error.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
