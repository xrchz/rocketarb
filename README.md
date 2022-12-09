# rocketarb
Arbitrage rETH mint/burn with minipool deposit/withdrawal

## Arb the rETH premium when you create a minipool!

How to? Here are the steps... Message me on the RocketPool Discord if you have
any problems!

### Docker mode

If you have Docker installed, you can run `rocketarb` with no
extra dependencies.

1. Try almost creating the minipool the normal way with the Rocketpool
   smartnode (>= 1.7.0). Stop before the final `ARE YOU SURE...` prompt and
   cancel it.
2. Clone this repo (`git clone https://github.com/xrchz/rocketarb`), and
   `cd rocketarb`.
3. Run `./scripts/rocketarb-docker.sh`. It should be fine with no arguments.
   - Pass the `--help` to see more options if something goes wrong.
   - A typical flow might involve, first: `./scripts/rocketarb-docker.sh --dry-run`
   - Then if that succeeds without any reverts: `./scripts/rocketarb-docker.sh`
   - If you want to deposit another minipool, delete or move the `bundle.json`
     file first to avoid trying to resume the previous deposit.

If you have used `rocketarb` before and want to upgrade to the latest version,
you can simply run:
- `git pull` on your clone of this repo.
- `./scripts/rocketarb-docker.sh --build` to update the Docker image.

### Native mode

Without Docker, the standard way to run `rocketarb` is as follows.

1. Try almost creating the minipool the normal way with the Rocketpool
   smartnode (>= 1.7.0). Stop before the final `ARE YOU SURE...` prompt and
   cancel it.
2. Ensure your node's RPC port is exposed locally as described
   [here](https://docs.rocketpool.net/guides/node/advanced-config.html#execution-client).
3. Install the requirements on your node machine: `nodejs` (>= 18), and `npm`.
4. Clone this repo (`git clone https://github.com/xrchz/rocketarb`), `cd
   rocketarb`, and `npm install` to download the js dependencies.
5. Run `./rocketarb.js`. It should be fine with no arguments.
   - Pass the `--help` to see more options if something goes wrong.
   - A typical flow might involve, first: `./rocketarb.js --dry-run`
   - Then if that succeeds without any reverts: `./rocketarb.js`
   - If you want to deposit another minipool, delete or move the `bundle.json`
     file first to avoid trying to resume the previous deposit.

If you have used `rocketarb` before and want to upgrade to the latest version,
you can simply `git pull` your clone of this repo.

## What does it do?
- Ask the smartnode to create a minipool deposit transaction from your node
  account.
- Create a transaction to call the rocketarb contract, which will flash loan 16
  ETH, deposit it in the Rocket Pool deposit pool (using the newly created
  space from the minipool deposit), sell the minted rETH using 1Inch, repay the
  flash loan, and send any profit back to your node account.
- Submit the two transactions above in a bundle using Flashbots.

This way you get to benefit from the rETH premium by the space temporarily
created in the deposit pool by your new minipool.

## Tips

- The smartnode needs to be at least version 1.7.0.
- Try `--rpc http://<your node local ip>:8545` if the default
  (`http://localhost:8545`) does not work.
- You can try submitting the Flashbots bundle again (in case it failed) without
  recreating the transactions. By default, if the bundle save file exists,
  `rocketarb` reuses the saved deposit transaction and only recreates the arb
  transaction (with fresh 1Inch swap data); use the `--resume` option to reuse
  both transactions. (The bundle gets saved in `bundle.json` by default.)
- The gas fee needs to be attractive enough for Flashbots to accept the bundle:
  the target block base fee per gas is burned and the block proposer receives
  any additional fee per gas up to the specified maximum priority fee per gas
  limited by the specified maximum fee per gas. The priority fee is what makes
  a bundle attractive. `rocketarb` uses the same maximum fees for both the
  deposit and arbitrage transactions, and the total gas will be about 2.7
  million (approximately: 2 million for the deposit, 800k for the arbitrage --
  these vary and can be hard to predict exactly).
- `rocketarb` will try to ensure to refund at least some (2.8M gas worth by
  default, change it with the `--gas-refund` option) of your gas costs with the
  arbitrage profits. This is ensured by making the arbitrage transaction revert
  (`not enough profit`) if it does not produce at least this much profit.
- If your bundle is not getting included (`BlockPassedWithoutInclusion`) most
  likely the transactions are reverting with some failure (try the `--dry-run`
  option to investigate), or the gas fees are too low for the current base fee.
- If the simulation returns `execution reverted` without further details,
  probably the gas limit for the arb transaction is too low; you could try
  increasing it with the `--gas-limit` option (and you might also like to
  increase `--gas-refund` accordingly).
- Every time we ask the smartnode for a deposit transaction, it increments its
  internal validator index (saved in your node's wallet file). If you need to
  re-run (e.g., to use a different maximum fee per gas) and don't want to waste
  the index, you can manually decrement it by editing the wallet file. Wasting
  indices is not a problem for your node, however - the generated validator
  keys for an unused index will simply remain unused.
- It is safe to unexpose your node's RPC port after you're done with
  `rocketarb` if you prefer leaving it hidden.

## Do it without a flash loan
- Pass the `--no-flash-loan` option to use capital (e.g., 16 ETH, or whatever
  the `--amount` of your minipool deposit is) in your node account instead of a
  flash loan.
- Why do this? It could reduce the total gas cost, and thereby increase
  profits. You can control the gas limits with the various `--X-gas-limit`
  options.
- Warning: with `--no-flash-loan` there is no check for minimum profit, i.e.,
  the `--gas-refund` option is ignored. Check the premium is healthy (e.g,.
  \>1%) with the `--premium` option first.
- By default `rocketarb` tries to arb both the minipool deposit amount and any
  free space in the deposit pool. If you do not have enough capital to
  additionally cover the existing free space in the deposit pool, pass the
  `--no-use-dp` option.

## Do it without connecting to the smartnode
By default `rocketarb` uses the smartnode daemon to sign all transactions. For
security, you can instead use the `--daemon <program>` argument to avoid
running `rocketarb` on your node. The `<program>` supplied will be called in
two ways by `rocketarb`, with different arguments:

1. `<program> api node deposit <amount> <commission> <salt> false`

   The program should output a signed minipool deposit transaction (_without_
   any leading `0x`), just as the smartnode daemon api would output with these
   arguments. (You could run the smartnode daemon once first to get the data
   then save it for further use by `rocketarb`.)

2. `<program> api node sign <inputSignedTx>`

   The program should output JSON for an object containing two keys: `{status:
   "success", signedData: <signedTx>}` where `signedTx` is a version of the
   transaction represented by `<inputSignedTx>` signed by the account you want
   to do the non-deposit transactions with. `<inputSignedTx>` is a signed
   transaction (_without_ the leading `0x`) signed by a random account.
   `signedTx` should be a string that _includes_ a leading `0x`.
