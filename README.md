# rocketarb
Arbitrage rETH mint/burn with minipool deposit/withdrawal

## Arb the rETH premium when you create a minipool!

How to? Here are the steps... Message me on the RocketPool Discord if you have
any problems!

1. Dry run creating the minipool the normal way with the Rocketpool smartnode
   (>= 1.7.0). Stop before the final `ARE YOU SURE...` prompt and cancel it.
2. Install the requirements on your node machine: `nodejs` (>= 18), `npm`, and
   clone this repo (`rocketarb`).
3. Ensure your node's RPC port is exposed locally as described
   [here](https://docs.rocketpool.net/guides/node/advanced-config.html#execution-client).
4. Run `./rocketarb.js`. It should be fine with no arguments. Pass the `--help`
   to see more options if something goes wrong.

## What does it do?
- Ask the smartnode to create a minipool deposit transaction from your node
  wallet address.
- Create a transaction to call the rocketarb contract, which will flash loan 16
  ETH, deposit it in the Rocket Pool deposit pool (using the newly created
  space from the minipool deposit), sell the minted rETH using 1Inch, repay the
  flash loan, and send any profit back to your node wallet.
- Submit the two transactions above in a bundle using Flashbots.

This way you get to benefit from the rETH premium by the space temporarily
created in the deposit pool by your new minipool.

## Tips

- The smartnode needs to be at least version 1.7.0.
- Try `--rpc http://<your node local ip>:8545` if the default
  (`http://localhost:8545`) does not work.
- Use the `--resume` option to try submitting the flashbots bundle again (in
  case it failed) without recreating the transactions. (The bundle gets saved
  in `bundle.json` by default.)
- (Advanced - not necessary) Every time we ask the smartnode for a deposit
  transaction, it increments its internal validator index (saved in your node's
  wallet file). If you need to re-run (e.g., to use a different gas price) and
  don't want to waste the index, you can manually decrement it by editing the
  wallet file.
