#!/usr/bin/env node

require('dotenv').config()
const { program } = require('commander')
const flashbots = require('@flashbots/ethers-provider-bundle')
const ethers = require('ethers')
const https = require('https')
const fs = require('fs/promises')

program.option('-r, --rpc <url>', 'RPC endpoint URL', 'http://localhost:8545')
       .option('-s, --slippage <percentage>', 'slippage tolerance for the swap', '2')
       .option('-w, --wallet-file <file>', 'saved wallet for arbitrage transactions', 'wallet.json')
       .option('-m, --max-tries <m>', 'number of blocks to attempt to submit bundle for', '3')
program.parse()
const options = program.opts()

const oneEther = ethers.utils.parseUnits('1', 'ether')

const provider = new ethers.providers.JsonRpcProvider(options.rpc)

const rocketStorageAddress = '0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46'
const wethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const arbContractAddress = '0x1f7e55F2e907dDce8074b916f94F62C7e8A18571'
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

async function run() {
  const rocketNodeDepositAddress = await rocketStorage.getAddress(
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("contract.addressrocketNodeDeposit")))

  const rethAddress = await rocketStorage.getAddress(
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("contract.addressrocketTokenRETH")))

  const rocketDepositSettingsAddress = await rocketStorage.getAddress(
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("contract.addressrocketDAOProtocolSettingsDeposit")))

  const rocketDepositPoolAddress = await rocketStorage.getAddress(
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("contract.addressrocketDepositPool")))

  console.log(`Using rocketNodeDeposit address ${rocketNodeDepositAddress}`)
  console.log(`Using rETH address ${rethAddress}`)
  console.log(`Using deposit pool address ${rocketDepositPoolAddress}`)
  console.log(`Using deposit settings address ${rocketDepositSettingsAddress}`)

  const rethContract = new ethers.Contract(
    rethAddress, ["function getRethValue(uint256 ethAmount) view returns (uint256)"], provider)

  const rocketDepositPool = new ethers.Contract(
    rocketDepositPoolAddress, ["function getBalance() view returns (uint256)"], provider)

  const depositSettings = new ethers.Contract(
    rocketDepositSettingsAddress,
    ["function getDepositFee() view returns (uint256)",
     "function getMaximumDepositPoolSize() view returns (uint256)",
     "function getMinimumDeposit() view returns (uint256)"],
    provider)

  const dpFee = await depositSettings.getDepositFee()
  const dpSize = await depositSettings.getMaximumDepositPoolSize()
  const minDeposit = await depositSettings.getMinimumDeposit()

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

  console.log(`Using wallet address: ${await signer.getAddress()}`)

  // TODO: replace if you want searcher reputation
  const randomSigner = ethers.Wallet.createRandom()

  const flashbotsProvider = await flashbots.FlashbotsBundleProvider.create(
    provider, randomSigner)

  const maxTries = parseInt(options.maxTries)

  async function makeArbTx(ethAmount) {
    const depositFee = ethAmount.mul(dpFee).div(oneEther)
    const depositAmount = ethAmount.sub(depositFee)
    const rethAmount = rethContract.getRethValue(depositAmount)

    console.log(`Aiming to arb ${ethers.utils.formatUnits(ethAmount, "ether")} ETH via ${ethers.utils.formatUnits(rethAmount, "ether")} rETH`)

    const swapParams = {
      fromTokenAddress: rethAddress,
      toTokenAddress: wethAddress,
      fromAddress: arbContractAddress,
      amount: rethAmount,
      slippage: options.slippage,
      allowPartialFill: false,
      disableEstimate: true
    }
    const swap = await oneInchAPI('swap', swapParams)

    const feeData = await provider.getFeeData()
    if (!('maxFeePerGas' in feeData) || ethers.BigNumber.from(0).eq(feeData.maxFeePerGas)) {
      console.log(`Warning: did not get gas estimate, got ${feeData.maxFeePerGas}, using default 16/2 (-> 24/4)`)
      feeData.maxFeePerGas = ethers.BigNumber.from(16)
      feeData.maxPriorityFeePerGas = ethers.BigNumber.from(2)
    }

    // TODO: estimate the gas usage better somehow?
    const arbMaxGas = ethers.BigNumber.from('900000')
    const minProfit = feeData.maxFeePerGas.mul(arbMaxGas)

    if (ethers.utils.getAddress(swap.tx.to) !== '0x1111111254fb6c44bAC0beD2854e76F90643097d')
      console.log(`Warning: unexpected to address for swap: ${swap.tx.to}`)

    console.log(`arb(${ethAmount}, ${minProfit}, ${swap.tx.data})`)
    const unsignedArbTx = await arbContract.populateTransaction.arb(
      ethAmount, minProfit, swap.tx.data)
    unsignedArbTx.chainId = 1
    unsignedArbTx.type = 2
    unsignedArbTx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas.mul(2)
    unsignedArbTx.maxFeePerGas = feeData.maxFeePerGas
    unsignedArbTx.gasLimit = arbMaxGas

    return unsignedArbTx
  }

  async function makeBundle(depositTx) {
    const unsignedArbTx = await makeArbTx(depositTx.value)

    if ('gasPrice' in depositTx && 'maxFeePerGas' in depositTx) {
      console.log('Warning: depositTx contains both gasPrice and maxFeePerGas; deleting former')
      delete depositTx.gasPrice
    }

    function getRawTransaction(tx) {
      function addKey(acc, key) { if (key in tx) acc[key] = tx[key]; return acc }
      const txFields = "accessList chainId data gasPrice gasLimit maxFeePerGas maxPriorityFeePerGas nonce to type value".split(" ")
      const sigFields = "v r s".split(" ")
      const raw = ethers.utils.serializeTransaction(txFields.reduce(addKey, { }), sigFields.reduce(addKey, { }))
      if (ethers.utils.keccak256(raw) !== tx.hash) throw new Error("serializing failed!")
      return raw
    }

    return [
      {signedTransaction: getRawTransaction(depositTx)},
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
        try {
          if ('signedTransaction' in tx)
            // await provider.sendTransaction(tx.signedTransaction)
            console.log('skipping signed tx, assuming already done')
          else {
            const txr = await tx.signer.sendTransaction(tx.transaction)
            await txr.wait()
          }
        }
        catch (e) {
          console.log(`transaction failed: ${e.toString()}`)
        }
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
      const dpSpace = dpSize.sub(await rocketDepositPool.getBalance())
      if (dpSpace.gt(minDeposit)) {
        console.log(`Found ${dpSpace} free space in the DP: arbing immediately`)
        const unsignedArbTx = makeArbTx(dpSpace)
        const txr = await flashbotsProvider.sendPrivateTransaction({
          transaction: unsignedArbTx, signer: signer})
        await txr.wait()
        const receipt = await txr.receipts()[0]
        if (receipt.status === 1)
          console.log(`Done: ${receipt.transactionHash}`)
        else
          console.log(`Failed: ${receipt.keys().join(', ')}`)
      }
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
