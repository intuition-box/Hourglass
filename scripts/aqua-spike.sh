#!/usr/bin/env bash
#
# Reproduces the Aqua / SwapVM encoding findings in spec/aqua-swapvm-encoding.md
# against a local Anvil fork of Base. Requires foundry (anvil, cast).
#
#   bash scripts/aqua-spike.sh
#
# Forks from mainnet.base.org: the app's pinned Base RPC (publicnode) rejects the
# archive reads Anvil makes when lazily fetching accounts.

set -euo pipefail

RPC=http://127.0.0.1:8546
FORK_RPC=${FORK_RPC:-https://mainnet.base.org}

AQUA=0x499943e74fb0ce105688beee8ef2abec5d936d31
SWAPVM=0x8fDD04Dbf6111437B44bbca99C28882434e0958f
WETH=0x4200000000000000000000000000000000000006
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
USDC_BALANCE_SLOT=9

# Anvil's deterministic accounts 0 and 1.
MAKER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
MAKER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
TAKER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
TAKER_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

# useAquaInsteadOfSignature (1 << 254); receiver 0, no hooks, no expiration.
TRAITS=28948022309329048855892746252171976963317496166410141009864396001978282409984
# flatFeeAmountIn(0.3% = 3_000_000 of 1e9) then xycSwapXD.
PROGRAM=0x1604002dc6c01100
# 18-byte slice indexes + 2-byte flags; IS_EXACT_IN | USE_TRANSFER_FROM_AND_AQUA_PUSH.
TAKER_TRAITS="0x$(printf '0%.0s' $(seq 1 36))0041"

anvil --fork-url "$FORK_RPC" --port 8546 --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
until cast block-number --rpc-url $RPC >/dev/null 2>&1; do sleep 1; done
echo "forked Base at block $(cast block-number --rpc-url $RPC)"

fund_usdc() { # address, raw amount hex (32 bytes)
  cast rpc anvil_setStorageAt "$USDC" \
    "$(cast keccak "$(cast abi-encode 'f(address,uint256)' "$1" $USDC_BALANCE_SLOT)")" \
    "$2" --rpc-url $RPC >/dev/null
}
erc20() { cast call "$1" 'balanceOf(address)(uint256)' "$2" --rpc-url $RPC | awk '{print $1}'; }

ORDER="($MAKER,$TRAITS,$PROGRAM)"
ENCODED=$(cast abi-encode 'f((address,uint256,bytes))' "$ORDER")
HASH=$(cast keccak "$ENCODED")

echo
echo "1. strategyHash agreement"
ONCHAIN=$(cast call $SWAPVM 'hash((address,uint256,bytes))(bytes32)' "$ORDER" --rpc-url $RPC)
echo "   local   $HASH"
echo "   onchain $ONCHAIN"
[ "$HASH" = "$ONCHAIN" ] || { echo "   MISMATCH"; exit 1; }
echo "   match"

echo
echo "2. ship() needs no tokens and no approval"
echo "   maker WETH before ship: $(erc20 $WETH $MAKER)"
cast send $AQUA 'ship(address,bytes,address[],uint256[])' $SWAPVM "$ENCODED" \
  "[$WETH,$USDC]" '[1000000000000000000,2000000000]' \
  --private-key $MAKER_PK --rpc-url $RPC >/dev/null
echo "   shipped 1 WETH / 2000 USDC while holding none"

echo
echo "3. quote reflects the constant-product curve and the 0.3% fee"
cast call $SWAPVM \
  'quote((address,uint256,bytes),address,address,uint256,bytes)(uint256,uint256,bytes32)' \
  "$ORDER" $USDC $WETH 100000000 "$TAKER_TRAITS" --rpc-url $RPC | sed 's/^/   /'

echo
echo "4. end-to-end swap pulls straight from the maker's wallet"
cast send $WETH 'deposit()' --value 1ether --private-key $MAKER_PK --rpc-url $RPC >/dev/null
cast send $WETH 'approve(address,uint256)' $AQUA 1000000000000000000 --private-key $MAKER_PK --rpc-url $RPC >/dev/null
cast send $USDC 'approve(address,uint256)' $AQUA 2000000000 --private-key $MAKER_PK --rpc-url $RPC >/dev/null
fund_usdc $MAKER 0x0000000000000000000000000000000000000000000000000000000077359400
fund_usdc $TAKER 0x0000000000000000000000000000000000000000000000000000000005f5e100
cast send $USDC 'approve(address,uint256)' $SWAPVM 100000000 --private-key $TAKER_PK --rpc-url $RPC >/dev/null
echo "   before: maker WETH $(erc20 $WETH $MAKER) USDC $(erc20 $USDC $MAKER) | taker WETH $(erc20 $WETH $TAKER) USDC $(erc20 $USDC $TAKER)"
cast send $SWAPVM 'swap((address,uint256,bytes),address,address,uint256,bytes)' \
  "$ORDER" $USDC $WETH 100000000 "$TAKER_TRAITS" --private-key $TAKER_PK --rpc-url $RPC >/dev/null
echo "   after:  maker WETH $(erc20 $WETH $MAKER) USDC $(erc20 $USDC $MAKER) | taker WETH $(erc20 $WETH $TAKER) USDC $(erc20 $USDC $TAKER)"

echo
echo "5. dock() moves no tokens and burns the strategy hash"
cast send $AQUA 'dock(address,bytes32,address[])' $SWAPVM "$HASH" "[$WETH,$USDC]" \
  --private-key $MAKER_PK --rpc-url $RPC >/dev/null
echo "   maker WETH after dock: $(erc20 $WETH $MAKER) (unchanged)"
echo "   rawBalances (255 = docked): $(cast call $AQUA 'rawBalances(address,address,bytes32,address)(uint248,uint8)' $MAKER $SWAPVM "$HASH" $WETH --rpc-url $RPC | tr '\n' ' ')"
if cast send $AQUA 'ship(address,bytes,address[],uint256[])' $SWAPVM "$ENCODED" \
     "[$WETH,$USDC]" '[100000000000000000,200000000]' \
     --private-key $MAKER_PK --rpc-url $RPC >/dev/null 2>&1; then
  echo "   UNEXPECTED: re-ship of a docked strategy succeeded"; exit 1
else
  echo "   re-ship of the identical strategy reverts (StrategiesMustBeImmutable)"
fi

echo
echo "6. a salt instruction makes the same parameters shippable again"
SALTED=0x1504000000011604002dc6c01100
ENCODED_SALTED=$(cast abi-encode 'f((address,uint256,bytes))' "($MAKER,$TRAITS,$SALTED)")
cast send $AQUA 'ship(address,bytes,address[],uint256[])' $SWAPVM "$ENCODED_SALTED" \
  "[$WETH,$USDC]" '[100000000000000000,200000000]' \
  --private-key $MAKER_PK --rpc-url $RPC >/dev/null
echo "   shipped, new hash $(cast keccak "$ENCODED_SALTED")"

echo
echo "all checks passed"
