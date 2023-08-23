#!/usr/bin/env node

/**
   Instructions:

   This script is meant to be run as the daemon for ./rocketarb.js
   e.g. ./rocketarb.js --daemon ./allnodes.js

   You should complete through step 17 in this guide:
   https://blog.allnodes.com/a-step-by-step-guide-for-launching-your-own-rocket-pool-minipool-on-allnodes-777c2972526e

   Then, start step 18 but don't submit the deposit transaction. Instead,
   copy the raw tx calldata and set as an environment variable (ALLNODES_DEPOSIT_CALLDATA)
   when you run the rocketarb.js script. You will also to set the PRIVATE_KEY envvar, using
   the private key you just used to register your node and stake RPL on allnodes.
*/

import 'dotenv/config'
import { ethers } from 'ethers'

const CALLDATA = process.env.ALLNODES_DEPOSIT_CALLDATA
const PRIVKEY = process.env.PRIVATE_KEY
const MAXFEE = process.env.MAX_FEE_PER_GAS || '16'
const PRIOFEE = process.env.MAX_PRIORITY_FEE_PER_GAS || '2'
const GASLIMIT = process.env.GAS_LIMIT || '2500000'
const RPCURL = process.env.RPC_URL || 'http://localhost:8545'

const argv = process.argv

if (argv.length == 3 && argv[2] == '--version') {
  console.log(`rocketpool version 1.10.1`)
  process.exit(0)
}

if (argv.length < 6 || argv[2] !== 'api' || argv[3] !== 'node' ||
    (argv[4] !== 'deposit' && argv[4] !== 'sign')) {
  console.error(`Unexpected arguments ${JSON.stringify(argv)}`)
  process.exit(1)
}

const provider = new ethers.providers.JsonRpcProvider(RPCURL)

function makeAddKey(tx) {
  function addKey(acc, key) { if (key in tx) acc[key] = tx[key]; return acc }
  return addKey
}
const txFields = "accessList chainId data gasPrice gasLimit maxFeePerGas maxPriorityFeePerGas nonce to type value".split(" ")
const sigFields = "v r s".split(" ")

const wallet = new ethers.Wallet(PRIVKEY).connect(provider)
console.warn(`Created signer for ${wallet.address}`)

async function doSign() {
  const origTx = ethers.utils.parseTransaction(`0x${argv[5]}`)
  const signedTx = ethers.utils.parseTransaction(
    await wallet.signTransaction(txFields.reduce(makeAddKey(origTx), { }))
  )
  console.warn('Signed transaction')
  const addKey = makeAddKey(signedTx)
  const rawTx = ethers.utils.serializeTransaction(txFields.reduce(addKey, { }), sigFields.reduce(addKey, { }))
  console.log(`{"status": "success", "signedData": "${rawTx}"}`)
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
  const signedTx = ethers.utils.parseTransaction(await wallet.signTransaction(popTx))
  console.warn('Signed transaction')
  const addKey = makeAddKey(signedTx)
  const rawTx = ethers.utils.serializeTransaction(txFields.reduce(addKey, { }), sigFields.reduce(addKey, { }))
  console.log(rawTx.substring(2))
}

await (argv[4] === 'sign' ? doSign() : doDeposit())
