# Network Configuration

Single source of truth for all 0G network endpoints, chain IDs, SDK versions, and environment setup.

## Network Environments

### Testnet (Galileo — Recommended for Development)

| Parameter       | Value                                         |
| --------------- | --------------------------------------------- |
| Network Name    | 0G-Galileo-Testnet                            |
| RPC Endpoint    | `https://evmrpc-testnet.0g.ai`                |
| Chain ID        | `16602`                                       |
| Currency Symbol | 0G                                            |
| Block Explorer  | `https://chainscan-galileo.0g.ai`             |
| Storage RPC     | `https://storagerpc-testnet.0g.ai`            |
| Storage Indexer | `https://indexer-storage-testnet-turbo.0g.ai` |

### Mainnet (Aristotle)

| Parameter       | Value                                 |
| --------------- | ------------------------------------- |
| Network Name    | 0G Mainnet                            |
| RPC Endpoint    | `https://evmrpc.0g.ai`                |
| Chain ID        | `16661`                               |
| Currency Symbol | 0G                                    |
| Block Explorer  | `https://chainscan.0g.ai`             |
| Storage RPC     | `https://storagerpc.0g.ai`            |
| Storage Indexer | `https://indexer-storage-turbo.0g.ai` |

## SDK Versions

| Package                     | Version   | Purpose                                     |
| --------------------------- | --------- | ------------------------------------------- |
| `@0glabs/0g-ts-sdk`         | `^0.3.3`  | Storage operations (upload, download)       |
| `@0glabs/0g-serving-broker` | `^0.6.5`  | Compute operations (inference, fine-tuning) |
| `ethers`                    | `^6.13.0` | Chain interaction (MUST be v6, NOT v5)      |
| `dotenv`                    | `^16.4.0` | Environment variable management             |

## Environment Variables Template

```bash
# .env — NEVER commit this file

# Network Configuration
RPC_URL=https://evmrpc-testnet.0g.ai
CHAIN_ID=16602

# Wallet (NEVER hardcode in source files)
PRIVATE_KEY=your_private_key_here

# Storage Endpoints
STORAGE_INDEXER=https://indexer-storage-testnet-turbo.0g.ai

# Compute
PROVIDER_ADDRESS=your_provider_address

# Optional
OUTPUT_DIR=./output
```

## SDK Initialization Patterns

### ethers v6 Provider (Chain)

```typescript
import { ethers } from 'ethers';
import 'dotenv/config';

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
```

### Storage Client

```typescript
import { ZgFile, Indexer } from '@0glabs/0g-ts-sdk';
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const indexer = new Indexer(process.env.STORAGE_INDEXER!);
```

### Compute Broker

```typescript
import { ethers } from 'ethers';
import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker';

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const broker = await createZGComputeNetworkBroker(wallet);
```

### Browser Environment (Compute)

```typescript
import { BrowserProvider } from 'ethers';
import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker';

if (typeof window.ethereum === 'undefined') {
  throw new Error('Please install MetaMask');
}

const provider = new BrowserProvider(window.ethereum);
const signer = await provider.getSigner();
const broker = await createZGComputeNetworkBroker(signer);
```

## Browser Polyfills

When using 0G SDKs in browser environments:

```bash
pnpm add -D vite-plugin-node-polyfills
```

```javascript
// vite.config.js
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default {
  plugins: [
    nodePolyfills({
      include: ['crypto', 'stream', 'util', 'buffer', 'process'],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
};
```

## Network Selection Helper

```typescript
type Network = 'testnet' | 'mainnet';

function getNetworkConfig(network: Network) {
  const configs = {
    testnet: {
      rpcUrl: 'https://evmrpc-testnet.0g.ai',
      chainId: 16602,
      storageRpc: 'https://storagerpc-testnet.0g.ai',
      storageIndexer: 'https://indexer-storage-testnet-turbo.0g.ai',
      explorer: 'https://chainscan-galileo.0g.ai',
    },
    mainnet: {
      rpcUrl: 'https://evmrpc.0g.ai',
      chainId: 16661,
      storageRpc: 'https://storagerpc.0g.ai',
      storageIndexer: 'https://indexer-storage-turbo.0g.ai',
      explorer: 'https://chainscan.0g.ai',
    },
  };
  return configs[network];
}
```

## References

- [0G Testnet Info](https://docs.0g.ai/run-a-node/testnet-information)
- [0G Storage SDK](https://docs.0g.ai/build-with-0g/storage-network/sdk)
- [0G Compute SDK](https://docs.0g.ai/build-with-0g/compute-network/sdk)
