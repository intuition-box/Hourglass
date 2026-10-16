export const DeleGatorModuleFactoryABI = [
  {
    inputs: [
      { name: '_safe', type: 'address' },
      { name: '_salt', type: 'bytes32' },
    ],
    name: 'deploy',
    outputs: [
      { name: 'module_', type: 'address' },
      { name: 'alreadyDeployed_', type: 'bool' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: '_safe', type: 'address' },
      { name: '_salt', type: 'bytes32' },
    ],
    name: 'predictAddress',
    outputs: [{ name: 'predicted_', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'implementation',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'delegationManager',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export const SafeABI = [
  {
    inputs: [{ name: 'module', type: 'address' }],
    name: 'enableModule',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'module', type: 'address' }],
    name: 'isModuleEnabled',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'start', type: 'address' },
      { name: 'pageSize', type: 'uint256' },
    ],
    name: 'getModulesPaginated',
    outputs: [
      { name: 'array', type: 'address[]' },
      { name: 'next', type: 'address' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getOwners',
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getThreshold',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

export const DelegationManagerABI = [
  {
    inputs: [
      {
        components: [
          { name: 'delegate', type: 'address' },
          { name: 'delegator', type: 'address' },
          { name: 'authority', type: 'bytes32' },
          {
            name: 'caveats',
            type: 'tuple[]',
            components: [
              { name: 'enforcer', type: 'address' },
              { name: 'terms', type: 'bytes' },
              { name: 'args', type: 'bytes' },
            ],
          },
          { name: 'salt', type: 'uint256' },
          { name: 'signature', type: 'bytes' },
        ],
        name: 'delegation',
        type: 'tuple',
      },
    ],
    name: 'disableDelegation',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const
