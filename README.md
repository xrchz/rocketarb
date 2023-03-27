# What is rocketarb?

Rocketarb is a third party Rocket Pool tool that operates during Rocket Pool minipool creation. It works by harvesting arbitrage value from the market premium on rETH compared to the creation cost of rETH. Rocketarb uses a flash loan to deposit 16 ETH into the rETH deposit pool at the same time as the capacity becomes available, then selling that 16 ETH on the open market and reaping the arbitrage value. As the market matures, rocketarb will become a valuable tool for stabilizing the market price of rETH.

## The Premium LSD

Outside of short-term fluctuations the price of rETH will tend to trade at a premium on secondary markets such as Uniswap or 1inch due to the laws of supply and demand. Demand for rETH is effectively unbounded, while supply will always be limited by minipool operator collateral availability and efficiency. This environment often creates an arbitrage opportunity between the higher price rETH trades at on decentralized exchanges, and the “correct” price calculated by Rocket Pool’s Oracle DAO network which is referred to as the primary, pegged, protocol, NAV, or reference price.

## Setting the stage

A core part of Rocket Pool’s staking design that is relevant to this arbitrage is the deposit queue, where ETH can chill out and await the creation of a new minipool at which point the ETH will be staked and start earning a return. The deposit pool needs to be capped at some nominal size (currently 5000 ETH) because while queued ETH immediately mints new rETH, it is not yet generating yield and hence slightly dilutes the APR of all participants. Because of the high demand for rETH the queue tends to be full more often than not, and when this is the case it means that no more ETH can be deposited until space opens up.

## Highly profitable arbitrage strategy

The arbitrage exists every time a new minipool is launched and 16 ETH of space opens up in the deposit queue while the secondary market price premium prevails. If you deposit 16 ETH to stake it with Rocket Pool and receive rETH in return, you can then immediately turn around and sell that same rETH on secondary markets to get back more ETH than you staked. At the time of writing, the average return is about 2% of 16 ETH, or 0.32 ETH per arbitrage. A free money printer? Sounds good! Well unfortunately the bots think so too, and they are much faster than you.

## Gotta go fast

The only way to beat the bots and claim the free ETH for yourself is to complete the entire process in one go - deploy the 16 ETH collateral (plus RPL bond) to launch a new minipool and simultaneously deposit a separate 16 ETH into the deposit queue. Rocketarb is a third-party smart contract created by a Rocket Pool community member to do exactly this. While unofficial and not audited, the code is fully open source and has been executed over 600 times during the past two months to generate more than 220 free ETH. In addition, the Rocket Pool team has recognised the value of rocketarb and is looking to more closely integrate it into the Rocket Pool ecosystem in the future.

## Where to from here

The Rocket Pool protocol continues to evolve over time. In the future when ETH withdrawals are possible and minipool collateral has been reduced the price premium percentage will probably be lower but each new minipool will allow more than 16 ETH to be arbitraged. Rocketarb will likely remain a useful value-creating tool for node operators, and a price-stabilizing tool for rETH. You can learn more about rocketarb at the following links:
- Rocketscan dashboard by rocketscan.eth: https://rocketscan.io/rocketarb
- RocketArb Watch by 0xhodja.eth: https://rocketarb-watch.netlify.app
- Rocketarb script by ramana.eth: https://github.com/xrchz/rocketarb

# Arb the rETH premium when you create a minipool!

How to? Here are the steps... Message me (ramana#2626) on the RocketPool Discord if you have
any problems!

## Docker mode

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

If you have used `rocketarb` before and want to upgrade to the latest version,
you can simply run:
- `git pull` on your clone of this repo.
- `./scripts/rocketarb-docker.sh --build` to update the Docker image.

## Native mode

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

If you have used `rocketarb` before and want to upgrade to the latest version,
you can simply `git pull` your clone of this repo.

# What does it do?
- Ask the smartnode to create a minipool deposit transaction from your node
  account.
- Create a transaction to call the rocketarb contract, which will flash loan 16
  WETH, unwrap it to native ETH, deposit it in the Rocket Pool deposit pool (using the 
  newly created space from the minipool deposit), sell the resulting minted rETH using 1Inch, 
  repay the flash loan, and send any profit back to your node account.
- Submit the two transactions above in a bundle using Flashbots to prevent frontrunning.

This way you get to benefit from the rETH premium by the space temporarily
created in the deposit pool by your new minipool.

# Tips

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
  re-run (e.g. to use a different maximum fee per gas) and don't want to waste
  the index, you can manually decrement it by editing the wallet file. Wasting
  indices is not a problem for your node, however - the generated validator
  keys for an unused index will simply remain unused.
- It is safe to unexpose your node's RPC port after you're done with
  `rocketarb` if you prefer leaving it hidden.

# Control how the transaction is funded
Pass the `--funding-method` option to control how the arb is funded:
- `--funding-method uniswap` (the default) will swap directly with a Uniswap
  pool, getting a flash loan from the pool and using it to fund the rEth
  deposit. This is relatively cheap on gas, so it's more efficient when the
  premium is small.
- `--funding-method flashLoan` will take out a dedicated flash loan, and
  then use the loaned funds for the arbitrage. The swap is done via
  1inch, ensuring an optimal route.
- `--funding-method self` will use funds in the local wallet to fund the
  arbitrage.

Why choose one over another? Each has tradeoffs:
- `self` and `flashLoan` allow more flexibility in the route the swap takes,
  so big swaps might give more optimal arbs with these two options. 
- `self` and `uniswap` don't require an explicit flash loan step, reducing
  gas costs.
- `self` allows you to keep the minted rEth for yourself, rather than
  selling it back for a profit

Our overall recommendation is:
- use `uniswap` if the premium is small (less than 0.5% or so) to keep gas
  costs down
- use `flashLoan` when the premium is larger to ensure an optimal swap
- use `self` if you have the funds and want to do something special like
  keep the minted rEth for yourself.

# Additional funding notes
- You can control the gas limits with the various `--X-gas-limit`
  options.
- Warning: with `--funding-method self` there is no check for minimum profit,
  i.e. the `--gas-refund` option is ignored. Check the premium is healthy
  (e.g. \>1%) with the `--premium` option first.
- By default `rocketarb` tries to arb both the minipool deposit amount and any
  free space in the deposit pool. With `--funding-method self`, if you do not
  have enough capital to additionally cover the existing free space in the
  deposit pool, pass the `--no-use-dp` option.

# Do it without connecting to the smartnode
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
