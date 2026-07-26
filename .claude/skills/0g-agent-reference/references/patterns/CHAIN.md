# Chain Patterns

EVM patterns, deployment configurations, and best practices for 0G Chain.

## Overview

0G Chain is an EVM-compatible Layer 1 blockchain. It supports standard Solidity smart contracts with
a critical requirement: **all contracts must be compiled with `evmVersion: "cancun"`**.

## Hardhat Configuration

```typescript
// hardhat.config.ts
import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import 'dotenv/config';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun', // REQUIRED for 0G Chain
    },
  },
  networks: {
    '0g-testnet': {
      url: 'https://evmrpc-testnet.0g.ai',
      chainId: 16602,
      accounts: [process.env.PRIVATE_KEY!],
    },
    '0g-mainnet': {
      url: 'https://evmrpc.0g.ai',
      chainId: 16661,
      accounts: [process.env.PRIVATE_KEY!],
    },
  },
};

export default config;
```

## Foundry Configuration

```toml
# foundry.toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
evm_version = "cancun"  # REQUIRED for 0G Chain
solc_version = "0.8.24"
optimizer = true
optimizer_runs = 200

[rpc_endpoints]
0g_testnet = "https://evmrpc-testnet.0g.ai"
0g_mainnet = "https://evmrpc.0g.ai"
```

## Contract Deployment

### With Hardhat

```typescript
// scripts/deploy.ts
import { ethers } from 'hardhat';

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying with:', deployer.address);

  const Contract = await ethers.getContractFactory('MyContract');
  const contract = await Contract.deploy(/* constructor args */);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log('Deployed to:', address);
}

main().catch(console.error);
```

```bash
npx hardhat run scripts/deploy.ts --network 0g-testnet
```

### With Foundry

```bash
forge create src/MyContract.sol:MyContract \
  --rpc-url https://evmrpc-testnet.0g.ai \
  --private-key $PRIVATE_KEY \
  --constructor-args "arg1" "arg2"
```

### With ethers v6 (Direct)

```typescript
import { ethers, ContractFactory } from 'ethers';
import 'dotenv/config';

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

// ABI and bytecode from compilation output
const factory = new ContractFactory(abi, bytecode, wallet);
const contract = await factory.deploy(/* constructor args */);
await contract.waitForDeployment();

console.log('Deployed to:', await contract.getAddress());
```

## Contract Interaction

### Read (View Functions)

```typescript
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const contract = new ethers.Contract(contractAddress, abi, provider);

// Read-only calls (no gas)
const value = await contract.getValue();
const balance = await contract.balanceOf(address);
```

### Write (State-Changing Functions)

```typescript
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const contract = new ethers.Contract(contractAddress, abi, wallet);

// State-changing calls (costs gas)
const tx = await contract.setValue(42);
const receipt = await tx.wait();
console.log('Tx hash:', receipt.hash);
```

### Events

```typescript
// Listen for events
contract.on('Transfer', (from, to, amount) => {
  console.log(`Transfer: ${from} → ${to}: ${amount}`);
});

// Query past events
const filter = contract.filters.Transfer(null, myAddress);
const events = await contract.queryFilter(filter, fromBlock, toBlock);
```

## ethers v6 Migration Notes

0G Chain examples use ethers v6 exclusively. Key differences from v5:

| v5 (DO NOT USE)                    | v6 (CORRECT)                   |
| ---------------------------------- | ------------------------------ |
| `ethers.providers.JsonRpcProvider` | `ethers.JsonRpcProvider`       |
| `ethers.utils.parseEther`          | `ethers.parseEther`            |
| `ethers.utils.formatEther`         | `ethers.formatEther`           |
| `contract.deployed()`              | `contract.waitForDeployment()` |
| `contract.address`                 | `await contract.getAddress()`  |
| `BigNumber.from()`                 | Native `BigInt`                |
| `ethers.utils.keccak256`           | `ethers.keccak256`             |

## Gas Estimation

```typescript
const gasEstimate = await contract.setValue.estimateGas(42);
console.log('Estimated gas:', gasEstimate.toString());

// With manual gas limit
const tx = await contract.setValue(42, {
  gasLimit: (gasEstimate * 120n) / 100n, // 20% buffer
});
```

## Verification

### Hardhat Verify

```bash
npx hardhat verify --network 0g-testnet <CONTRACT_ADDRESS> "arg1" "arg2"
```

### Foundry Verify

```bash
forge verify-contract <CONTRACT_ADDRESS> src/MyContract.sol:MyContract \
  --chain-id 16602 \
  --verifier-url https://chainscan-galileo.0g.ai/api
```

## Critical Rules

### ALWAYS

- Use `evmVersion: "cancun"` in compiler settings
- Use ethers v6 syntax (NOT v5)
- Load private keys from environment variables
- Wait for transaction confirmation (`tx.wait()`)
- Test on testnet before mainnet deployment

### NEVER

- Use `evmVersion` other than `"cancun"` for 0G Chain
- Use ethers v5 patterns (`ethers.providers`, `ethers.utils`, etc.)
- Hardcode private keys in source files
- Deploy to mainnet without testnet validation

## Common Errors

| Error                 | Cause                | Fix                             |
| --------------------- | -------------------- | ------------------------------- |
| `invalid opcode`      | Wrong evmVersion     | Set `evmVersion: "cancun"`      |
| `execution reverted`  | Contract logic error | Check require/revert conditions |
| `insufficient funds`  | Wallet empty         | Fund from faucet (testnet)      |
| `nonce too low`       | Pending tx           | Wait or manually set nonce      |
| `cannot estimate gas` | Function will revert | Check function parameters       |

## References

- [0G Chain Docs](https://docs.0g.ai/build-with-0g/0g-chain)
- [Hardhat Documentation](https://hardhat.org/docs)
- [Foundry Documentation](https://book.getfoundry.sh)
- [ethers v6 Migration](https://docs.ethers.org/v6/migrating/)
- See also: [NETWORK_CONFIG.md](./NETWORK_CONFIG.md), [SECURITY.md](./SECURITY.md)
