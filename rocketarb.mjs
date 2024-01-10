#!/usr/bin/env node

import 'dotenv/config'
import child_process from 'node:child_process'
import { program, Option } from 'commander'
import https from 'node:https'
import { ethers } from 'ethers'
import flashbots from '@flashbots/ethers-provider-bundle'
import promptSync from 'prompt-sync'
import fs from 'node:fs/promises'
const prompt = promptSync()
const { execSync } = child_process

program.option('-r, --rpc <url>', 'RPC endpoint URL', 'http://localhost:8545')
       .option('-t, --premium', 'print the rETH/ETH primary and secondary rates and exit')
       .option('--vote', 'interactively vote on rocketpool snapshot using your node account')
       .option('-f, --max-fee <maxFee>', 'max transaction fee per gas in gwei')
       .option('-i, --max-prio <maxPrio>', 'max transaction priority fee per gas in gwei')
       .option('-n, --dry-run', 'simulate only, do not submit transaction bundle')
       .option('-e, --resume', 'do not create a new bundle, instead submit the one saved in the bundle file')
       .option('-m, --max-tries <m>', 'number of blocks to attempt to submit bundle for', 10)
       .option('-l, --salt <salt>', 'salt for custom minipool address')
       .option('-u, --gas-refund <gas>', 'set min-profit to a gas refund of this much gas', 2800000)
       .option('-g, --gas-limit <gas>', 'gas limit for arbitrage transaction', 990000)
       .option('-p, --no-use-dp', 'do not include space in the deposit pool in the arb')
       .option('--max-mint <amt>', 'maximum amount of ETH to spend on minting rETH', 100)
       .option('-d, --daemon <cmd>', 'command (+ args if req) to run the rocketpool smartnode daemon, or "interactive"', 'docker exec rocketpool_node /go/bin/rocketpool')
       .option('-x, --extra-args <args>', 'extra (space-separated) arguments to pass to daemon calls')
       .option('-v, --bundle-file <file>', 'filename for saving the bundle before submission or reading a saved bundle', 'bundle.json')
       .option('-a, --amount <amt>', 'amount in ether to deposit', 8)
       .option('-c, --min-fee <com>', 'minimum minipool commission fee', .14)
       .option('-s, --slippage <percentage>', 'slippage tolerance for the arb swap', 2)
       .option('-y, --yes', 'skip all confirmations')
       .addOption(
          new Option('-fm, --funding-method <method>', 'the method to use for funding the arbitrage.\n\
  - with `huffLoan`, we use the new Huff contract with rETH liquidity for a flash loan, and swap through whichever 1inch route gives the best arb.\n\
  - with `flashLoan`, we take out an eth flash loan from Balancer and then swap through whichever 1inch route gives the best arb -- can fail if this is balancer.\n\
  - with `uniswap`, we swap directly through a WETH <-> rETH uniswap v3 pool, using the pool\'s flash loan functionaity.\n\
  - with `self` we use eth in the local wallet to fund the arbitrage'
  )
         .choices(['huffLoan', 'flashLoan', 'uniswap', 'self'])
         .default("uniswap")
       )

       // options for --funding-method flashLoan/huffLoan'
       .option('-b, --arb-contract <addr>', 'contract address to use when --funding-method = flashLoan', '0xEADc96a160E3a51e7318c0954B28c4a367d5f909')
       .option('-hb, --huff-arb-contract <addr>', 'contract address to use when --funding-method = huffLoan', '0x786d8351f419F2Cb076664abcB5F8Ca04e9F1D7D')

       // options for --funding-method uniswap'
       .option('-ub, --uni-arb-contract <addr>', 'contract address to use when --funding-method = uniswap', '0x6fCfE8c6e35fab88e0BecB3427e54c8c9847cdc2')
       .option('-up, --uni-pool <address>', 'Uniswap pool to swap on when --funding-method = uniswap', '0xa4e0faa58465a2d369aa21b3e42d43374c6f9613')

       // options for --funding-method self'
       .addOption(new Option('--no-flash-loan', 'deprecated. same as `--funding-method self`').implies({fundingMethod: 'self' }))
       .option('-k, --no-swap-reth', 'keep the minted rETH instead of selling it (only works with --funding-method self)')
       .option('-gm, --mint-gas-limit <gas>', 'gas limit for mint transaction (only relevant for --funding-method self)', 220000)
       .option('-ga, --approve-gas-limit <gas>', 'gas limit for approve transaction (only relevant for --funding-method self)', 80000)
       .option('-gs, --swap-gas-limit <gas>', 'gas limit for swap transaction', 400000)
       .option('-gd, --deposit-gas-limit <gas>', 'gas limit for deposit transaction (only relevant when using -d interactive)', 2500000)
program.parse()
const options = program.opts()

const oneEther = ethers.utils.parseUnits("1", "ether")
const oneGwei = ethers.utils.parseUnits("1", "gwei")
const validatorDepositSize = oneEther.mul(32)

console.log('Welcome to RocketArb: Deposit!')

function checkOptions(resumeDeposit) {
  if (!options.swapReth && options.fundingMethod != 'self') {
    console.log('Invalid options: when --funding-method isn\'t \'self\' --swap-reth is required')
    process.exit()
  }

  if (options.resume && (options.maxFee || options.maxPrioFee || options.salt)) {
    console.log('Invalid options: cannot specify gas fees or salt with --resume')
    process.exit()
  }

  if (!options.premium && !options.resume && !resumeDeposit && !options.yes) {
    const answer = prompt('Have you tried almost depositing your minipool using the smartnode? ').toLowerCase()
    if (!(answer === 'y' || answer === 'yes')) {
      console.log('Do that first (rocketpool node deposit, but cancel it before completion) then retry.')
      process.exit()
    }
  }

  if (options.salt && resumeDeposit) {
    console.log(`Warning: --salt is ignored when resuming the deposit from ${options.bundleFile}`)
  }

  if ((options.maxFee || options.maxPrioFee) && resumeDeposit) {
    console.log(`Specified gas fees will apply to other transactions, but not the deposit resumed from ${options.bundleFile}`)
  }
}

const randomSigner = ethers.Wallet.createRandom()
const provider = new ethers.providers.JsonRpcProvider(options.rpc)

const ethAddress = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const wethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const rocketStorageAddress = '0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46'
const swapRouterAddress = '0x1111111254EEB25477B68fb85Ed929f73A960582'

const rocketContracts = []

async function populateRocketContracts() {
  if (rocketContracts.length)
    return
  const rocketStorage = new ethers.Contract(
    rocketStorageAddress, ["function getAddress(bytes32 key) view returns (address)"], provider)
  const rethAddress = await rocketStorage.getAddress(
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("contract.addressrocketTokenRETH")))
  const rethContract = new ethers.Contract(
    rethAddress, ["function getRethValue(uint256 ethAmount) view returns (uint256)",
                  "function getExchangeRate() view returns (uint256)",
                  "function approve(address spender, uint256 amount) nonpayable returns (bool)"], provider)
  const rocketDepositSettingsAddress = await rocketStorage.getAddress(
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("contract.addressrocketDAOProtocolSettingsDeposit")))
  const depositSettings = new ethers.Contract(
    rocketDepositSettingsAddress, ["function getDepositFee() view returns (uint256)",
                                   "function getMaximumDepositPoolSize() view returns (uint256)"], provider)
  const rocketDepositPoolAddress = await rocketStorage.getAddress(
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("contract.addressrocketDepositPool")))
  const rocketDepositPool = new ethers.Contract(
    rocketDepositPoolAddress, ["function getBalance() view returns (uint256)",
                               "function deposit() payable"], provider)
  const rocketNodeDepositAddress = await rocketStorage.getAddress(
      ethers.utils.keccak256(ethers.utils.toUtf8Bytes("contract.addressrocketNodeDeposit")))
  rocketContracts.push(rethAddress)
  rocketContracts.push(rethContract)
  rocketContracts.push(depositSettings)
  rocketContracts.push(rocketDepositPool)
  rocketContracts.push(rocketNodeDepositAddress)
  rocketContracts.push(rocketStorage)
}

function oneInchAPI(method, query) {
  const queryString = new URLSearchParams(query).toString()
  const url = `https://api.1inch.dev/swap/v5.2/1/${method}?${queryString}`
  return new Promise((resolve, reject) => {
    const req = https.get(url, {headers: {'Authorization': `Bearer ${process.env.API_KEY}`}},
      (res) => {
        if (res.statusCode !== 200) {
          console.log(`Got ${res.statusCode} from 1inch: ${res.statusMessage}`)
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

async function printPremium() {
  await populateRocketContracts()
  const [rethAddress, rethContract] = rocketContracts
  const primaryRate = await rethContract.getExchangeRate()

  const quoteParams = {
    src: rethAddress,
    dst: wethAddress,
    amount: oneEther.toString(),
    gasLimit: options.swapGasLimit
  }
  const quote = await oneInchAPI('quote', quoteParams)
  const secondaryRate = ethers.BigNumber.from(quote.toAmount)

  const percentage = ethers.utils.formatUnits(
    ((primaryRate.sub(secondaryRate).abs()).mul('100')).mul('1000').div(primaryRate),
    3)
  const direction = primaryRate.lte(secondaryRate) ? 'premium' : 'discount'
  const rateToString = r => ethers.utils.formatUnits(r.sub(r.mod(1e12)))
  console.log(`rETH protocol rate: ${rateToString(primaryRate)} ETH`)
  console.log(`rETH   market rate: ${rateToString(secondaryRate)} ETH`)
  console.log(`${percentage}% ${direction}`)
}

function makeAddKey(tx) {
  function addKey(acc, key) { if (key in tx) acc[key] = tx[key]; return acc }
  return addKey
}
const txFields = "accessList chainId data gasPrice gasLimit maxFeePerGas maxPriorityFeePerGas nonce to type value".split(" ")
const sigFields = "v r s".split(" ")
function runCmd(cmd) {
  if (options.daemon !== 'interactive') {
    return execSync(cmd)
  }

  const args = cmd.split(' ')
  while (args.shift() !== 'api') {}
  if (args.shift() !== 'node') throw new Error('catastrophic failure')

  if (args[0] === 'sign') {
    const origTx = ethers.utils.parseTransaction(`0x${args[1]}`)
    const toSign = txFields.reduce(makeAddKey(origTx), { })
    console.log(`After the > please provide missing (i.e. signature) fields for ${JSON.stringify(toSign)}`)
    const moreFields = JSON.parse(prompt('> '))
    moreFields.v = parseInt(moreFields.v)
    const addKey = makeAddKey(moreFields)
    const rawTx = ethers.utils.serializeTransaction(toSign, sigFields.reduce(addKey, { }))
    return `{"status": "success", "signedData": "${rawTx}"}`
  }

  console.log(`After the > please paste the deposit calldata for ${cmd}`)
  const calldata = prompt('> ')
  const toSign = {
    to: rocketContracts[4],
    value: ethers.BigNumber.from(args[1]),
    data: calldata,
    gasLimit: ethers.BigNumber.from(options.depositGasLimit),
    maxFeePerGas: ethers.utils.parseUnits(options.maxFee || '16', 'gwei'),
    maxPriorityFeePerGas: ethers.utils.parseUnits(options.maxPrio || '2', 'gwei'),
    type: 2,
    chainId: 1
  }
  console.log(`After the > please provide missing (incl. signature) fields for ${JSON.stringify(toSign)}`)
  const moreFields = JSON.parse(prompt('> '))
  moreFields.v = parseInt(moreFields.v)
  const addKey = makeAddKey({...toSign, ...moreFields})
  const rawTx = ethers.utils.serializeTransaction(txFields.reduce(addKey, { }), sigFields.reduce(addKey, { }))
  return rawTx.substring(2)
}

function getDepositTx() {
  let cmd = options.daemon
  let addUseCreditArg = false
  const version = execSync(cmd.concat(' --version')).toString().split(' ')
  if (version.length === 3 && version[0] === 'rocketpool' && version[1] === 'version') {
    console.log(`Got smartnode version ${version[2]}`)
    const [majorVersion, minorVersion] = version[2].split('.')
    if (parseInt(majorVersion) > 1 || (majorVersion == '1' && parseInt(minorVersion) >= 9))
      addUseCreditArg = true
  }
  else {
    console.log(`Error: expected rocketpool version x.y.z, got ${version}`)
    process.exit(1)
  }

  if (options.maxFee) cmd = cmd.concat(' --maxFee ', options.maxFee)
  if (options.maxPrio) cmd = cmd.concat(' --maxPrioFee ', options.maxPrio)
  if (options.extraArgs) cmd = cmd.concat(' ', options.extraArgs)
  const salt = options.salt ? parseInt(options.salt, 16) : Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)

  const amountWei = oneEther.mul(options.amount)
  cmd = cmd.concat(' api node deposit',
    ' ', ethers.utils.formatUnits(amountWei, "wei"),
    ' ', options.minFee.toString(),
    ' ', salt.toString(),
    addUseCreditArg ? ' true' : '',
    ' false')

  console.log(`Creating deposit transaction by executing smartnode: ${cmd}`)

  const cmdOutput = runCmd(cmd)
  const encodedSignedDepositTx = `0x${cmdOutput.toString().trim()}`
  // console.log(`Got tx: ${encodedSignedDepositTx}`)
  console.log(`Got deposit transaction data from smartnode`)
  return encodedSignedDepositTx
}

async function getAmounts(minipoolDepositAmount) {
  const amount = validatorDepositSize.sub(minipoolDepositAmount)
  await populateRocketContracts()
  const [rethAddress, rethContract, depositSettings, rocketDepositPool] = rocketContracts
  const dpFee = await depositSettings.getDepositFee()
  const dpSize = await depositSettings.getMaximumDepositPoolSize()
  const dpSpace = dpSize.sub(await rocketDepositPool.getBalance())
  const maxMintWei = ethers.utils.parseUnits(options.maxMint.toString(), 'ether')
  const tryEthAmount = options.useDp ? amount.add(dpSpace) : amount
  const ethAmount = tryEthAmount.lt(maxMintWei) ? tryEthAmount : maxMintWei
  const depositFee = ethAmount.mul(dpFee).div(oneEther)
  const depositAmount = ethAmount.sub(depositFee)
  const rethAmount = await rethContract.getRethValue(depositAmount)
  console.log(`Total rETH amount to swap: ${ethers.utils.formatUnits(rethAmount, 'ether')} ` +
              `(from ${ethers.utils.formatUnits(ethAmount, 'ether')} ETH deposit (${ethers.utils.formatUnits(depositAmount, 'ether')} after mint fee))`)
  return [ethAmount, rethAmount, rethAddress]
}

async function getSwapData(rethAmount, rethAddress, fromAddress) {
  const swapParams = {
    src: rethAddress,
    dst: fromAddress ? ethAddress : wethAddress,
    from: fromAddress || (options.fundingMethod === 'huffLoan' ? options.huffArbContract : options.arbContract),
    amount: rethAmount,
    slippage: options.slippage,
    gasLimit: options.swapGasLimit,
    allowPartialFill: false,
    disableEstimate: true
  }
  const swap = await oneInchAPI('swap', swapParams)
  if (ethers.utils.getAddress(swap.tx.to) !== swapRouterAddress)
    console.log(`Warning: unexpected to address for swap: ${swap.tx.to}`)
  // console.log(JSON.stringify(swap.tx))
  return swap.tx.data
}

function getFeeData(signedDepositTx, resumedDeposit) {
  // use fee data from deposit tx, but override with options if deposit was resumed
  const feeData = {}

  feeData.maxFeePerGas = signedDepositTx.maxFeePerGas
  if (resumedDeposit && options.maxFee)
    feeData.maxFeePerGas = ethers.utils.parseUnits(options.maxFee, 'gwei')

  feeData.maxPriorityFeePerGas = signedDepositTx.maxPriorityFeePerGas
  if (resumedDeposit && options.maxPrio)
    feeData.maxPriorityFeePerGas = ethers.utils.parseUnits(options.maxPrio, 'gwei')

  return feeData
}

const depositABI = [{"inputs":[{"internalType":"uint256","name":"_bondAmount","type":"uint256"},{"internalType":"uint256","name":"_minimumNodeFee","type":"uint256"},{"internalType":"bytes","name":"_validatorPubkey","type":"bytes"},{"internalType":"bytes","name":"_validatorSignature","type":"bytes"},{"internalType":"bytes32","name":"_depositDataRoot","type":"bytes32"},{"internalType":"uint256","name":"_salt","type":"uint256"},{"internalType":"address","name":"_expectedMinipoolAddress","type":"address"}],"name":"deposit","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"uint256","name":"_bondAmount","type":"uint256"},{"internalType":"uint256","name":"_minimumNodeFee","type":"uint256"},{"internalType":"bytes","name":"_validatorPubkey","type":"bytes"},{"internalType":"bytes","name":"_validatorSignature","type":"bytes"},{"internalType":"bytes32","name":"_depositDataRoot","type":"bytes32"},{"internalType":"uint256","name":"_salt","type":"uint256"},{"internalType":"address","name":"_expectedMinipoolAddress","type":"address"}],"name":"depositWithCredit","outputs":[],"stateMutability":"payable","type":"function"}]
const depositInterface = new ethers.utils.Interface(depositABI)
function getExpectedMinipoolAddress(depositTx) {
  return depositInterface.parseTransaction(depositTx).args.at(-1)
}

async function signTx(tx) {
  // sign randomly first to get around go-ethereum unmarshalling issue
  const fakeSigned = await randomSigner.signTransaction(tx)
  let cmd = options.daemon.concat(' api node sign ', fakeSigned.substring(2))
  await populateRocketContracts()
  const cmdOutput = runCmd(cmd)
  const signOutput = JSON.parse(cmdOutput)
  console.assert(signOutput.status === 'success', `Signing transaction failed: ${signOutput.error}`)
  return signOutput.signedData
}

async function getArbBundleNoFlash(encodedSignedDepositTx, resumedDeposit) {
  // transactions to bundle after the deposit:
  // 1. deposit ethAmount ETH into deposit pool
  // 2. approve swapRouter to transfer rethAmount
  // 3. (if requested) swapTx to swap rETH for ETH (note: not WETH)

  const signedDepositTx = ethers.utils.parseTransaction(encodedSignedDepositTx)
  const feeData = getFeeData(signedDepositTx, resumedDeposit)

  const [ethAmount, rethAmount, rethAddress] = await getAmounts(signedDepositTx.value)
  const [ , rethContract, , rocketDepositPool] = rocketContracts

  const unsignedMintTx = await rocketDepositPool.populateTransaction.deposit({value: ethAmount})
  unsignedMintTx.type = 2
  unsignedMintTx.chainId = signedDepositTx.chainId
  unsignedMintTx.nonce = signedDepositTx.nonce + 1
  unsignedMintTx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
  unsignedMintTx.maxFeePerGas = feeData.maxFeePerGas
  unsignedMintTx.gasLimit = parseInt(options.mintGasLimit)

  const encodedSignedMintTx = await signTx(unsignedMintTx)
  console.log('Signed mint transaction with smartnode')

  const bundle = [
    {signedTransaction: encodedSignedDepositTx},
    {signedTransaction: encodedSignedMintTx}
  ]

  if (options.swapReth) {
    const unsignedApproveTx = await rethContract.populateTransaction.approve(swapRouterAddress, rethAmount)
    unsignedApproveTx.type = unsignedMintTx.type
    unsignedApproveTx.chainId = unsignedMintTx.chainId
    unsignedApproveTx.nonce = unsignedMintTx.nonce + 1
    unsignedApproveTx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
    unsignedApproveTx.maxFeePerGas = feeData.maxFeePerGas
    unsignedApproveTx.gasLimit = parseInt(options.approveGasLimit)

    const encodedSignedApproveTx = await signTx(unsignedApproveTx)
    console.log('Signed approve transaction with smartnode')
    bundle.push({signedTransaction: encodedSignedApproveTx})
    const signer = ethers.utils.parseTransaction(encodedSignedApproveTx).from
    if (signer !== signedDepositTx.from) {
      console.log(`Detected use of signer ${signer} instead of the smartnode (deposit tx) account`)
    }

    const swapData = await getSwapData(rethAmount, rethAddress, signer)
    const unsignedSwapTx = {}
    unsignedSwapTx.to = swapRouterAddress
    unsignedSwapTx.value = 0
    unsignedSwapTx.type = unsignedApproveTx.type
    unsignedSwapTx.chainId = unsignedApproveTx.chainId
    unsignedSwapTx.nonce = unsignedApproveTx.nonce + 1
    unsignedSwapTx.maxPriorityFeePerGas = unsignedApproveTx.maxPriorityFeePerGas
    unsignedSwapTx.maxFeePerGas = unsignedApproveTx.maxFeePerGas
    unsignedSwapTx.data = swapData
    unsignedSwapTx.gasLimit = parseInt(options.swapGasLimit)

    const encodedSignedSwapTx = await signTx(unsignedSwapTx)
    console.log('Signed swap transaction with smartnode')
    bundle.push({signedTransaction: encodedSignedSwapTx})
    const swapSigner = ethers.utils.parseTransaction(encodedSignedSwapTx).from
    if (swapSigner !== signer) {
      console.log(`Error: expected signer ${signer} for swap tx but got ${swapSigner}`)
      process.exit(1)
    }
  }

  return bundle
}

async function getArbTx(encodedSignedDepositTx, resumedDeposit) {
  console.log('Creating arb transaction')

  const useUniswap = options.fundingMethod === 'uniswap'
  const useHuffLoan = options.fundingMethod === 'huffLoan'
  const arbAbi = useHuffLoan ?
    ['function arb(uint256 rETHamount, uint256 ETHamount, uint256 minProfit, bytes swapData) nonpayable'] :
    ["function arb(uint256 wethAmount, uint256 minProfit, bytes swapData) nonpayable"]

  const signedDepositTx = ethers.utils.parseTransaction(encodedSignedDepositTx)
  const [ethAmount, rethAmount, rethAddress] = await getAmounts(signedDepositTx.value)
  if (useUniswap) {
    console.log(`Using RocketUniArb (${options.uniArbContract}) for arbitrage via a Uniswap flash swap (uniswap pool: ${options.uniPool})`)
  }
  else if (useHuffLoan) {
    console.log(`Using RocketDepositArbitrage contract ${options.huffArbContract}`)
  }
  else {
    console.log(`Using RocketDepositArbitrage contract ${options.arbContract}`)
  }
  const swapData = useUniswap ?
    ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [options.uniPool, rethAmount]) :
    await getSwapData(rethAmount, rethAddress)
  const gasRefund = ethers.BigNumber.from(options.gasRefund)
  const minProfit = gasRefund.mul(signedDepositTx.maxFeePerGas)
  const feeData = getFeeData(signedDepositTx, resumedDeposit)

  console.log(`signedDepositTx.nonce = ${signedDepositTx.nonce}`)

  const arbContract = new ethers.Contract(useUniswap ? options.uniArbContract :
                                          useHuffLoan ? options.huffArbContract :
                                          options.arbContract, arbAbi, provider)
  const unsignedArbTx = useHuffLoan ?
    await arbContract.populateTransaction.arb(rethAmount, ethAmount, minProfit, swapData) :
    await arbContract.populateTransaction.arb(ethAmount, minProfit, swapData)
  unsignedArbTx.type = 2
  unsignedArbTx.chainId = signedDepositTx.chainId
  unsignedArbTx.nonce = signedDepositTx.nonce + 1
  unsignedArbTx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
  unsignedArbTx.maxFeePerGas = feeData.maxFeePerGas
  unsignedArbTx.gasLimit = parseInt(options.gasLimit)

  const encodedSignedArbTx = await signTx(unsignedArbTx)
  console.log('Signed arb transaction with smartnode')

  return encodedSignedArbTx
}

async function makeBundle() {
  await populateRocketContracts()
  const encodedSignedDepositTx = getDepositTx()
  if (options.fundingMethod !== 'self') {
    const encodedSignedArbTx = await getArbTx(encodedSignedDepositTx, false)
    const bundle = [
      {signedTransaction: encodedSignedDepositTx},
      {signedTransaction: encodedSignedArbTx}
    ]
    return bundle
  }
  else {
    return await getArbBundleNoFlash(encodedSignedDepositTx, false)
  }
}

async function retrieveDeposit() {
  console.log(`Resuming using deposit from ${options.bundleFile}`)
  const deposit = JSON.parse(await fs.readFile(options.bundleFile, 'utf-8'))[0]
  if (options.fundingMethod !== 'self') {
    const arbTx = await getArbTx(deposit.signedTransaction, true)
    return [deposit, {signedTransaction: arbTx}]
  }
  else {
    return await getArbBundleNoFlash(deposit.signedTransaction, true)
  }
}

async function retrieveBundle() {
  console.log(`Resuming with bundle from ${options.bundleFile}`)
  return JSON.parse(await fs.readFile(options.bundleFile, 'utf-8'))
}

import snapshot from '@snapshot-labs/snapshot.js'

if (options.vote) {
  console.log(`Node Voting Override Interface!`)
  const network = '1'
  let cmd = options.daemon.concat(' api wallet status')
  const walletStatus = JSON.parse(runCmd(cmd))
  const voter = ethers.utils.getAddress(walletStatus.accountAddress)
  console.log(`Voting as ${voter}`)
  const client = new snapshot.Client712('https://hub.snapshot.org')
  const graphqlUrl = 'https://hub.snapshot.org/graphql'
  const space = 'rocketpool-dao.eth'
  const proposalsQuery = {
    __name: 'Proposals',
    proposals: {
      __args: {
        where: {
          space,
          state: 'active'
        }
      },
      id: true,
      choices: true,
      title: true
    }
  }
  const proposals = await snapshot.utils.subgraphRequest(graphqlUrl, proposalsQuery).then(r => r.proposals)
  console.log('')
  console.log(`Open proposals: ${JSON.stringify(proposals)}`)
  const vpQueries = proposals.map(p => ({
    __name: 'Vp',
    vp: {
      __args: {
        voter,
        space,
        proposal: p.id
      },
      vp_by_strategy: true,
    }
  }))
  const vps = await Promise.all(vpQueries.map(q => snapshot.utils.subgraphRequest(graphqlUrl, q))).then(a => a.map(x => x.vp))
  console.log('')
  console.log(`Your current vote power: ${JSON.stringify(proposals.map((p, i) => ({title: p.title, vp: vps[i]})))}`)
  const currentVotesQuery = {
    __name: 'Votes',
    votes: {
      __args: {
        where: {
          voter,
          proposal_in: proposals.map(p => p.id)
        }
      },
      choice: true,
      proposal: { id: true }
    }
  }
  const votes = await snapshot.utils.subgraphRequest(graphqlUrl, currentVotesQuery).then(vs =>
    vs.votes.map(v => {
      const p = proposals.find(p => p.id == v.proposal.id)
      return {
        title: p.title,
        choice: p.choices[v.choice - 1]
      }
    })
  )
  console.log('')
  console.log(`Your current votes: ${JSON.stringify(votes)}`)
  const privKey = JSON.parse(runCmd(options.daemon.concat(' api wallet export'))).accountPrivateKey
  const wallet = new ethers.Wallet(privKey)
  if (wallet.address != voter) {
    console.error(`Error: account from private key did not match voter - exiting`)
    process.exit(1)
  }
  for (const {id, choices, title} of proposals) {
    console.log('')
    const doVote = prompt(`Do you want to change/add your vote on ${title}? `).trim().toLowerCase()
    if (!(doVote === 'y' || doVote === 'yes')) {
      console.log(`Skipping ${title}`)
      continue
    }
    while (true) {
      console.log(`${title} options:`)
      for (const [i, choice] of choices.entries()) {
        console.log(`${i+1}: ${choice}`)
      }
      const input = prompt(`Please select an option number (or q to quit) `).trim().toLowerCase()
      const selection = parseInt(input)
      if (input === 'q' || input === 'quit' || input === 'skip' || input === 'exit') {
        console.log(`Skipping ${title}`)
        break
      }
      else if (1 <= selection && selection <= choices.length) {
        const confirmation = prompt(`Are you sure you want to vote for ${choices[selection-1]} on ${title}? `).trim().toLowerCase()
        if (!(confirmation === 'y' || confirmation === 'yes'))
          continue
        const receipt = await client.vote(wallet, voter, {
          space,
          proposal: id,
          type: 'single-choice',
          choice: selection,
          app: 'rocketarb'
        })
        console.log(`Got receipt: ${JSON.stringify(receipt)}`)
        break
      }
      else {
        console.log(`Invalid selection - please enter a listed option number`)
      }
    }
  }
  process.exit(0)
}

if (options.premium) {
  await printPremium()
  process.exit()
}

const resumeDeposit = await fs.access(options.bundleFile).then(() => !options.resume).catch(() => false)

checkOptions(resumeDeposit)

const bundle = await (
  options.resume ? retrieveBundle() :
  resumeDeposit ? retrieveDeposit() :
  makeBundle()
)
if (!options.resume) {
  console.log(`Saving bundle to ${options.bundleFile}`)
  await fs.writeFile(options.bundleFile, JSON.stringify(bundle))
}

console.log('Waiting for network')
const network = await provider.getNetwork()
console.log(`Got ${JSON.stringify(network)}`)
const flashbotsProvider = await flashbots.FlashbotsBundleProvider.create(
  provider, randomSigner, undefined, network.name)
console.log('Created flashbotsProvider')

const currentBlockNumber = await provider.getBlockNumber()

const depositTx = ethers.utils.parseTransaction(bundle.at(0).signedTransaction)
const minipoolAddress = getExpectedMinipoolAddress(depositTx)
console.log(`Expected minipool address: ${minipoolAddress}`)

const lastTx = ethers.utils.parseTransaction(bundle.at(-1).signedTransaction)
const lastTxMaxFee = ethers.utils.formatUnits(lastTx.maxFeePerGas, 'gwei')
const lastTxMaxPrio = ethers.utils.formatUnits(lastTx.maxPriorityFeePerGas, 'gwei')
console.log(`Max fee of bundle's last tx: ${lastTxMaxFee} gwei (priority: ${lastTxMaxPrio} gwei)`)

if (options.dryRun) {
  console.log(`Dry run only: using flashbots simulate on one block`)
  const currentBlock = await provider.getBlock(currentBlockNumber)
  const currentBaseFeePerGas = currentBlock.baseFeePerGas
  console.log(`Current base fee: ${ethers.utils.formatUnits(currentBaseFeePerGas, 'gwei')} gwei`)
  const targetBlockNumber = currentBlockNumber + 1
  console.log(`Target block number: ${targetBlockNumber}`)
  const signedBundle = await flashbotsProvider.signBundle(bundle)
  const simulation = await flashbotsProvider.simulate(signedBundle, targetBlockNumber)
  console.log(`Simulation results: ${JSON.stringify(simulation, null, 2)}`)
  if ('error' in simulation) {
    console.error(`Simulation error: ${simulation.error.message}`)
  }
}
else {
  if (!options.yes) {
    console.log(`This is your last chance to cancel before submitting a bundle of ${bundle.length} transactions.`)
    const answer = prompt('Are you sure you want to continue? ').toLowerCase()
    if (!(answer === 'y' || answer === 'yes')) {
      console.log('Cancelled')
      process.exit()
    }
  }
  const maxTries = parseInt(options.maxTries)
  const targetBlockNumbers = []
  const promises = []
  for (let targetBlockNumber = currentBlockNumber + 1; targetBlockNumber <= currentBlockNumber + maxTries; targetBlockNumber++) {
    targetBlockNumbers.push(targetBlockNumber)
    promises.push(flashbotsProvider.sendBundle(bundle, targetBlockNumber))
  }
  const submissions = await Promise.all(promises)

  for (const [i, targetBlockNumber] of targetBlockNumbers.entries()) {
    const submission = submissions[i]
    const currentBaseFeePerGas = (await provider.getBlock(await provider.getBlockNumber())).baseFeePerGas
    console.log(`Current base fee: ${ethers.utils.formatUnits(currentBaseFeePerGas, 'gwei')} gwei`)
    console.log(`Target block number: ${targetBlockNumber}`)
    if ('error' in submission) {
      console.log(`RelayResponseError:\n${JSON.stringify(submission)}`)
    }
    else {
      const resolution = await submission.wait()
      console.log(`Resolution: ${flashbots.FlashbotsBundleResolution[resolution]}`)
      if (resolution === flashbots.FlashbotsBundleResolution.BlockPassedWithoutInclusion) {
        continue
      }
      else if (resolution === flashbots.FlashbotsBundleResolution.BundleIncluded) {
        console.log('Bundle successfully included on chain!')
        console.log(`Moving ${options.bundleFile} to bundle.${minipoolAddress}.json`)
        await fs.rename(options.bundleFile, `bundle.${minipoolAddress}.json`)
	console.log(`You might have to restart the smartnode validator container/process for it to pick up the new validator. Otherwise it might miss attestations and block proposals once it is activated by the beaconchain.`)
        process.exit()
      }
      else {
        console.log(`If you are trying to deposit another minipool, (re)move ${options.bundleFile} first.`)
        process.exit()
      }
    }
  }
}
