import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseTransaction, recoverTransactionAddress } from 'viem';

import { transferData } from '../submission-fee-refund.mjs';
import { signer } from './sign.mjs';

// A key published in every Ethereum test suite. Never one that holds anything.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TO = '0x00000000000000000000000000000000000000aa';

test('the signer signs a token transfer from its own wallet, and nothing else', async () => {
  const wallet = signer(TEST_KEY);
  assert.equal(wallet.address, TEST_ADDRESS);
  assert.deepEqual(Object.keys(wallet), ['address', 'transfer']);

  const { raw, hash } = await wallet.transfer({
    token: USDC,
    to: TO,
    amount: 2_000_000n,
    nonce: 7,
    gas: 90_000n,
    maxFeePerGas: 2_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    chainId: 8453,
  });
  const tx = parseTransaction(raw);
  assert.equal(tx.to.toLowerCase(), USDC);
  assert.equal(tx.value ?? 0n, 0n);
  assert.equal(tx.chainId, 8453);
  assert.equal(tx.nonce, 7);
  // The call data the sender estimates gas with is the call data that is signed.
  assert.equal(tx.data, transferData(TO, 2_000_000n));
  assert.equal((await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase(), TEST_ADDRESS);
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  // The same request signs to the same hash, so a repeat is the same transaction.
  const again = await wallet.transfer({
    token: USDC, to: TO, amount: 2_000_000n, nonce: 7, gas: 90_000n,
    maxFeePerGas: 2_000_000n, maxPriorityFeePerGas: 1_000_000n, chainId: 8453,
  });
  assert.equal(again.hash, hash);
});

test('a bad key is refused without repeating it', () => {
  assert.throws(() => signer('0xnot-a-key-0123456789'), (error) => {
    assert.equal(error.message, 'REFUND_WALLET_KEY is not a valid private key.');
    return true;
  });
});
