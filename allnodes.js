#!/usr/bin/env node

require('dotenv').config()

const CALLDATA = process.env.ALLNODES_DEPOSIT_CALLDATA
const PRIVKEY = process.env.PRIVATE_KEY
const MAXFEE = process.env.MAX_FEE_PER_GAS || '16'
const PRIOFEE = process.env.MAX_PRIORITY_FEE_PER_GAS || '2'
const GASLIMIT = process.env.GAS_LIMIT || '2500000'

const ethers = require('ethers')

const argv = process.argv

if (argv.length < 6 || argv[2] !== 'api' || argv[3] !== 'node' ||
    (argv[4] !== 'deposit' && argv[4] !== 'sign')) {
  console.error(`Unexpected arguments ${JSON.stringify(argv)}`)
  process.exit(1)
}

function makeAddKey(tx) {
  function addKey(acc, key) { if (key in tx) acc[key] = tx[key]; return acc }
  return addKey
}
const txFields = "accessList chainId data gasPrice gasLimit maxFeePerGas maxPriorityFeePerGas nonce to type value".split(" ")
const sigFields = "v r s".split(" ")

const wallet = new ethers.Wallet(PRIVKEY)
console.warn(`Created signer for ${wallet.address}`)

async function doSign() {
  const origTx = ethers.utils.parseTransaction(`0x${argv[5]}`)
  const signedTx = await wallet.signTransaction(txFields.reduce(makeAddKey(origTx), { }))
  console.warn('Signed transaction')
  const addKey = makeAddKey(signedTx)
  const rawTx = ethers.utils.serializeTransaction(txFields.reduce(addKey, { }), sigFields.reduce(addKey, { }))
  console.log(`{status: "success", signedData: "${rawTx}"}`)
}

async function doDeposit() {
  const maxFee = ethers.utils.parseUnits(MAXFEE, 'gwei')
  const prioFee = ethers.utils.parseUnits(PRIOFEE, 'gwei')
  const gasLimit = ethers.BigNumber.from(GASLIMIT)
  const tx = {
    to: '0x1Cc9cF5586522c6F483E84A19c3C2B0B6d027bF0',
    value: ethers.BigNumber.from(argv[5]),
    gasLimit: gasLimit,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: prioFee,
    data: CALLDATA,
    type: 2,
    chainId: 1
  }
  const popTx = await wallet.populateTransaction(tx)
  const signedTx = await wallet.signTransaction(popTx)
  console.warn('Signed transaction')
  const addKey = makeAddKey(signedTx)
  const rawTx = ethers.utils.serializeTransaction(txFields.reduce(addKey, { }), sigFields.reduce(addKey, { }))
  console.log(rawTx.substring(2))
}

if (argv[4] === 'sign') {
  doSign()
}
else {
  doDeposit()
}
