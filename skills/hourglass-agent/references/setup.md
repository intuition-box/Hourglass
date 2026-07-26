# Setup — wallet, funding, dependencies

One-time steps before the agent can run. The wallet is the agent's identity; the
gas is the only value it ever holds.

## 1. Dependencies

The runners are a self-contained package in this skill's `scripts/` directory
(`package.json` pins viem + @metamask/smart-accounts-kit). Install once:

```bash
cd scripts && bun install
# or: cd scripts && npm install
```

The swap calldata is built by calling the Uniswap Trading API directly (inlined in the
runners) — no extra skill needed.

### Get a Uniswap Trading API key

The runner quotes and builds swaps through the **Uniswap Trading API**, which
requires an API key sent as the `x-api-key` header. It is **agent-side only** —
never shipped to a browser, never committed.

1. Go to the Uniswap developer hub: **https://hub.uniswap.org/** (redirects to the
   Trading API docs / developer portal). The Trading API reference lives at
   https://docs.uniswap.org/api/trading/overview.
2. Sign in and open the developer dashboard, then create / request an API key for
   the **Trading API** (the same key powers `/check_approval`, `/quote`, `/swap`).
   Access may be self-serve or gated behind a request — follow the portal's flow;
   if you hit a "request access" step, submit it and wait for the grant.
3. Copy the key and set it as `UNISWAP_API_KEY` in the agent's environment (step
   below). Verify it works before signing anything: a `/quote` that returns HTTP
   401/403 means the key is missing, wrong, or not yet activated.

If you don't have a key yet, you can still do steps 2–4 here (wallet + funding);
you only need the key at execution time (`discovery.md` / the execution refs).

## 2. Create the agent wallet

The agent needs a keypair. Generate a fresh one and record the **address** (to hand
to the Safe operator) and the **private key** (kept secret, used only to sign the
redeem tx).

With foundry:

```bash
cast wallet new
# Address:     0x…   ← give this to the Safe operator
# Private key: 0x…   ← keep secret; set as AGENT_PRIVATE_KEY
```

Or with viem:

```ts
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
const privateKey = generatePrivateKey()
const account = privateKeyToAccount(privateKey)
console.log('address:', account.address)
console.log('privateKey:', privateKey) // store securely
```

Store the private key in a secret manager or an untracked `.env` (never commit it):

```
AGENT_PRIVATE_KEY=0x…
UNISWAP_API_KEY=…
INTUITION_NETWORK=mainnet
# RPC_URL=https://…   (optional; defaults to a public RPC)
```

## 3. Fund the wallet with gas

Redeeming a delegation is a real transaction — the agent pays its own gas in native
ETH on the mandate's chain (Base 8453 or Ethereum 1). A few dollars of ETH covers
many redeems.

The agent does **not** self-fund. Ask the human operator to send a small amount of
ETH to the address from step 2, then verify:

```ts
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
const client = createPublicClient({ chain: base, transport: http() })
const balance = await client.getBalance({ address: '0x…agent' })
console.log('gas balance (wei):', balance) // must be > 0 before running
```

Do not proceed until the balance is non-zero.

## 4. Hand the address to the Safe operator

Give the agent **address** (not the key) to whoever controls the Safe. They paste it
into Hourglass as the *Agent address* — the **Strategy** tab for a recurring DCA, or
the **Limit order** tab for a single price-triggered buy — configure the mandate (the
per-swap cap for a DCA; the max spend + trigger price for a limit order), and sign it.
The mandate is a Safe message: a multisig Safe must reach its signing threshold before
it finalizes. Once finalized it is published on Intuition (by the publisher backend),
and the agent can discover it — see `discovery.md`.

The Safe operator then copies the **recap JSON** the tab emits after signing and hands
it back to you; it names the mandate (by `delegationHash`) the runner will execute.
