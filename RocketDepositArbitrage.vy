# @version ^0.3.9

MAX_DATA: constant(uint256) = 2**13

interface RocketStorageInterface:
  def getAddress(_key: bytes32) -> address: view

interface RocketDepositPoolInterface:
  def deposit(): payable

interface FlashLoanInterface:
  def flashLoan(receiver: address, token: DynArray[address, 1], amount: DynArray[uint256, 1], data: Bytes[MAX_DATA]): nonpayable

interface WethInterface:
  def approve(_spender: address, _amount: uint256) -> bool: nonpayable
  def balanceOf(_who: address) -> uint256: view
  def deposit(): payable
  def withdraw(_wad: uint256): nonpayable

interface RethInterface:
  def approve(_spender: address, _amount: uint256) -> bool: nonpayable
  def balanceOf(_who: address) -> uint256: view
  def transfer(_to: address, _wad: uint256) -> bool: nonpayable

interface RocketDepositArbitrageInterface:
  def drain(): nonpayable

rocketStorage: immutable(RocketStorageInterface)
rethToken: immutable(RethInterface)
wethToken: immutable(WethInterface)
flashLender: immutable(FlashLoanInterface)
swapRouter: public(address)
owner: public(address)

@external
def __init__():
  self.owner = msg.sender
  rocketStorage = RocketStorageInterface(0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46)
  rethAddress: address = rocketStorage.getAddress(keccak256("contract.addressrocketTokenRETH"))
  rethToken = RethInterface(rethAddress)
  wethToken = WethInterface(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2)
  flashLender = FlashLoanInterface(0xBA12222222228d8Ba445958a75a0704d566BF2C8)
  self.swapRouter = 0x1111111254EEB25477B68fb85Ed929f73A960582

@external
def setOwner(newOwner: address):
  assert msg.sender == self.owner, "only owner can set owner"
  self.owner = newOwner

@external
def setSwapRouter(newSwapRouter: address):
  assert msg.sender == self.owner, "auth"
  self.swapRouter = newSwapRouter

@external
@payable
def __default__():
  assert msg.sender == wethToken.address, "only WETH can send ETH"

@external
def receiveFlashLoan(token: DynArray[address, 1], amount: DynArray[uint256, 1], fee: DynArray[uint256, 1], data: Bytes[MAX_DATA]):
  assert msg.sender == flashLender.address, "only Balancer vault can lend"
  assert token[0] == wethToken.address, "only WETH can be flash loaned"
  assert fee[0] == 0, "no fee allowed"

  wethToken.withdraw(amount[0])

  rocketDepositPool: RocketDepositPoolInterface = RocketDepositPoolInterface(
    rocketStorage.getAddress(keccak256("contract.addressrocketDepositPool")))
  assert rethToken.balanceOf(self) == 0, "unexpected held rETH"
  rocketDepositPool.deposit(value = amount[0])

  assert rethToken.approve(self.swapRouter, rethToken.balanceOf(self)), "rETH approve failed"
  raw_call(self.swapRouter, data)
  assert wethToken.balanceOf(self) >= amount[0], "not enough WETH after swap"
  assert rethToken.balanceOf(self) == 0, "rETH left over after swap"

  assert wethToken.approve(msg.sender, amount[0]), "WETH approve failed"

@external
def arb(wethAmount: uint256, minProfit: uint256, swapData: Bytes[MAX_DATA]):
  RocketDepositArbitrageInterface(self).drain()
  flashLender.flashLoan(self, [wethToken.address], [wethAmount], swapData)
  profit: uint256 = wethToken.balanceOf(self)
  assert profit >= minProfit, "not enough profit"
  wethToken.withdraw(profit)
  send(msg.sender, profit)

@external
def drain():
  rethBalance: uint256 = rethToken.balanceOf(self)
  if 0 < rethBalance:
    rethToken.transfer(self.owner, rethBalance)

  wethBalance: uint256 = wethToken.balanceOf(self)
  if 0 < wethBalance:
    wethToken.withdraw(wethBalance)
  if 0 < self.balance:
    send(self.owner, self.balance)
