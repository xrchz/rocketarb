import 'dotenv/config'
import { ethers } from 'ethers'
import fs from 'node:fs'

const provider = new ethers.providers.JsonRpcProvider('http://localhost:8545')
const wallet = new ethers.Wallet.fromEncryptedJsonSync(
  fs.readFileSync('wallet.json'), process.env.WALLET_PASSWORD)
.connect(provider)

// const arbContract = new ethers.Contract('0xEADc96a160E3a51e7318c0954B28c4a367d5f909', ['function setOwner(address) nonpayable'], wallet)

/* set owner */
// await arbContract.setOwner('gov.ramana.eth')

/* deploy the contract */
const bytecode = fs.readFileSync('RocketDepositArbitrage.evm', 'utf-8').slice(0, -1)
const tx = {
  data: bytecode,
  maxFeePerGas: ethers.utils.parseUnits('11.5', 'gwei'),
  maxPriorityFeePerGas: ethers.utils.parseUnits('0.1', 'gwei'),
  gasLimit: 1000000
}
const gasEstimate = ethers.BigNumber.from(await provider.estimateGas(tx))
tx.gasLimit = gasEstimate.mul(3).div(2)
const response = await wallet.sendTransaction(tx)
console.log(`Submitted https://etherscan.io/tx/${response.hash}`)
const receipt = await response.wait()
console.log(`Status: ${receipt.status}`)
