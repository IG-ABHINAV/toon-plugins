// The only file that reads the refund wallet's key. It can sign one thing: an ERC-20
// `transfer` on the chain it is told, from that wallet. It never prints the key, and its
// one dependency is pinned by `package-lock.json` beside it (installed with `npm ci
// --ignore-scripts` in the workflow).

import { encodeFunctionData, erc20Abi, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export function signer(key) {
  let account;
  try {
    account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
  } catch {
    // Not the library's own message, which could repeat the value it was given.
    throw new Error('REFUND_WALLET_KEY is not a valid private key.');
  }
  return {
    address: account.address.toLowerCase(),
    /** A signed EIP-1559 transfer of `amount` of `token` to `to`, and its hash. */
    async transfer({ token, to, amount, nonce, gas, maxFeePerGas, maxPriorityFeePerGas, chainId }) {
      const raw = await account.signTransaction({
        type: 'eip1559',
        chainId,
        to: token,
        value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
        nonce,
        gas,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      return { raw, hash: keccak256(raw) };
    },
  };
}
