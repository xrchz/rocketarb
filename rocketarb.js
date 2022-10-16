#!/usr/bin/env node

const { execSync } = require('child_process')
const { program } = require('commander')
const ethers = require('ethers')
const flashbots = require('@flashbots/ethers-provider-bundle')
const prompt = require('prompt-sync')()

program.option('-r, --rpc <url>', 'RPC endpoint URL', 'http://localhost:8545')
       .option('-d, --daemon <cmd>', 'command (+ args if req) to run the rocketpool smartnode daemon', 'docker exec rocketpool_node /go/bin/rocketpool')
       .option('-l, --salt <salt>', 'salt for custom minipool address')
       .option('-f, --max-fee <maxFee>', 'max transaction fee in gwei')
       .option('-i, --max-prio <maxPrio>', 'max transaction priority fee in gwei')
       .option('-x, --extra-args <args>', 'extra (space-separated) arguments to pass to daemon calls')
       .option('-m, --max-tries <m>', 'number of blocks to attempt to submit bundle for', 10)
       .option('-a, --amount <amt>', 'amount in ether to deposit', 16)
       .option('-c, --min-fee <com>', 'minimum minipool commission fee', .15)
       .option('-u, --uni-fee <bps>', 'Uniswap fee to select the rETH/WETH pool to use (500 means the 0.05% fee pool)', 500)
       .option('-g, --gas-limit <gas>', 'gas limit for arbitrage transaction', 400000)
       .option('-b, --arb-contract <addr>', 'deployment address of the RocketDepositArbitrage contract', '0xTODO-DEPLOYMENT-ADDRESS')
program.parse()
const options = program.opts()

console.log('Welcome to RocketArb: Deposit!')
var answer = prompt('Have you done a dry run of depositing your minipool using the smartnode? ')
if (!(answer === 'y' || answer === 'yes')) {
  console.log('Do that first then retry.')
  process.exit()
}

var cmd = options.daemon
if (options.maxFee) cmd = cmd.concat(' --maxFee ', options.maxFee)
if (options.maxPrio) cmd = cmd.concat(' -- maxPrioFee ', options.maxPrio)
if (options.extraArgs) cmd = cmd.concat(' ', options.extraArgs)
const salt = options.salt ? parseInt(options.salt, 16) : Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)

const oneEther = ethers.utils.parseUnits("1", "ether")
const oneGwei = ethers.utils.parseUnits("1", "gwei")

const amountWei = oneEther.mul(options.amount)

cmd = cmd.concat(' api node deposit ',
  ethers.utils.formatUnits(amountWei, "wei"),
  ' 0.15 ',
  salt.toString(),
  ' false')

console.log(`Executing ${cmd}`)

const cmdOutput = execSync(cmd)
const encodedSignedDepositTx = `0x${cmdOutput.toString().trim()}`
console.log(`Got tx: ${encodedSignedDepositTx}`)
const signedDepositTx = ethers.utils.parseTransaction(encodedSignedDepositTx)

/* verbose logging
console.log('Which parses as')
function ppTx(tx) {
  return [
    `hash:${tx.hash}`,
    `to:${tx.to}`,
    `from:${tx.from}`,
    `nonce:${tx.nonce}`,
    `gasLimit:${tx.gasLimit.toString()}`,
    `maxFeePerGas:${ethers.utils.formatUnits(tx.maxFeePerGas, "gwei")}`,
    `maxPriorityFeePerGas:${ethers.utils.formatUnits(tx.maxPriorityFeePerGas, "gwei")}`,
    `data:${tx.data}`,
    `value:${ethers.utils.formatUnits(tx.value, "ether")}`,
    `chainId:${tx.chainId}`].join('\n')
}
console.log(ppTx(signedDepositTx))
*/

console.log('Creating arb transaction')

const provider = new ethers.providers.JsonRpcProvider(options.rpc)
const arbAbi = ["function arb(uint24 uniswapFee, uint256 wethAmount) nonpayable"]
const arbContract = new ethers.Contract(options.arbContract, arbAbi, provider)

;(async () => {

const authSigner = ethers.Wallet.createRandom()

const unsignedArbTx = await arbContract.populateTransaction.arb(options.uniFee, amountWei)
unsignedArbTx.type = 2
unsignedArbTx.chainId = signedDepositTx.chainId
unsignedArbTx.nonce = signedDepositTx.nonce + 1
unsignedArbTx.maxPriorityFeePerGas = signedDepositTx.maxPriorityFeePerGas
unsignedArbTx.maxFeePerGas = signedDepositTx.maxFeePerGas
unsignedArbTx.gasLimit = parseInt(options.gasLimit)

// sign randomly first to get around go-ethereum unmarshalling issue
const fakeSigned = await authSigner.signTransaction(unsignedArbTx)
cmd = options.daemon.concat(' api node sign ', fakeSigned.substring(2))
const signOutput = JSON.parse(execSync(cmd))
console.assert(signOutput.status === 'success', `signing arb transaction failed: ${signOutput.error}`)
const encodedSignedArbTx = signOutput.signedData

const bundle = [
  {signedTransaction: encodedSignedDepositTx},
  {signedTransaction: encodedSignedArbTx}
]

// TODO: save the bundle for resumption in case submission fails?

const network = await provider.getNetwork()
const flashbotsProvider = await flashbots.FlashbotsBundleProvider.create(
  provider,
  authSigner,
  network.chainId === 5 ? 'https://relay-goerli.flashbots.net/' : undefined,
  network.name)

const currentBlockNumber = await provider.getBlockNumber()
const currentBlock = await provider.getBlock(currentBlockNumber)
const currentBaseFeePerGas = currentBlock.baseFeePerGas
const maxTries = parseInt(options.maxTries)
const maxBaseFeeInFutureBlock = flashbots.FlashbotsBundleProvider.getMaxBaseFeeInFutureBlock(
  currentBaseFeePerGas, maxTries)

console.assert(signedDepositTx.maxFeePerGas.gte(maxBaseFeeInFutureBlock),
  `gas price too low: max predicted base fee is ${ethers.utils.formatUnits(maxBaseFeeInFutureBlock, 'gwei')} gwei`)

const targetBlockNumbers = []
const promises = []
for (let targetBlockNumber = currentBlockNumber + 1; targetBlockNumber <= currentBlockNumber + maxTries; targetBlockNumber++) {
  targetBlockNumbers.push(targetBlockNumber)
  promises.push(flashbotsProvider.sendBundle(bundle, targetBlockNumber))
}
const submissions = await Promise.all(promises)
// const failures = []

for (const [i, targetBlockNumber] of targetBlockNumbers.entries()) {
  const submission = submissions[i]
  console.log(`Target block number: ${targetBlockNumber}`)
  if ('error' in submission) {
    console.log(`RelayResponseError:\n${JSON.stringify(submission)}`)
  }
  else {
    const resolution = await submission.wait()
    console.log(`Resolution: ${flashbots.FlashbotsBundleResolution[resolution]}`)
    if (resolution === flashbots.FlashbotsBundleResolution.BlockPassedWithoutInclusion) {
      /*
      if (network.chainId === 1) {
        failures.push([submission, targetBlockNumber])
      }
      */
      continue
    }
    else {
      console.log('Bundle successfully included on chain!')
      process.exit(0)
    }
  }
}

/* flashbots debugging (only possible on mainnet)
if (failures.length) {
  console.log('Bundle inclusion failed')
  console.log('User stats:')
  const userStats = await flashbotsProvider.getUserStats()
  console.log(JSON.stringify(userStats, null, 2))
  for (const [submission, targetBlockNumber] of failures) {
    const signedBundle = submission.bundleTransactions.map(a => a.signedTransaction)
    const conflictReport = await flashbotsProvider.getConflictingBundle(signedBundle, targetBlockNumber)
    console.log(`Conflict report for ${targetBlockNumber}: ${flashbots.FlashbotsBundleConflictType[conflictReport.conflictType]}`)
    console.log(JSON.stringify(conflictReport, null, 2))
  }
}
*/

/*
// for debugging interactively, add variables to the REPL context
const repl = require('repl').start()
repl.context.ethers = ethers
repl.context.optins = options
repl.context.encodedSignedDepositTx = encodedSignedDepositTx
repl.context.signedDepositTx = signedDepositTx
repl.context.provider = provider
repl.context.arbContract = arbContract
repl.context.unsignedArbTx = unsignedArbTx
repl.context.fakeSigned = fakeSigned
repl.context.signOutput = signOutput
repl.context.encodedSignedArbTx = encodedSignedArbTx
repl.context.network = network
repl.context.authSigner = authSigner
repl.context.flashbotsProvider = flashbotsProvider
repl.context.currentBlockNumber = currentBlockNumber
repl.context.currentBlock = currentBlock
repl.context.currentBaseFeePerGas = currentBaseFeePerGas
repl.context.maxTries = maxTries
repl.context.maxBaseFeeInFutureBlock = maxBaseFeeInFutureBlock
repl.context.bundle = bundle
repl.context.targetBlockNumbers = targetBlockNumbers
repl.context.promises = promises
repl.context.submissions = submissions
// repl.context.failures = failures
*/

})()
