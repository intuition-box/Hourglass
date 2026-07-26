# 0G ⇄ Hourglass — carte d'intégration

Document de référence. Où chaque brique 0G se branche (ou ne se branche pas) sur la
couche agentique actuelle de Hourglass. Aucune décision prise ici — c'est l'état des
lieux pour arbitrer.

> **Révisé le 2026-07-26 — lire l'ADR 0008 d'abord.** La première version de ce document
> présentait 0G Tapp comme la plateforme d'hébergement de l'agent. C'était tiré de
> résumés automatiques de README, pas de sources primaires. Vérification faite : **aucun
> produit 0G n'héberge d'application.** Les sections 2.1 et 2.2, le tableau de
> correspondance §3 et les points ouverts §4 ont été corrigés.
>
> Règle de méthode qui en découle : sur 0G, la source est `docs.0g.ai/llms-full.txt` et
> `docs.0g.ai/ai-context.md` en markdown brut, ou le dépôt lu directement. Un résumé est
> une piste, pas une preuve.

Voir [doc-0G.md](doc-0G.md) pour la doc 0G brute (paramètres réseau, SDK, prix, erreurs de doc relevées).

---

## 1. La couche agentique actuelle — ce qui est manuel

Reconstitué depuis `skills/hourglass-agent/SKILL.md`, `scripts/run-limit-order.ts`, `scripts/run-dca.ts`.

| Étape | Aujourd'hui | Qui la porte |
|---|---|---|
| Créer le wallet agent | `cast wallet new` en local, clé écrite dans un `.env` | humain |
| Financer le gas | virement ETH manuel vers l'adresse agent | humain |
| Transmettre l'adresse à l'opérateur | copier-coller dans le Safe App | humain |
| Signer le mandat | Safe App, seuil multisig | humain (attendu) |
| Récupérer le recap JSON | copier-coller → `scripts/instruction.json` | humain |
| Découvrir le mandat | GraphQL Intuition → IPFS (Pinata gateway) | automatisé |
| Polling du prix | `quoteSwap` Uniswap Trading API en boucle | automatisé **mais** tant que le process vit |
| Décider de tirer | comparaison déterministe `quote.output >= minReceived` | automatisé, zéro LLM |
| Exécuter | `redeemDelegations` signé par `AGENT_PRIVATE_KEY` | automatisé |
| Survivre entre sessions | **rien** — « The agent does not run unattended between sessions » | non résolu |

Deux points de friction structurels, cités tels quels dans le SKILL :

> « Your one job the chain can't do for you: **hold a funded key**. »

> « The agent does **not** run unattended between sessions — there is no built-in scheduler. »

Tout le reste (bornes on-chain, non-custodial, révocabilité) est déjà résolu par le
`erc20BalanceChange` + `limitedCalls(1)`. **Le problème n'est pas la confiance dans
l'agent — elle est déjà bornée par la chaîne. Le problème est l'hébergement de la clé
et la persistance du process.**

---

## 2. Ce que 0G apporte, brique par brique

### 2.1 0G Tapp — pas un point de branchement

> **Corrigé le 2026-07-26 (ADR 0008).** La version précédente de cette section décrivait
> Tapp comme une plateforme d'hébergement d'applications, avec `GetSecretResource`,
> `GetEvidence` et une adresse dérivée stable. C'était tiré d'un résumé automatique du
> README, relayé comme du fait. Vérification faite, c'est faux.

Mesuré sur le corpus documentaire complet (`docs.0g.ai/llms-full.txt`, 603 Ko, récupéré
le 2026-07-26) : **`tapp` = 2 occurrences**, toutes deux dans la section *inference
provider*, sous « TEE Node Setup », avec pour prérequis **NVIDIA H100 ou H200 avec
support TEE**, et Dstack ou 0G-TAPP comme deux manières de monter ce nœud.

**Tapp est l'outillage pour devenir provider GPU d'inférence sur 0G Compute.** Ce n'est
pas une plateforme de déploiement d'applications, et 0G n'en publie aucune.

Corroboré par trois surfaces officielles indépendantes :

| Surface | `tapp` | `sandbox` |
|---|---|---|
| `docs.0g.ai/llms-full.txt` | 2 (section provider) | **0** |
| `0gfoundation/0g-agent-skills` (14 guides + 6 patterns) | **0** | **0** |
| `build.0g.ai/zero-coding` | **0** | **0** |

Ce que la page Zero Coding propose réellement : `ai-context` / `llms.txt`, les deux repos
de skills, et le serveur MCP `@0gfoundation/0g-cc`. Rien pour héberger un agent.

### 2.2 0G Sandbox — live, mais hors documentation

Repo : `github.com/0gfoundation/0g-sandbox` (Go). Sandboxes privés pour « vibe coding »,
bâtis sur Tapp + Daytona.

**Ce qui est vérifié par requête directe** (pas par résumé) : le broker testnet répond,
et renvoie chain 16602, un contrat de facturation, un `TappRegistry`, et un provider
enregistré avec ses prix. Voir le tableau d'endpoints dans
`AGENT_EXECUTION_PLAN.md`. C'est réel.

**Ce qui n'est pas vérifié** : tout le reste — dérivation de clé, stabilité d'adresse,
garanties de confidentialité. Ça vient des README.

⚠️ Zéro occurrence dans la doc officielle, dans les deux repos de skills, et sur la page
Zero Coding. C'est un produit annexe, non documenté et sans garantie de stabilité.
Candidat testable pour héberger le runner, pas une décision.

### 2.3 0G Compute (Router) — utile seulement si on ajoute une couche de décision

**État actuel : il n'y a aucun LLM dans la boucle d'exécution.** `run-limit-order.ts`
est purement déterministe (`quote.output >= order.minReceived`). Brancher 0G Compute
n'abstrait donc **rien** de l'existant — ça ajouterait une capacité nouvelle.

Là où ça aurait un sens si le besoin apparaît :
- interprétation d'une consigne en langage naturel → `instruction.json`
- choix de cadence DCA / ajustement de trigger sur signal
- résumé lisible de ce que l'agent a fait sur la période

Compatible OpenAI **et** Anthropic, on ne change que `base_url` + `api_key`
(`https://router-api.0g.ai/v1`).

**Modèles pertinents vu « j'ai pas besoin d'un gros modèle »** (prix live vérifiés, $/token) :

| Modèle | Contexte | in / out | TEE | Note |
|---|---|---|---|---|
| `qwen3-vl-30b` | 262k | 0.00000002 / 0.00000019 | TDX | le moins cher du catalogue, 2 providers |
| `qwen3.7-plus` | 1M | 0.00000022 / 0.00000088 | TDX | 2 providers |
| `0gm-1.0-35b-a3b` | 262k | 0.00000008 / 0.00000048 | TDX | modèle maison, **optimisé agentic coding + tool use**, thinking par défaut |
| `deepseek-v4-flash` | 1M | 0.00000012 / 0.00000024 | TDX | 3 providers (le mieux redondé) |
| `z-image-turbo` | 2048 | gratuit | TDX | pour tester la plomberie sans dépenser |

Ordre de grandeur : à ~2 000 tokens in / 500 out par décision, `qwen3-vl-30b` coûte
**~0,00000014 $ par appel**. Le coût de compute est structurellement négligeable devant
le gas d'un `redeemDelegations`. Ce n'est pas là qu'il faut optimiser.

Cohérence avec le TEE : les modèles open-weights sont attestés TDX/dstack et le tier
`private` (header `X-0G-Provider-Trust-Mode: private`) fait tourner le modèle *dans*
l'enclave. Les modèles propriétaires (Claude, GPT) passent **sans TEE** — si l'argument
« l'agent est confidentiel de bout en bout » est retenu, ils sont exclus.

Facturation : dépôt unique sur le Payment Layer (mainnet `0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32`),
unité **neuron** (`1e18 neuron = 1 0G`), clés `sk-` (inférence) / `mk-` (management).
Un seul dépôt couvre Compute **et** Sandbox.

### 2.4 0G Storage — substitut ou doublon de Pinata

Aujourd'hui : le document de délégation est épinglé sur **Pinata**, lu via
`https://gateway.pinata.cloud/ipfs/` dans `run-limit-order.ts:148`.

0G Storage pourrait porter la même charge (SDK TS `@0gfoundation/0g-storage-ts-sdk`,
identification par racine de Merkle, preuve de Merkle optionnelle au download,
chiffrement client AES-256 / ECIES).

**Mais** : l'identifiant Hourglass est un **CID IPFS**, et il est référencé depuis
Intuition (`uri.startsWith('ipfs://')`, `discoverOrders`). 0G Storage indexe par racine
de Merkle, pas par CID. Un swap Pinata → 0G Storage casse la discovery et le
`FUTURE.md` note déjà une contrainte forte sur le CID (assert `CID === computed`,
limite mono-bloc 262144 octets). **Le rapport bénéfice/risque est mauvais tant
qu'Intuition reste la couche de discovery.**

Cas où ça devient pertinent : stocker les **artefacts d'exécution** de l'agent (logs de
polling, quotes, preuves de fill) — données nouvelles, sans contrainte de CID, et qui
n'existent nulle part aujourd'hui.

### 2.5 Agentic ID (ERC-8004 / ERC-7857) — l'identité de l'agent

Le handoff actuel : l'opérateur colle une **adresse EOA nue** dans le Safe App. Rien ne
dit qui est cet agent, ce qu'il fait, ni s'il est le même que la dernière fois.

- **ERC-8004** (Trustless Agent) : identité et découvrabilité on-chain, listable sur 8004scan
- **ERC-7857** : NFT à métadonnées **chiffrées**, transfert de la propriété *et* de l'intelligence, stockage via 0G Storage
- Code : `github.com/0gfoundation/0g-agent-nft` (branche `eip-7857-draft`)
- ⚠️ Aucune adresse de contrat déployée dans la doc

~~Combiné avec `GetEvidence` de Tapp~~ — retiré (ADR 0008), Tapp n'atteste pas une app
arbitraire. Reste, sans attestation :
`identité ERC-8004` → `attestation TEE` → `adresse agent` → `mandat signé par le Safe`.

### 2.6 0G Chain — hors sujet ici

Les mandats vivent sur **Base (8453)** et **Ethereum (1)** : c'est là que sont déployés
`BALANCE_CHANGE_ENFORCER` (`0xf069a9da3987eDA46F711dC40012f3674c6Ad517`),
`LIMITED_CALLS_ENFORCER` (`0x0c6a3a33d02c7bEb6B066960CE92DF8CC8EA35C8`) et le
`DelegationManager` (`0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3`), et c'est là qu'est
la liquidité Uniswap.

**Rien de tout ça n'existe sur 0G Chain (16661).** Un portage impliquerait de
redéployer le Delegation Framework MetaMask + les enforcers HourGlass, et il n'y a pas
de router Uniswap. Hors scope, sauf décision produit explicite.

0G reste donc une couche **d'exécution et de compute hors-chaîne**, pas une chaîne cible.

---

## 3. Tableau de correspondance

| Friction actuelle | Brique 0G | Maturité de la doc |
|---|---|---|
| La clé agent vit dans un `.env` sur un laptop | **rien chez 0G** — candidat : 0G Sandbox (non documenté) | ADR 0008 |
| Le process meurt à la fin de la session | **rien chez 0G** — candidat : 0G Sandbox, ou auto-hébergé | ADR 0008 |
| L'opérateur ne peut pas vérifier le code derrière l'adresse | **non résolu** — aucune attestation disponible | ADR 0008 |
| L'adresse agent est anonyme | **Agentic ID** ERC-8004 | doc 0G, pas d'adresse déployée |
| Pas de couche de décision en langage naturel | **0G Compute Router** | doc complète, API live vérifiée |
| Financer le gas de l'agent | — | irréductible |
| Signer le mandat dans le Safe | — | irréductible (et c'est voulu) |

---

## 4. Points ouverts à trancher

1. **Où tourne l'agent.** Question rouverte par l'ADR 0008 : aucun produit 0G n'héberge
   d'application. Restent 0G Sandbox (live mais non documenté) et l'auto-hébergement (qui
   fait que Hourglass détient la clé agent). Quel que soit l'hôte, il doit garder la même
   adresse à travers un redémarrage — le mandat est signé vers elle.
2. **Maturité.** Sandbox est **absent de `docs.0g.ai`** (85 pages au sitemap,
   aucune ne les mentionne). Toute l'info vient des README. Contraste net avec le Router,
   documenté et vérifié live.
3. **Chaîne de règlement.** Sandbox facture à la minute sur 0G Chain ; les mandats
   règlent sur Base. Deux chaînes, deux trésoreries à alimenter.
4. **Périmètre.** Selon `.claude/rules/workflow.md`, tout ça est une expansion de scope
   par rapport au POC. Rien ne se code sans autorisation explicite, et une ADR dans
   `.claude/choices/` sera nécessaire si une brique est retenue.

---

## 5. Sources

- Doc officielle : `docs.0g.ai` — sitemap complet, 85 pages
- API live vérifiée : `GET https://router-api.0g.ai/v1/models` (23 modèles, sans auth)
- Chain IDs vérifiés par `eth_chainId` : testnet 16602, mainnet 16661
- README GitHub : `0gfoundation/0g-tapp`, `0gfoundation/0g-sandbox`, `0gfoundation/0g-daytona`, `0gfoundation/0g-agent-nft`
- Code Hourglass lu : `skills/hourglass-agent/SKILL.md`, `scripts/run-limit-order.ts`, `README.md`, `FUTURE.md`, `.claude/rules/*`
