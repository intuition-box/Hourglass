# Notes 0G (Zero Gravity) — exploration de la doc

> Notes prises le 2026-07-25. Un résumé par source, avec ce qui est **vérifié en direct** (appels RPC / API) vs ce qui est **repris de la doc sans vérification**.
> Tout ce qui est marqué ⚠️ est une incohérence ou un point à re-checker avant de coder dessus.

---

## 0. TL;DR — ce qu'il faut retenir

0G = une stack modulaire pour « l'IA décentralisée », composée de 4 briques indépendantes qu'on peut adopter séparément :

| Brique | Rôle | Statut |
|---|---|---|
| **0G Chain** | L1 EVM-compatible, optimisée pour agents IA | Mainnet live |
| **0G Storage** | Stockage distribué de fichiers / datasets / modèles | Live (testnet + mainnet) |
| **0G Compute** | Marketplace GPU décentralisée (inférence + fine-tuning) | Live |
| **0G DA** | Couche de disponibilité de données pour rollups | Live |

Le point d'entrée le plus rapide pour un dev : **le Router de 0G Compute**, une API compatible OpenAI/Anthropic — on change juste `base_url` + `api_key` et ça marche. C'est de loin le morceau le plus concret et le mieux documenté.

---

## 1. Site principal — https://0g.ai/

**Positionnement :** « blockchain conçue pour les agents IA », avec trois promesses : *verifiable compute*, *sealed private inference*, *decentralized storage*.

**Produits mis en avant :** ØG App, Private Computer (`pc.0g.ai`), Chain Hub.

**Stack présentée en 3 couches :**
1. *AI Private Cloud* — infra, exécution, DX
2. *Agentic Alignment* — modèles, alignement/trust/safety, harness (frameworks d'agents), finance (paiements, wallets)
3. *Apps & Operations* — agents autonomes, produits écosystème, opérations réseau, Physical AI

**Chiffres affichés (marketing, non vérifiés) :** 176 Md de tokens IA privés consommés · 2,5 M de comptes · 250+ partenaires écosystème · 12 M de transactions · 36 M de blocs · 2 modèles maison.

> ⚠️ Ce sont des chiffres de landing page. Le compteur de blocs est le seul recoupable : le RPC mainnet renvoyait le bloc `0x25f9209` ≈ **39,8 M** au moment des notes — donc l'ordre de grandeur « 36 M de blocs » tient.

---

## 2. Docs — https://docs.0g.ai/

**Structure du site (85 pages au sitemap).** Grandes sections :

- `introduction/` — understanding-0g, vision-mission, how-to-get-0g
- `concepts/` — chain, storage, compute, da, agentic-id, ai-alignment, depin
- `developer-hub/` — getting-started, testnet, mainnet, building-on-0g (chain, storage, compute, DA, agentic-id, rollups, AVS, indexing)
- `run-a-node/` — validator, storage, DA, archival, migrate-geth-to-reth
- `node-sale/` — vente de nœuds (KYC, éligibilité, récompenses)
- `resources/` — whitepaper, glossary, blog, security, how-to-contribute
- `ai-context` — **page spéciale : tous les paramètres réseau condensés pour être collés dans un LLM** ← très pratique

**Philosophie affichée :** modularité. On n'est pas obligé de tout prendre — un projet sur Ethereum ou Polygon peut n'utiliser que 0G Storage ou 0G Compute sans migrer.

---

## 3. Paramètres réseau ✅ VÉRIFIÉS EN DIRECT

### Testnet « Galileo »
| Paramètre | Valeur | Vérif |
|---|---|---|
| Chain ID | **16602** (`0x40da`) | ✅ `eth_chainId` confirme |
| RPC | `https://evmrpc-testnet.0g.ai` | ✅ répond |
| Explorer | `https://chainscan-galileo.0g.ai` | ✅ HTTP 200 |
| Storage explorer | `https://storagescan-galileo.0g.ai` | ✅ HTTP 200 |
| Indexer storage (turbo) | `https://indexer-storage-testnet-turbo.0g.ai` | ⚠️ racine renvoie 404 (normal pour une API sans route `/`, mais non confirmé fonctionnel) |
| Token | `0G` | doc |
| Faucet | `https://faucet.0g.ai` — **0.1 0G / wallet / jour** | ✅ page up ; le montant vient de la doc |

RPC tiers annoncés pour la prod : QuickNode, ThirdWeb, Ankr, dRPC NodeCloud. Faucet alternatif : Google Cloud Web3 faucet.

### Mainnet « Aristotle »
| Paramètre | Valeur | Vérif |
|---|---|---|
| Chain ID | **16661** (`0x4115`) | ✅ `eth_chainId` confirme |
| RPC | `https://evmrpc.0g.ai` | ✅ répond |
| Explorer | `https://chainscan.0g.ai` (+ `explorer.0g.ai/mainnet/home`) | ✅ HTTP 200 |
| Storage explorer | `https://storagescan.0g.ai` | ✅ HTTP 200 |
| Indexer storage | `https://indexer-storage-turbo.0g.ai` | ⚠️ 404 à la racine |

### Contrats (bytecode présent on-chain ✅)

**Testnet :**
- Flow `0x22E03a6A89B950F1c82ec5e74F8eCa321a105296` ✅ proxy déployé
- Compute Inference `0xa79F4c8311FF93C06b8CfB403690cc987c93F91E` ✅ déployé
- Payment Layer `0x0AD9690e0b34aB2d493DE02cDF149ee34f6C9939` ✅ déployé
- Mine `0x00A9E9604b0538e06b268Fb297Df333337f9593b` (doc, non vérifié)
- Reward `0xA97B57b4BdFEA2D0a25e535bd849ad4e6C440A69` (doc, non vérifié)
- DA Entrance `0xE75A073dA5bb7b0eC622170Fd268f35E675a957B` — ⚠️ **`eth_getCode` renvoie `0x` (aucun bytecode) sur le RPC testnet public.** À re-vérifier avant intégration DA : soit l'adresse a changé, soit elle vit sur un autre réseau/shard.

**Mainnet :** Flow `0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526`, Mine `0xCd01c5Cd953971CE4C2c9bFb95610236a7F414fe`, Reward `0x457aC76B58ffcDc118AABD6DbC63ff9072880870`, Payment Layer `0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32` — **tous ✅ déployés** (bytecode proxy présent).

---

## 4. 0G Chain

**Doc :** `/concepts/chain`, `/developer-hub/building-on-0g/contracts-on-0g/deploy-contracts`

- Consensus : **CometBFT (ex-Tendermint) optimisé**, PoS + BFT, sélection des validateurs par **VRF** (anti-collusion).
- Architecture modulaire : couche consensus séparée de la couche exécution (EVM), upgradables indépendamment.
- Perfs annoncées : **11 000 TPS par shard**, finalité sub-seconde. *(claim marketing, non mesuré ici)*
- Roadmap : consensus DAG pour du parallélisme.
- Compatibilité Ethereum : Cancun-Deneb, et « Pectra » annoncé.

### Déploiement de contrats — le point pratique
Hardhat / Foundry / Truffle supportés, ethers.js & web3.js OK.

⚠️ **Piège concret :** il faut compiler en `evmVersion: "cancun"`, sinon incompatibilité.

```javascript
solidity: {
  version: "0.8.19",
  settings: {
    evmVersion: "cancun",
    optimizer: { enabled: true, runs: 200 }
  }
}
```

Vérification de contrats via ChainScan (URL explorer custom selon testnet/mainnet).

### Précompiles ✅ point vérifié
| Précompile | Adresse (doc) | Rôle |
|---|---|---|
| **DASigners** | `0x…1000` | signatures DA, quorums, vérif de preuves de disponibilité on-chain |
| **Wrapped0GBase** | `0x…1002` | 0G natif wrappé en interface ERC-20 pour la DeFi |

> ⚠️ **Incohérence trouvée dans la doc.** La page `/ai-context` liste `WrappedOGBase` à `0x…1001`, alors que `/precompiles/precompiles-overview` et `/deploy-contracts` disent `0x…1002`.
> **Test on-chain (mainnet) :** un `eth_call` sur `0x…1002` consomme du gas et renvoie une erreur d'exécution → il y a bien un précompile actif. `0x…1001` renvoie `0x` vide, inerte.
> **Conclusion : `0x…1002` est la bonne adresse, `/ai-context` a une coquille.**

Argument de la doc : les précompiles exécutent du code natif et sont « 10-100x moins chers » qu'un équivalent Solidity.

---

## 5. 0G Compute — la partie la plus intéressante

**Doc :** `/concepts/compute`, `/developer-hub/building-on-0g/compute-network/*`

Marketplace GPU décentralisée. Claim : **~90 % moins cher** que le cloud traditionnel. Quatre composants : smart contracts (paiement/vérif), réseau de providers, SDK clients, couche de vérification.

**Trois services :** Inference (live), Fine-tuning (live), Training (à venir).

**Deux chemins d'intégration :**

### A) Le Router (recommandé pour serveur/agents)
Passerelle API devant tout le réseau : découverte de providers, billing on-chain, auth, failover automatique.

| Réseau | Web UI | API |
|---|---|---|
| Mainnet | `pc.0g.ai` | `https://router-api.0g.ai/v1` |
| Testnet | `pc.testnet.0g.ai` | `https://router-api-testnet.integratenetwork.work/v1` |

**Compatible OpenAI ET Anthropic** — on ne change que `base_url` + `api_key`.

```python
from openai import OpenAI
client = OpenAI(base_url="https://router-api.0g.ai/v1", api_key="sk-...")
r = client.chat.completions.create(model="glm-5.2", messages=[{"role":"user","content":"Hello!"}])
```

**Onboarding en 4 étapes :** connecter wallet (MetaMask, WalletConnect, ou login social Google/X/Discord/TikTok via Privy) → déposer des 0G → créer une clé API → requêter.

**Auth — deux types de clés :**
- `sk-` = clés d'inférence, facturées, header `Authorization: Bearer sk-...`
- `mk-` = clés de management (balance, usage, gestion des clés), **non facturées**, scopes `account:read` / `keys:read` / `keys:create` / `keys:manage`
- Garde-fou : une `mk-` ne peut pas gérer d'autres `mk-` (seul le JWT wallet le peut), et `keys:create` est séparé de `keys:manage` pour qu'une clé compromise ne puisse pas s'auto-renouveler.

**Billing :**
- Unité = **neuron**, `1e18 neuron = 1 0G`
- Dépôt sur le Payment Layer (adresses en §3), utilisable en quelques secondes, **un seul dépôt couvre tous les produits 0G**
- `total_cost = (input_tokens × prompt_price) + (output_tokens × completion_price)` — l'input inclut tout le contexte de conversation
- Balance via `/v1/account/balance` (clé `mk-`), plus des endpoints stats + historique paginé
- ⚠️ la doc ne dit rien sur les **retraits**

**Routing — trois niveaux de confiance (header `X-0G-Provider-Trust-Mode`) :**
| Tier | Garantie |
|---|---|
| `standard` | n'importe quel provider adossé TEE |
| `verified` | TeeML + TeeTLS — la réponse vient prouvablement du vrai modèle |
| `private` | TeeML uniquement — **le modèle lui-même tourne dans le TEE** |

Autres headers : `X-0G-Provider-Sort` (latency/price), `X-0G-Provider-Address` (pin un provider), `X-0G-Provider-Max-Price-Usd-*` (plafond de prix, appliqué **avant** le tri donc le failover ne dépasse jamais le plafond), `X-0G-Provider-Allow-Fallbacks`.
Par défaut : round-robin sur les providers sains + retry sur le suivant en cas d'erreur.

**Privacy — ce que le Router stocke :**
- ✅ stocké : request ID, adresse wallet, modèle/provider, nombre de tokens, tier, coût, timestamp
- ❌ **jamais stocké** : prompts, complétions, historiques, fichiers uploadés (audio/images supprimés sous 60 min, images générées sous 30 min)
- Traitement des prompts « en mémoire uniquement pour la durée de la requête »
- Claim explicite : « 0G does not train on your data »
- Tier `private` : Intel **TDX** + GPU TEE, attestations hardware vérifiables via **dstack** (`github.com/Dstack-TEE/dstack`)

### B) Direct (recommandé pour dApps navigateur)
SDK `@0gfoundation/0g-compute-ts-sdk`. Compte principal + **sous-comptes par provider**, requêtes signées par le wallet, choix manuel du provider. Deposit / transfer / refund / withdraw via Web UI, CLI ou SDK.

---

## 6. Catalogue de modèles ✅ RÉCUPÉRÉ EN DIRECT (`GET /v1/models`, sans auth)

**23 modèles** disponibles sur le Router mainnet. Extrait (prix en $/token, `prov` = nb de providers) :

| Modèle | Contexte | Prov. | TEE | $/tok in | $/tok out |
|---|---|---|---|---|---|
| `0gm-1.0-35b-a3b` (modèle maison, agentic coding) | 262k | 1 | TDX | 0.00000008 | 0.00000048 |
| `0gm-1.0-35b-a3b-sia` (MoE 35B + value model 4B) | 32k | 1 | TDX | 0.00000008 | 0.00000048 |
| `glm-5.2` | 1.05M | 3 | TDX | 0.0000009 | 0.000003 |
| `glm-5.1` / `glm-5` | ~200k | 3-4 | TDX | 0.0000007 / 0.0000005 | 0.0000029 / 0.0000023 |
| `deepseek-v4-flash` | 1M | 3 | TDX | 0.00000012 | 0.00000024 |
| `deepseek-v4-pro` | 1M | 1 | TDX | 0.0000015 | 0.0000029 |
| `kimi-k3` | 1.05M | 1 | TDX | 0.000003 | 0.000015 |
| `kimi-k2.7-code` | 262k | 1 | TDX | 0.0000008 | 0.0000033 |
| `minimax-m3` | 1M | 1 | TDX | 0.00000027 | 0.00000108 |
| `qwen3.7-max` / `qwen3.7-plus` / `qwen3.6-plus` | 1M | 1-2 | TDX | 0.0000002–0.0000008 | 0.0000009–0.0000025 |
| `qwen3-vl-30b` (vision) | 262k | 2 | TDX | 0.00000002 | 0.00000019 |
| `hy3` | 262k | 1 | TDX | 0.00000013 | 0.00000053 |
| `whisper-large-v3` (STT) | 448 | 1 | TDX | 0.00001667 | 0 |
| `z-image-turbo` (image) | 2048 | 1 | TDX | **gratuit** | **gratuit** |
| `claude-fable-5` / `claude-opus-4-8` / `claude-sonnet-5` | 1M | 1 | — | 0.000009 / 0.0000045 / 0.0000019 | 0.000045 / 0.0000225 / 0.0000095 |
| `gpt-5.6-luna` / `-terra` / `-sol` | 1M | 1 | — | 0.0000009 / 0.00000225 / 0.0000045 | 0.0000054 / 0.0000135 / 0.000027 |

**Observations importantes :**
- Les modèles propriétaires (Claude, GPT) sont proxifiés **sans TEE** (`tee_attested` absent) — donc **pas de garantie de confidentialité matérielle** dessus. Seuls les modèles open-weights tournent en TDX/dstack. C'est le vrai arbitrage de la plateforme.
- Beaucoup de modèles n'ont **qu'un seul provider** → le « failover automatique » n'a pas grand-chose sur quoi basculer pour ceux-là.
- Les modèles Claude utilisent `supported_formats: ["anthropic"]` (donc endpoint Anthropic, pas OpenAI) avec `cache_control` supporté.
- ⚠️ Le quickstart de la doc cite `zai-org/GLM-5-FP8` comme modèle d'exemple — **cet ID n'existe plus dans le catalogue live** (c'est `glm-5` / `glm-5.2` maintenant). La doc est en retard sur l'API.
- Endpoint `/v1/providers?model=<id>` : renvoie les providers TEE-vérifiés, avec `is_healthy`, `uptime`, `latency` (ms), `tee_attested`, `trust_mode`, et un prix `cached_prompt` réduit (~3x moins cher).

Le testnet a un catalogue distinct (ex. `qwen-image-edit`, édition d'image async).

---

## 7. 0G Storage

**Doc :** `/concepts/storage`, `/developer-hub/building-on-0g/storage/sdk` + `/storage-cli`

**Deux couches :**
- **Log Layer** (immuable, write-once-read-many) → gros fichiers, datasets ML, archives
- **Key-Value Layer** (mutable) → bases de données, profils, état temps réel

**Mécanique :**
- Erasure coding : les données survivent à la perte de **30 % des nœuds**
- **PoRA** (Proof of Random Access) : les mineurs doivent prouver cryptographiquement qu'ils détiennent un chunk et répondre vite. Plage de minage **plafonnée à 8 To** pour que les petits opérateurs restent compétitifs (anti-centralisation).
- Perf annoncée : **200 MB/s en retrieval** même en congestion, via récupération parallèle multi-nœuds
- Claim coût : **~95 % moins cher** que le cloud centralisé (ailleurs la doc dit « 10-100x cheaper » — formulations incohérentes entre pages)

**SDK :**
| Langage | Package | Install |
|---|---|---|
| Go | `github.com/0gfoundation/0g-storage-client` | `go get github.com/...` |
| TypeScript | `@0gfoundation/0g-storage-ts-sdk` | `npm i @0gfoundation/0g-storage-ts-sdk ethers` |

API TS clé : `ZgFile.fromFilePath()`, `MemData` (upload string/buffer sans I/O disque), `indexer.upload()`, `indexer.download()` / `downloadToBlob()`, `Batcher` (KV), chiffrement **AES-256** (header 17 octets) et **ECIES** (header 50 octets).
API Go : `blockchain.MustNewWeb3()`, `indexer.NewClient()`, `SelectNodes()`, `SplitableUpload()`, `core.MerkleRoot()`, `indexer.Download()`.

```typescript
const file = await ZgFile.fromFilePath(filePath);
const [tree, treeErr] = await file.merkleTree();
const [tx, uploadErr] = await indexer.upload(file, RPC_URL, signer);
await file.close();
```

Note : chiffrement **côté client avant upload**. Le fichier est identifié par sa **racine de Merkle** (`--root`), et le download peut valider une preuve de Merkle (`--proof`).
⚠️ Support navigateur limité en download — il faut passer par `StorageNode.downloadSegmentByTxSeq()`.
⚠️ Deux réseaux **indépendants** : « Turbo » et « Standard », avec URLs d'indexer et grilles de frais différentes. Ne pas les mélanger.

**CLI :** `git clone github.com/0gfoundation/0g-storage-client && go build` (Go 1.18+).
Commandes : `upload`, `download`, `upload-dir`, `download-dir`, `kv-write`, `kv-read`, `gateway`, `indexer`.
```bash
0g-storage-client upload   --url <rpc> --key <key> --indexer <url> --file ./report.pdf
0g-storage-client download --indexer <url> --root <merkle_hash> --file ./report.pdf --proof
```

---

## 8. 0G DA

**Doc :** `/concepts/da`, `/da-integration`, `/da-deep-dive`

- Débit annoncé : **50 Gbps démontrés sur le testnet Galileo**
- Taille max d'un blob : **32 505 852 octets** (~31 Mo)
- Pipeline : padding → formation de matrice → encodage redondant → agrégation de signatures
- **Nœuds DA choisis par VRF**, organisés en petits **quorums**, hypothèse de majorité honnête ; consensus par **échantillonnage** (les nœuds échantillonnent, pas de vérification intégrale), puis preuves soumises aux validateurs
- Les chunks erasure-codés sont stockés dans **0G Storage** → différenciateur affiché vs Celestia/EigenDA qui n'ont pas de stockage intégré
- Autres différenciateurs revendiqués : sécurité héritée d'Ethereum (« $80 Md de sécurité crypto-économique »), et randomisation VRF là où EigenDA n'en aurait pas *(claim comparatif partisan, à prendre avec des pincettes)*

**Composants à faire tourner :** DA Client (8 Go RAM, 2 cœurs, 100 MBps), DA Encoder (**GPU NVIDIA requis**, testé sur RTX 4090), DA Retriever (8 Go RAM, 2 cœurs). Images Docker pré-construites disponibles.
Interface : `disperser.proto`, exemple dans `0g-da-example-rust`.

**Intégrations rollups documentées :** OP Stack, Arbitrum Nitro, Caldera (RaaS), + AVS EigenLayer et Babylon sur 0G DA.

---

## 9. Agentic ID (ERC-7857 / ERC-8004)

**Doc :** `/concepts/agentic-id`, `/developer-hub/building-on-0g/agentic-id/*`

Tokenisation des agents IA en NFT, avec transférabilité et propriété réelle des actifs.

**Problème posé :** un ERC-721 classique a des métadonnées statiques et publiques, ne transfère pas « l'intelligence » sous-jacente, et n'a pas de chiffrement natif.

**ERC-7857** — standard NFT pour agents IA : métadonnées **chiffrées**, transfert simultané de la propriété *et* de l'intelligence chiffrée, données dynamiques/évolutives, stockage via 0G Storage, preuves cryptographiques de propriété.

**ERC-8004** (Trustless Agent) : identité et découvrabilité on-chain. Les Agentic IDs sont compatibles ERC-8004 → listables sur 8004scan.

Code d'exemple : `github.com/0gfoundation/0g-agent-nft` (branche `eip-7857-draft`).
⚠️ Aucune adresse de contrat déployée n'est donnée dans la doc.

---

## 10. Run a node

| Type | RAM | CPU | Disque | Bande passante |
|---|---|---|---|---|
| Validator | 64 Go | 8 cœurs | 1 To NVMe | 100 MBps |
| Storage | 16 Go | 4 cœurs | 500 Go–1 To NVMe | **500 MBps** |
| DA | 16 Go | 8 cœurs | 1 To NVMe | 100 MBps |
| Archival | 64 Go | 8 cœurs | 1 To+ NVMe | 100 MBps |

Pages annexes utiles : `migrate-geth-to-reth`, `community-docker-repo`.
Section séparée `node-sale/` : vente de nœuds avec KYC, éligibilité, structure de vente, récompenses (AI Alignment Node).

---

## 11. GitHub — https://github.com/0gfoundation

**118 dépôts.** Les plus actifs (dernière activité juillet 2026) :

| Repo | Langage | Description |
|---|---|---|
| `0g-pc-e2ee` | Go | chiffrement bout-en-bout du Private Computer |
| `0g-reth` | Rust | fork de Reth (client d'exécution) |
| `revm` | Rust | fork de l'EVM Rust |
| `0g-geth` | Go | fork de Geth |
| `0g-serving-broker` | Go | broker côté provider de compute |
| `0g-sandbox` | Go | proxy de facturation : auth par wallet, billing à la minute, règlement on-chain |
| `0g-daytona` | TS | fork de Daytona (v0.189.0) — runtime de sandbox confidentiel |
| `0g-testing-hub` | JS | « teste l'écosystème, gagne du crédit Compute » |
| `0g-compute-ts-sdk` | TS | SDK compute |
| `0g-storage-client` | Go | SDK/CLI storage |
| `0g-tapp` | Rust | — |
| `0g-restaking-contracts` | Solidity | restaking |
| `0g-doc` | TS | la doc elle-même |

**Lecture :** 0G maintient ses propres forks de geth **et** reth **et** revm → ils touchent vraiment à la couche exécution, ce n'est pas un simple rebranding de chaîne EVM. La présence de `0g-daytona` + `0g-pc-e2ee` confirme que la partie « sandbox confidentiel / TEE » est du vrai code.

---

## 12. Builder Hub — https://build.0g.ai/

**Sections :** Stack (Compute / Storage / Chain / **Agentic ID**), Resources (Tools, SDKs, Docs, Tutorials, Showcase), Builds (**173 projets**), + un jeu d'arcade. Projets mis en avant de ETHGlobal Cannes 2026 : plateformes multi-agents, firewalls agentiques, agents conversationnels.

### Section « Zero Coding » (vibecoding) — c'est le raccourci le plus utile

**Outils :** 0G App (interface navigateur pour Storage/Compute), **Claude Code**, **Cursor**.

**Ressources dev-assistant :**
1. **AI Context Documentation** → `https://docs.0g.ai/ai-context` — page condensée (réseaux, RPC, contrats, SDK, snippets) à coller dans le contexte d'un LLM
2. **0G Compute Skills for Claude Code** — package de skills : chatbots, génération d'images, speech-to-text
3. **0G Agent Skills** — **14 skills** + références d'architecture pour Claude Code, Cursor, GitHub Copilot
4. **0G Code to Coin (`0g-cc`)** — **serveur MCP** pour brancher compute + storage décentralisés

**4 prompt templates prêts à l'emploi :** 0G Storage, 0G Chain (Solidity), 0G Compute, 0G DA.

> 💡 Pour toi concrètement : le combo **`docs.0g.ai/ai-context` + les 0G Agent Skills + le MCP `0g-cc`** est le chemin le plus court pour bosser sur 0G depuis Claude Code, sans lire toute la doc.

---

## 13. Explorateurs & outils ✅ tous joignables (HTTP 200)

| Outil | URL | Rôle |
|---|---|---|
| ChainScan Galileo | `chainscan-galileo.0g.ai` | explorer testnet |
| StorageScan Galileo | `storagescan-galileo.0g.ai` | explorer stockage testnet |
| ChainScan | `chainscan.0g.ai` | explorer mainnet |
| StorageScan | `storagescan.0g.ai` | explorer stockage mainnet |
| Faucet | `faucet.0g.ai` | 0.1 0G/jour · **code promo ETH-LISBON-26** pour des tokens en plus |
| Builder Hub | `build.0g.ai` | ressources dev |
| Private Computer | `pc.0g.ai` | UI compute : dépôts, clés API, catalogue |
| Get 0G | `get.0g.ai` | guide interactif d'acquisition |
| 0G Hub | `hub.0g.ai/swap` | swap on-chain (powered by Jaine) |

⚠️ Ce sont toutes des SPA JavaScript — leur contenu n'est pas lisible par un simple fetch HTTP. Seule leur disponibilité a été vérifiée, pas les détails affichés (montants faucet, etc.).

**Obtenir des 0G en mainnet :** CEX (Binance, Bybit, KuCoin, Gate.io, Kraken — retirer sur le réseau « 0G Chain »), bridges (**XSwap** officiel via Chainlink CCIP, + Jumper, Interport, Stargate, Wormhole Portal), swap sur hub.0g.ai.
Wallets : Bitget Wallet a le support intégré ; MetaMask, OKX Wallet, Rabby, SafePal demandent une config manuelle du réseau.

---

## 14. X / Twitter — https://x.com/0G_labs

❌ **Non consultable** : x.com renvoie un HTTP 402 sans authentification. Rien noté ici pour ne rien inventer.

---

## 15. Synthèse critique — ce qui est solide vs ce qui est du marketing

**Solide / vérifiable :**
- Les deux chaînes tournent, chain IDs conformes à la doc (16602 / 16661), mainnet à ~39,8 M de blocs
- Les contrats mainnet (Flow, Mine, Reward, Payment Layer) sont déployés
- Le Router est **réellement live et ouvert** : `/v1/models` répond sans auth, 23 modèles avec prix réels et attestation TEE
- Les forks geth/reth/revm et le code TEE (dstack, daytona) montrent un vrai effort d'ingénierie, pas juste une couche marketing
- Le modèle de billing (neuron, 1e18 = 1 0G) et l'auth `sk-`/`mk-` sont propres et bien pensés

**À prendre avec précaution :**
- « 11 000 TPS par shard », « 50 Gbps DA », « 200 MB/s retrieval », « 90 % / 95 % moins cher » = claims marketing non reproduits ici
- Le coût du stockage est décrit tantôt « 95 % moins cher », tantôt « 10-100x moins cher » selon la page — incohérent
- La comparaison à EigenDA/Celestia est écrite par 0G, donc partisane
- Beaucoup de modèles n'ont **qu'un seul provider** → décentralisation encore limitée en pratique
- Les modèles propriétaires (Claude/GPT) passent **sans TEE** — l'argument privacy ne vaut que pour les open-weights

**Bugs/erreurs de doc relevés :**
1. ⚠️ `/ai-context` donne `WrappedOGBase` à `0x…1001` alors que la bonne adresse est `0x…1002` (confirmé on-chain)
2. ⚠️ Le quickstart Router cite `zai-org/GLM-5-FP8`, un ID **absent du catalogue live**
3. ⚠️ DA Entrance testnet `0xE75A…957B` : **pas de bytecode** sur le RPC testnet public
4. ⚠️ URL de billing dans la nav : la vraie page est `/router/account/deposits` (les variantes `deposits-and-billing` / `deposits-billing` sont en 404)

---

## 16. Prochaines étapes suggérées

1. **Le plus rapide pour tester :** clé API sur `pc.0g.ai`, dépôt de quelques 0G, et une requête OpenAI-compatible sur `glm-5.2` ou `0gm-1.0-35b-a3b`. `z-image-turbo` est gratuit pour tester sans risque.
2. **Pour du dev assisté :** installer le MCP `0g-cc` + les 0G Agent Skills, et charger `docs.0g.ai/ai-context` en contexte.
3. **Pour un contrat :** faucet (code `ETH-LISBON-26`) → Hardhat avec `evmVersion: "cancun"` → chainId 16602.
4. **Avant toute intégration DA :** re-vérifier l'adresse DAEntrance auprès de l'équipe (Discord), le point 3 ci-dessus est bloquant.
