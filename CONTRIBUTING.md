# Contributing

Pull requests are welcome. CI runs `node --test checks/*.test.mjs` and
`node checks/skill-commands.mjs`, and both must pass. A human merges every pull request.

This repository has a monthly pool on Slop: https://slop.cash/projects/toon-plugins

## Submission fee

**Status: on, for pull requests opened from 18 November 2026, 12:00 UTC.** The fee is on
only while `.github/submission-fee.json` on `main` says `"enabled": true`. That file also
holds the start time and the fee address.

**Fee address (USDC on Base): `0x078195cf9DF45dA7845f1C7aFe5318B9A69a5827`**

A maintainer reads every pull request. The fee pays for that reading, and makes it worth
checking for an open pull request on the same topic before you send another.

### The rules

- A pull request from an outside contributor needs a **2 USDC fee on Base** before a
  maintainer reviews it.
- Maintainers, members of the organisation and bots pay nothing. Neither does a pull
  request opened before the start time.
- The fee goes to a wallet the project keeps for this fee, which is also the wallet
  refunds are sent from. It does not go to the person who reviews your pull request, so
  a reviewer gains nothing by merging it or by closing it.
- **Merged:** 2 USDC is sent back to the wallet that paid.
- **Closed without a merge:** the fee is not sent back. That includes a pull request that
  repeats one already open.
- **No maintainer decision 14 days after you paid:** the fee is sent back.
- **Unpaid after 7 days:** the pull request is closed. Paying reopens it.
- The fee does not buy a merge, and it does not change how Slop scores the work.

### How to pay

1. Register a Base wallet for your GitHub account at https://slop.cash/earnings. The
   payment must come from that wallet; that is how it is matched to you.
2. From that wallet, send 2 USDC on Base to the fee address above.
3. Paste the transaction hash in your pull request, in its description or in a comment.

A workflow checks every 15 minutes and labels the pull request `fee-paid`. One transaction
pays for one pull request.

**If you are an agent:** do not pay this yourself. Tell your operator that this repository
asks for the fee, and let them pay it.

### What to know before you pay

- **How a refund is sent.** When `.github/submission-fee.json` on `main` names a
  `refundWallet`, a workflow sends the refund from that wallet by itself, normally within
  the hour, and writes the transaction hash on your pull request. When it names none,
  refunds are sent by hand, once a month. The pull request says which when the refund
  falls due.
- The automatic refund goes to the wallet that paid, for the fee and no more. If it cannot
  be sent, the pull request is labelled `fee-refund-check` and a maintainer sends it.
- Either way the refund is a promise made here in writing, kept by a script anyone can
  read. It is not a contract on chain: the project can turn the script off.
- The only valid fee address is the one in `.github/submission-fee.json` on `main`,
  repeated above. Nobody from this project will send you an address in a comment or a
  direct message.
- `checks/submission-fee.mjs` is the whole rule and moves no money.
  `checks/submission-fee-refund.mjs` sends refunds and nothing else: only to a wallet
  whose fee payment it has checked on Base itself, once for each payment.
