# MPP on Avalanche

Machine Payments Protocol (MPP) streaming payment channels deployed on Avalanche C-Chain. Adapted from [Tempo's TempoStreamChannel](https://github.com/tempoxyz/tempo) for standard ERC-20 tokens.

## Deployed Contracts

| Network | Address | Chain ID |
|---------|---------|----------|
| **Mainnet** | `0xF1EB69d85897ba945B5E2EbcBAD831bf3671F137` | 43114 |
| **Fuji** | `0x6e2DD66C1bfb66a2b579D291CdF6EA559E93619b` | 43113 |

## What is this?

Payment channels for AI agents and services. Deposit once, sign unlimited off-chain vouchers at zero gas, settle when ready.

```
Agent (payer)                         Service (payee)
  |                                      |
  |-- POST /api/data ------------------>|
  |<-- 402 Payment Required ------------|
  |                                      |
  |-- GET /.well-known/mpp ------------>|
  |<-- { payee, price, token } ---------|
  |                                      |
  |  [open channel on-chain, deposit USDC]
  |                                      |
  |-- POST /api/data + voucher -------->|
  |<-- 200 OK + data ------------------|
  |                                      |
  |  (repeat, cumulative amount grows)   |
  |                                      |
  |         [service settles on-chain when ready]
```

## Project Structure

```
contracts/          Solidity smart contracts (Foundry)
  src/StreamChannel.sol       MPP payment channel (ERC-20 compatible)
  test/StreamChannel.t.sol    22 tests
  script/DeployStreamChannel.s.sol

mpp-example/        TypeScript agent + service example
  src/agent.ts      Payer: opens channel, signs vouchers, calls API
  src/service.ts    Payee: Express server with 402 flow, auto-settles

mpp-site/           Static website with interactive demo
  index.html        Docs + live API console
  app.js            Wallet connection, voucher signing, real API calls
```

## Quick Start

### 1. Run the service (payee)

```bash
cd mpp-example
cp .env.example .env
# Set SERVICE_PRIVATE_KEY in .env
npm install
npm run service
```

### 2. Open the website

Visit `http://localhost:3402` — the service serves the site and the MPP API.

### 3. Or run the agent (CLI)

```bash
# Set PRIVATE_KEY and PAYEE_ADDRESS in .env
npm run agent
```

## Contract Details

- **EIP-712 Domain**: `"Tempo Stream Channel"` v1 (cross-compatible with Tempo)
- **Grace Period**: 15 minutes (for unilateral close)
- **Token**: Any ERC-20 (USDC, USDT, WAVAX, etc.)
- **Safe Transfers**: Handles non-bool-returning tokens (USDT)

## How Vouchers Work

Each voucher is an EIP-712 signed message: `Voucher(bytes32 channelId, uint128 cumulativeAmount)`. The cumulative amount only goes up — each voucher supersedes the last. The service only needs to settle the final voucher on-chain.

## Build & Test Contracts

```bash
cd contracts
forge install  # install forge-std + solady
forge test -vv # 22/22 tests pass
```

## License

MIT
