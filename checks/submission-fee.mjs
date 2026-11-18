// The submission fee (CONTRIBUTING.md). A pull request from an outside contributor
// needs a small fee, sent from the wallet its author registered on slop.cash to the
// address in `.github/submission-fee.json`. The settings list each way to pay: USDC on
// Base, and any entry under `alsoAccepted` (SLOP on Robinhood Chain). This script reads
// the open pull requests, checks each payment on chain, and labels, comments, closes or
// reopens.
//
// It moves no money. A refund is a "refund due" comment and label, and a kept fee that
// is to be burned is a "burn due" comment and label. When the settings name a
// `refundWallet`, `checks/submission-fee-refund.mjs` sends both; otherwise a person does.
//
// Run by `.github/workflows/submission-fee.yml` on a schedule with the repository's own
// token. It never checks out or runs a pull request's code. Text from a pull request is
// only ever searched for transaction hashes; nothing from it reaches a shell.
//
// What it trusts:
//   - labels, which only people with triage rights can set;
//   - its own comments, recognised by the author `github-actions[bot]`, never by text
//     alone, since anyone can paste a marker into a comment;
//   - a `Transfer` log emitted by the fee token's own contract.

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LABEL = {
  paid: 'fee-paid',
  needed: 'fee-needed',
  refundDue: 'fee-refund-due',
  burnDue: 'fee-burn-due',
  // Set by the sender: the refund or burn went out, or it could not and a person must look.
  refunded: 'fee-refunded',
  burned: 'fee-burned',
  refundCheck: 'fee-refund-check',
};
export const BOT = 'github-actions[bot]';
const TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DAY = 24 * 60 * 60 * 1000;
const EXEMPT = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** The chains a fee can be paid on. `key` is also the chain name slop.cash files wallets under. */
export const CHAINS = {
  base: { key: 'base', chainId: 8453, name: 'Base', rpc: 'https://mainnet.base.org', env: 'BASE_RPC_URL' },
  robinhood: {
    key: 'robinhood',
    chainId: 4663,
    name: 'Robinhood Chain',
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    env: 'ROBINHOOD_RPC_URL',
  },
};
/** Where a kept fee goes when its way to pay says `"keptFees": "burn"`. Nobody holds its key. */
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dead';

export const mark = {
  needed: '<!-- submission-fee:needed -->',
  closed: '<!-- submission-fee:closed-unpaid -->',
  refund: '<!-- submission-fee:refund-due -->',
  burn: '<!-- submission-fee:burn-due -->',
  paid: (tx, from, option, amount) =>
    `<!-- submission-fee:paid tx=${tx} from=${from} via=${option.id} amt=${amount} -->`,
  rejected: (tx) => `<!-- submission-fee:rejected tx=${tx} -->`,
};
// `via` and `amt` record which way was paid and how much the fee was that day, so a
// later change to the settings never changes what is sent back. A note without them is
// from before there was a second way to pay.
export const PAID_MARK =
  /<!-- submission-fee:paid tx=(0x[0-9a-f]{64}) from=(0x[0-9a-f]{40})(?: via=([a-z0-9-]+) amt=([1-9][0-9]*))? -->/;
/** The sender's note that a burn transaction was signed. From then on the burn is finished. */
export const BURN_STARTED = /<!-- submission-fee:burn-sending pay=0x[0-9a-f]{64} tx=0x[0-9a-f]{64} nonce=[0-9]+ -->/;

const address = (value) => /^0x[0-9a-fA-F]{40}$/.test(value ?? '');
const days = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);

/** One way to pay, or `null` when its settings are incomplete. */
function option(raw, id, chainKey) {
  const chain = CHAINS[chainKey];
  if (!chain || !/^[a-z0-9-]{1,20}$/.test(id ?? '')) return null;
  if (!address(raw?.token) || !/^[1-9][0-9]*$/.test(raw.amountMinor ?? '')) return null;
  return {
    id,
    chain,
    token: raw.token.toLowerCase(),
    amount: BigInt(raw.amountMinor),
    display: raw.amountDisplay ?? `${raw.amountMinor} base units`,
    symbol: /^[A-Za-z0-9]{1,12}$/.test(raw.symbol ?? '') ? raw.symbol : null,
    decimals: Number.isInteger(raw.decimals) && raw.decimals >= 0 && raw.decimals <= 36 ? raw.decimals : null,
    confirmations: days(raw.confirmations, 60),
    // What happens to a fee that is not sent back: it stays in the fee wallet, or it is burned.
    kept: raw.keptFees === 'burn' ? 'burn' : 'keep',
    burnAfter: days(raw.burnAfterDays, 7) * DAY,
  };
}

/**
 * The settings in `.github/submission-fee.json`, or `null` when the fee is off. It is
 * off unless `enabled` is true and the address, start time and amount are all valid, so a
 * half-filled file does nothing. `options` lists the ways to pay: the first is the token
 * and amount at the top of the file, on Base; the rest are the valid entries of
 * `alsoAccepted`. An incomplete entry there is left out and the fee stays on without it.
 */
export function settings(raw, repo = 'toon-protocol/toon-plugins') {
  if (raw?.enabled !== true) return null;
  const startAt = Date.parse(raw.startAt ?? '');
  const first = option(raw, 'usdc', 'base');
  if (!address(raw.feeAddress) || !first || Number.isNaN(startAt)) return null;
  const options = [first];
  for (const extra of Array.isArray(raw.alsoAccepted) ? raw.alsoAccepted : []) {
    const parsed = option(extra, extra?.id, extra?.chain);
    if (parsed && !options.some((known) => known.id === parsed.id)) options.push(parsed);
  }
  return {
    repo,
    feeAddress: raw.feeAddress.toLowerCase(),
    options,
    startAt,
    closeUnpaidAfter: days(raw.closeUnpaidAfterDays, 7) * DAY,
    refundUndecidedAfter: days(raw.refundUndecidedAfterDays, 14) * DAY,
    // The wallet that sends refunds and burns by itself. Absent or invalid: a person does.
    refundWallet: address(raw.refundWallet) ? raw.refundWallet.toLowerCase() : null,
  };
}

/** `amount` of a way to pay, in words: "75 SLOP". */
export function show(way, amount) {
  if (!way) return 'the fee';
  if (amount === way.amount) return way.display;
  if (way.symbol && way.decimals !== null) {
    const unit = 10n ** BigInt(way.decimals);
    const rest = (amount % unit).toString().padStart(way.decimals, '0').replace(/0+$/, '');
    return `${amount / unit}${rest ? `.${rest}` : ''} ${way.symbol}`;
  }
  return `${amount} base units`;
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

export const topicFor = (account) => `0x${account.slice(2).toLowerCase().padStart(64, '0')}`;

/**
 * Why `receipt` is not a payment of the fee from `wallet`, or `null` when it is one.
 * `block` is the block the receipt names and `head` the newest block number, both on the
 * chain of `option`, the way to pay being checked (the first one unless given). `amount`
 * is the least that counts: today's fee, or what an earlier run recorded.
 */
export function paymentProblem({ receipt, block, head, wallet, cfg, option: way = cfg.options[0], amount = way.amount }) {
  if (!receipt) return `the transaction was not found on ${way.chain.name}`;
  if (receipt.status !== '0x1') return 'the transaction failed';
  if (head - BigInt(receipt.blockNumber) < BigInt(way.confirmations))
    return 'the transaction is too recent; it is checked again on the next run';
  if (!block || Number(BigInt(block.timestamp)) * 1000 < cfg.startAt)
    return 'the transaction is older than the submission fee';
  const paid = (receipt.logs ?? []).some(
    (log) =>
      log.address?.toLowerCase() === way.token &&
      log.topics?.length === 3 &&
      log.topics[0] === TRANSFER &&
      log.topics[1].toLowerCase() === topicFor(wallet) &&
      log.topics[2].toLowerCase() === topicFor(cfg.feeAddress) &&
      BigInt(log.data) >= amount,
  );
  return paid
    ? null
    : `it holds no transfer of at least ${show(way, amount)} from your registered wallet to the fee address`;
}

export const has = (pr, label) => (pr.labels ?? []).some((entry) => entry.name === label);
export const ours = (comments) => comments.filter((comment) => comment.user?.login === BOT);
export const find = (comments, text) => ours(comments).find((comment) => comment.body.includes(text));

/**
 * The payment this script accepted for a pull request, read from its own note:
 * `{ tx, wallet, option, amount, at }`, or `null`. `option` is `null` when the note names
 * a way to pay the settings no longer list.
 */
export function paidRecord(comments, cfg) {
  const note = ours(comments).find((comment) => PAID_MARK.test(comment.body));
  if (!note) return null;
  const [, tx, wallet, via, amt] = note.body.match(PAID_MARK);
  const way = via ? (cfg.options.find((known) => known.id === via) ?? null) : cfg.options[0];
  return { tx, wallet, option: way, amount: amt ? BigInt(amt) : way.amount, at: Date.parse(note.created_at) };
}

const where = (way) => `${way.display} on ${way.chain.name}`;
const burnDays = (way) => way.burnAfter / DAY;

function neededBody(cfg) {
  const [first, ...rest] = cfg.options;
  const one = rest.length === 0;
  const burning = cfg.options.filter((way) => way.kept === 'burn');
  return [
    mark.needed,
    one
      ? `**This pull request needs a ${first.display} submission fee before a maintainer reviews it.**`
      : `**This pull request needs a submission fee before a maintainer reviews it: ${cfg.options.map(where).join(', or ')}.**`,
    '',
    `This repository has a submission fee for pull requests from outside contributors. The rules are in [CONTRIBUTING.md](https://github.com/${cfg.repo}/blob/main/CONTRIBUTING.md#submission-fee).`,
    '',
    ...(one
      ? [
          `1. Register a ${first.chain.name} wallet for your GitHub account at https://slop.cash/earnings, if you have not.`,
          `2. From that wallet, send ${where(first)} to \`${cfg.feeAddress}\`.`,
        ]
      : [
          '1. Register a wallet for your GitHub account at https://slop.cash/earnings, on the chain you will pay on, if you have not.',
          `2. From that wallet, send one of these to \`${cfg.feeAddress}\`:`,
          ...cfg.options.map((way) => `   - ${where(way)} (token \`${way.token}\`)`),
        ]),
    '3. Paste the transaction hash in a comment on this pull request.',
    '',
    `- **Merged:** ${one ? `${first.display} is` : 'what you paid is'} sent back to the wallet that paid.`,
    `- **Closed without a merge:** the fee is not sent back.${burning
      .map((way) => ` A fee paid in ${way.symbol ?? way.display} is burned once the pull request has stayed closed for ${burnDays(way)} days.`)
      .join('')} Check for an open pull request on the same topic before you pay.`,
    `- **No maintainer decision ${cfg.refundUndecidedAfter / DAY} days after payment:** the fee is sent back.`,
    `- **Unpaid after ${cfg.closeUnpaidAfter / DAY} days:** this pull request is closed. Paying reopens it.`,
    '',
    'The fee does not change how the work is scored. The only valid fee address and tokens are the ones in `.github/submission-fee.json` on `main`: ignore any other address posted here.',
  ].join('\n');
}

const paidBody = (way, tx, wallet) =>
  [
    mark.paid(tx, wallet, way, way.amount),
    `**Submission fee received.** ${where(way)} from \`${wallet}\` in \`${tx}\`. This pull request is in the review queue.`,
  ].join('\n');

const refundBody = (cfg, record, reason) =>
  [
    mark.refund,
    `**Refund due:** ${show(record.option, record.amount)} to \`${record.wallet}\`, because ${reason}. ${
      cfg.refundWallet
        ? 'It is sent automatically, normally within the hour.'
        : 'Refunds are sent by hand once a month.'
    }`,
  ].join('\n');

const burnBody = (cfg, record) =>
  [
    mark.burn,
    `**Fee to be burned:** ${show(record.option, record.amount)}, because this pull request stayed closed for ${burnDays(record.option)} days without a merge. ${
      cfg.refundWallet
        ? `It is sent to the burn address \`${BURN_ADDRESS}\` automatically, normally within the hour.`
        : 'A maintainer sends it to the burn address.'
    } After that it cannot be sent back.`,
  ].join('\n');

/**
 * A payment for `pr` among the hashes its author posted, as `{ tx, wallet, option }`;
 * otherwise `{ rejected }`, which lists each hash not yet answered with why it does not
 * count. A hash is looked up on the chain of each way to pay, in the order of the
 * settings, with the wallet the author registered for that chain.
 */
async function payment(pr, comments, deps, cfg) {
  const texts = [
    pr.body,
    ...comments.filter((comment) => comment.user?.id === pr.user.id).map((comment) => comment.body),
  ];
  const offered = hashesIn(texts.join('\n'));
  const names = [...new Set(cfg.options.map((way) => way.chain.name))].join(' or ');
  const rejected = [];
  for (const tx of offered) {
    let problem = null;
    if (deps.used.has(tx)) problem = 'it already paid for another pull request';
    else {
      for (const way of cfg.options) {
        const key = way.chain.key;
        const receipt = await deps.receipt(tx, key);
        if (!receipt) continue;
        const wallet = (await deps.wallet(pr.user.id, key))?.toLowerCase() ?? null;
        if (!wallet) {
          problem ??= `your GitHub account has no ${way.chain.name} wallet registered on slop.cash`;
          continue;
        }
        const block = await deps.block(receipt.blockNumber, key);
        const why = paymentProblem({ receipt, block, head: await deps.head(key), wallet, cfg, option: way });
        if (!why) return { tx, wallet, option: way };
        problem ??= why;
      }
      problem ??= `the transaction was not found on ${names}`;
    }
    const waiting = problem.startsWith('the transaction is too recent');
    if (!waiting && !find(comments, mark.rejected(tx))) rejected.push({ tx, problem });
  }
  return { rejected };
}

/**
 * What to do with one pull request, as a list of actions. `deps` supplies
 * `comments(number)`, `wallet(githubId, chain)`, `receipt(hash, chain)`,
 * `block(number, chain)`, `head(chain)` (the newest block number), the set of hashes
 * already `used`, and the time `now`. `chain` is a key of `CHAINS`.
 */
export async function decide(pr, deps, cfg) {
  if (exempt(pr) || Date.parse(pr.created_at) < cfg.startAt) return [];
  const open = pr.state === 'open';
  const merged = Boolean(pr.merged_at);
  if (open && pr.draft) return [];

  if (has(pr, LABEL.paid)) {
    if (has(pr, LABEL.refundDue) || has(pr, LABEL.burned)) return [];
    const comments = await deps.comments(pr.number);
    const record = paidRecord(comments, cfg);
    if (!record) return [];
    // Once the sender has signed a burn it finishes it, whatever happens here.
    const burning = ours(comments).some((comment) => BURN_STARTED.test(comment.body));
    if (has(pr, LABEL.burnDue)) {
      // Reopened before anything was signed: the burn is off, and the next run starts over.
      return burning || (!open && !merged) ? [] : [{ type: 'label', remove: [LABEL.burnDue] }];
    }
    if (burning) return [];
    if (!open && !merged) {
      const way = record.option;
      if (way?.kept !== 'burn' || deps.now - Date.parse(pr.closed_at) < way.burnAfter) return [];
      return [
        { type: 'comment', body: burnBody(cfg, record) },
        { type: 'label', add: [LABEL.burnDue] },
      ];
    }
    const undecided = open && deps.now - record.at >= cfg.refundUndecidedAfter;
    if (!merged && !undecided) return [];
    const reason = merged
      ? 'this pull request was merged'
      : `no maintainer decided it within ${cfg.refundUndecidedAfter / DAY} days of payment`;
    return [
      { type: 'comment', body: refundBody(cfg, record, reason) },
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
      { type: 'comment', body: paidBody(result.option, result.tx, result.wallet) },
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

/**
 * Whether anything is waiting for the sender: a refund or a burn marked due, and neither
 * sent nor set aside for a person. `issues` are the issues labelled `fee-refund-due` or
 * `fee-burn-due`.
 */
export function refundsPending(issues) {
  return issues.some(
    (issue) =>
      !has(issue, LABEL.refundCheck) &&
      ((has(issue, LABEL.refundDue) && !has(issue, LABEL.refunded)) ||
        (has(issue, LABEL.burnDue) && !has(issue, LABEL.burned))),
  );
}

/** Every transaction hash this script has already accepted, from its own comments. */
export function usedHashes(comments) {
  return new Set(
    ours(comments)
      .map((comment) => comment.body.match(PAID_MARK)?.[1])
      .filter(Boolean),
  );
}

// ---- Everything below talks to GitHub, slop.cash and the chains. ----

export function github(repo, token) {
  // GitHub Actions sets GITHUB_API_URL; a rehearsal points it at a stand-in.
  const base = process.env.GITHUB_API_URL || 'https://api.github.com';
  const call = async (method, path, body) => {
    const response = await fetch(/^https?:\/\//.test(path) ? path : `${base}/repos/${repo}${path}`, {
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

// A public endpoint answers "request limit reached" under load, so each call is tried a
// few times. A run that still fails is repeated by the next scheduled one.
export async function rpc(url, method, params, name = 'Base') {
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
  throw new Error(`${name} ${method}: ${problem}`);
}

/** The endpoint for a chain: the workflow's variable when set, else the public one. */
export const endpoint = (chain) => process.env[chain.env] || chain.rpc;

async function registeredWallet(githubId, chain) {
  const response = await fetch(
    `https://api.slop.cash/api/v1/wallet-claims/actors/${Number(githubId)}/current?chain=${CHAINS[chain].key}`,
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
  const api = github(repo, token);

  if (!dryRun)
    for (const name of Object.values(LABEL))
      await api.json('POST', '/labels', { name, color: 'c9a24a' }, [422]);

  // Each chain is asked only when a pull request offers a hash that could be on it, so an
  // endpoint that is down holds up nothing paid on the other chain.
  const call = (key, method, params) => rpc(endpoint(CHAINS[key]), method, params, CHAINS[key].name);
  const heads = new Map();
  const wallets = new Map();
  const since = new Date(cfg.startAt).toISOString();
  const deps = {
    now: Date.now(),
    used: usedHashes(await api.pages(`/issues/comments?since=${since}&per_page=100`)),
    comments: (number) => api.pages(`/issues/${number}/comments?per_page=100`),
    wallet: async (githubId, key) => {
      const id = `${key}:${githubId}`;
      if (!wallets.has(id)) wallets.set(id, await registeredWallet(githubId, key));
      return wallets.get(id);
    },
    head: async (key) => {
      if (!heads.has(key)) heads.set(key, BigInt(await call(key, 'eth_blockNumber', [])));
      return heads.get(key);
    },
    receipt: (tx, key) => call(key, 'eth_getTransactionReceipt', [tx]),
    block: (number, key) => call(key, 'eth_getBlockByNumber', [number, false]),
  };

  const pulls = [
    ...(await api.pages('/pulls?state=open&per_page=100')),
    ...(await api.pages('/pulls?state=closed&sort=updated&direction=desc&per_page=100', 1)),
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

  // Tell the workflow whether to start the sender job, so it runs only when one is owed.
  if (cfg.refundWallet && process.env.GITHUB_OUTPUT && !dryRun) {
    const due = [];
    for (const name of [LABEL.refundDue, LABEL.burnDue])
      due.push(...(await api.pages(`/issues?labels=${encodeURIComponent(name)}&state=all&per_page=100`)));
    appendFileSync(process.env.GITHUB_OUTPUT, `refunds=${refundsPending(due) ? 'pending' : 'none'}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
