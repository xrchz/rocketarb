#!/usr/bin/env node

require('dotenv').config()
const { program } = require('commander')
const flashbots = require('@flashbots/ethers-provider-bundle')
const ethers = require('ethers')
const https = require('https')
const fs = require('fs/promises')

program.option('-r, --rpc <url>', 'RPC endpoint URL', 'http://localhost:8545')
       .option('-f, --max-fee <maxFee>', 'max transaction fee in gwei', '24')
       .option('-i, --max-prio <maxPrio>', 'max transaction priority fee in gwei', '4')
       .option('-s, --slippage <percentage>', 'slippage tolerance for the swap', '2')
       .option('-w, --wallet-file <file>', 'saved wallet for arbitrage transactions', 'wallet.json')
       .option('-m, --max-tries <m>', 'number of blocks to attempt to submit bundle for', '5')
       .requiredOption('-b, --arb-contract <addr>', 'arb contract address')
program.parse()
const options = program.opts()

const oneEther = ethers.utils.parseUnits('1', 'ether')

const provider = new ethers.providers.JsonRpcProvider(options.rpc)

const rocketStorageAddress = '0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46'
const wethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const arbContractAddress = options.arbContract // TODO: hardcode once deployed
const oneInchAPIBase = 'https://api.1inch.io/v4.0/1/'

function oneInchAPI(method, params) {
  const url = `${oneInchAPIBase}${method}?${(new URLSearchParams(params)).toString()}`
  return new Promise((resolve, reject) => {
    const req = https.get(url,
      (res) => {
        if (res.statusCode !== 200) {
          console.log(`Got bad status ${res.statusCode} for 1inch ${method}`)
          reject(res)
        }
        res.setEncoding('utf8')
        let data = ''
        res.on('data', (chunk) => data += chunk)
        res.on('end', () => resolve(JSON.parse(data)))
      })
    req.on('error', reject)
  })
}

const rocketStorage = new ethers.Contract(
  rocketStorageAddress, ["function getAddress(bytes32 key) view returns (address)"], provider)

const arbContract = new ethers.Contract(
  arbContractAddress, ["function arb(uint256 wethAmount, uint256 minProfit, bytes swapData) nonpayable"], provider)

const maxPriorityFeePerGas = ethers.utils.parseUnits(options.maxPrio, "gwei")
const maxFeePerGas = ethers.utils.parseUnits(options.maxFee, "gwei")
const gasLimit = parseInt(options.gasLimit)

async function run() {
  const rocketNodeDepositAddress = await rocketStorage.getAddress(
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("contract.addressrocketNodeDeposit")))

  const rethAddress = await rocketStorage.getAddress(
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("contract.addressrocketTokenRETH")))

  const rocketDepositSettingsAddress = await rocketStorage.getAddress(
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("contract.addressrocketDAOProtocolSettingsDeposit")))

  console.log(`Using rocketNodeDeposit address ${rocketNodeDepositAddress}`)
  console.log(`Using rETH address ${rethAddress}`)
  console.log(`Using deposit settings address ${rocketDepositSettingsAddress}`)

  const rethContract = new ethers.Contract(
    rethAddress, ["function getRethValue(uint256 ethAmount) view returns (uint256)"], provider)

  const depositSettings = new ethers.Contract(
    rocketDepositSettingsAddress, ["function getDepositFee() view returns (uint256)"], provider)

  const rocketNodeDepositInterface = new ethers.utils.Interface(
    ["function deposit(uint256 _minimumNodeFee, bytes _validatorPubkey, bytes _validatorSignature, " +
      "bytes32 _depositDataRoot, uint256 _salt, address _expectedMinipoolAddress) payable"])

  const network = await provider.getNetwork()
  if (network.chainId !== 1) {
    console.log(`Only works on Ethereum mainnet (got chainid ${network.chainId})`)
    process.exit(1)
  }

  const signer = (await ethers.Wallet.fromEncryptedJson(
    await fs.readFile(options.walletFile, {encoding: 'utf8'}),
    process.env.WALLET_PASSWORD)).connect(provider)

  // TODO: replace if you want searcher reputation
  const randomSigner = ethers.Wallet.createRandom()

  const flashbotsProvider = await flashbots.FlashbotsBundleProvider.create(
    provider, randomSigner)

  const maxTries = parseInt(options.maxTries)

  async function makeBundle(depositTx) {
    const depositFee = depositTx.value.mul(await depositSettings.getDepositFee()).div(oneEther)
    const depositAmount = depositTx.value.sub(depositFee)
    const rethAmount = await rethContract.getRethValue(depositAmount)
    console.log(`Aiming to arb ${ethers.utils.formatUnits(rethAmount, "ether")} rETH`)

    const swapParams = {
      fromTokenAddress: rethAddress,
      toTokenAddress: wethAddress,
      fromAddress: await signer.getAddress(),
      amount: rethAmount,
      slippage: options.slippage,
      allowPartialFill: false,
      disableEstimate: true
    }
    const swap = await oneInchAPI('swap', swapParams)

    // TODO: estimate the gas usage better
    const arbGasUsageEstimate = ethers.BigNumber.from('600000')
    const gasEstimate = maxFeePerGas.mul(arbGasUsageEstimate)

    const unsignedArbTx = await arbContract.populateTransaction.arb(
      depositTx.value, gasEstimate, swap.tx.data)
    unsignedArbTx.chainId = depositTx.chainId
    unsignedArbTx.type = 2
    unsignedArbTx.maxPriorityFeePerGas = maxPriorityFeePerGas
    unsignedArbTx.maxFeePerGas = maxFeePerGas

    // on rpc providers that do not provide the raw tx
    if (!('raw' in depositTx)) {
      function getRawTransaction(tx) {
        function addKey(acc, key) { if (key in tx) acc[key] = tx[key]; return acc }
        const txFields = "accessList chainId data gasPrice gasLimit maxFeePerGas maxPriorityFeePerGas nonce to type value".split(" ")
        const sigFields = "v r s".split(" ")
        const raw = ethers.utils.serializeTransaction(txFields.reduce(addKey, { }), sigFields.reduce(addKey, { }))
        if (ethers.utils.keccak256(raw) !== tx.hash) throw new Error("serializing failed!")
        return raw
      }
      if ('gasPrice' in depositTx && 'maxFeePerGas' in depositTx) {
        console.log('Warning: depositTx contains both gasPrice and maxFeePerGas; deleting former')
        delete depositTx.gasPrice
      }
      depositTx.raw = getRawTransaction(depositTx)
    }

    return [
      {signedTransaction: depositTx.raw},
      {signer: signer, transaction: unsignedArbTx}
    ]
  }

  async function processDepositTx(depositTx) {
    try {
      rocketNodeDepositInterface.parseTransaction(depositTx)
    }
    catch {
      console.log('but could not parse it as a deposit()')
      return
    }

    const bundle = await makeBundle(depositTx)
    const currentBlockNumber = await provider.getBlockNumber()
    const simulateOnly = 0

    if (simulateOnly === 1) {
      console.log('Submitting bundle as individual transactions')
      for (const tx of bundle) {
        if ('signedTransaction' in tx)
          await provider.sendTransaction(tx.signedTransaction)
        else
          await tx.signer.sendTransaction(tx.transaction)
      }
    }
    else if (simulateOnly === 2) {
      const targetBlockNumber = currentBlockNumber + 1
      console.log(`Target block number: ${targetBlockNumber}`)
      const signedBundle = await flashbotsProvider.signBundle(bundle)
      const simulation = await flashbotsProvider.simulate(signedBundle, targetBlockNumber)
      console.log(JSON.stringify(simulation, null, 2))
      const currentBlock = await provider.getBlock(currentBlockNumber)
      const bundlePricing = flashbotsProvider.calculateBundlePricing(simulation.results, currentBlock.baseFeePerGas)
      console.log(JSON.stringify(bundlePricing, null, 2))
    }
    else {
      const targetBlockNumbers = []
      const promises = []
      for (let targetBlockNumber = currentBlockNumber + 1; targetBlockNumber <= currentBlockNumber + maxTries; targetBlockNumber++) {
        targetBlockNumbers.push(targetBlockNumber)
        promises.push(flashbotsProvider.sendBundle(bundle, targetBlockNumber))
      }
      const submissions = await Promise.all(promises)
      for (const [i, targetBlockNumber] of targetBlockNumbers.entries()) {
        const submission = submissions[i]
        console.log(`Target block number: ${targetBlockNumber}`)
        if ('error' in submission) {
          console.log(`RelayResponseError ${JSON.stringify(submission)}`)
        }
        else {
          const resolution = await submission.wait()
          console.log(`Resolution: ${flashbots.FlashbotsBundleResolution[resolution]}`)
          if (resolution === flashbots.FlashbotsBundleResolution.BundleIncluded) {
            console.log('Success!')
            break
          }
        }
      }
    }
  }

  async function watchMempool() {
    const filterId = await provider.send("eth_newPendingTransactionFilter", [])
    console.log(`installed pending tx filter ${filterId}`)

    async function pollForTxs() {
      const hashes = await provider.send("eth_getFilterChanges", [filterId])
      console.log(`Got ${hashes.length} pending txs`)
      let dropped = 0
      let skipped = 0
      for (const hash of hashes) {
        const tx = await provider.getTransaction(hash)
        if (tx === null) dropped += 1
        else if (tx.to !== rocketNodeDepositAddress) skipped += 1
        else {
          console.log(`Found ${hash} to deposit contract!`)
          await processDepositTx(tx)
        }
      }
      console.log(`Dropped ${dropped}, Skipped ${skipped}`)
    }

    let keepGoing = true
    process.on('SIGINT', () => { keepGoing = false })
    while (keepGoing)
      await new Promise(resolve => setTimeout(resolve, 1000)).then(pollForTxs)
    return filterId
  }

  const filterId = await watchMempool()
  const uninstalledFilter = await provider.send("eth_uninstallFilter", [filterId])
  console.log(`uninstallFilter ${uninstalledFilter ? 'succeeded' : 'failed'}`)
}

run()
