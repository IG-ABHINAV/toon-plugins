# Contributing

Pull requests are welcome. CI runs `node --test checks/*.test.mjs` and
`node checks/skill-commands.mjs`, and both must pass. A human merges every pull request.

This repository has a monthly pool on Slop: https://slop.cash/projects/toon-plugins

## Submission fee (pilot)

**Status: not started.** The pilot is on only while `.github/submission-fee.json` on
`main` says `"enabled": true`. That file also holds the start date and the fee address.

**Fee address: not set yet.**

A maintainer reads every pull request. The fee pays for that reading, and makes it worth
checking for an open pull request on the same topic before you send another.

### The rules

- A pull request from an outside contributor needs a **2 USDC fee on Base** before a
  maintainer reviews it.
- Maintainers, members of the organisation and bots pay nothing. Neither does a pull
  request opened before the start date.
- The fee goes to the maintainers. They keep it whether they merge or close your pull
  request, so it gives them no reason to do either.
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

### What to know before you pay

- This is a pilot. Refunds are sent by hand, once a month. The refund is a promise made
  here in writing, not a contract on chain.
- The only valid fee address is the one in `.github/submission-fee.json` on `main`,
  repeated above. Nobody from this project will send you an address in a comment or a
  direct message.
- `checks/submission-fee.mjs` is the whole rule. It moves no money.
