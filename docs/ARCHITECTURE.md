# Arquitetura do Askesis

Este documento consolida a visão arquitetural do sistema em diagramas Mermaid para facilitar onboarding, revisão técnica e evolução do produto.

## 1) Contexto do Sistema (C4 - Nível 1)

```mermaid
flowchart LR
  U[Usuário]
  A[Askesis PWA]
  G[Google Gemini API]
  V[Vercel Serverless API]
  O[OneSignal]

  U -->|Usa diariamente| A
  A -->|Análise e reflexão| V
  V -->|Proxy de IA| G
  A -->|Registro de push| O
  O -->|Notificações| U
```

## 2) Contêineres (C4 - Nível 2)

```mermaid
flowchart TB
  %% Layout em camadas para reduzir cruzamentos
  subgraph Client["Client (Main Thread)"]
    direction TB
    UI[UI + Render]
    EV["Event Hub - events.ts"]
    PERSIST[persistence.ts]
    IDB[(IndexedDB)]
    CLOUD[cloud.ts]
  end

  subgraph Worker["Client (Worker)"]
    direction TB
    WRPC[workerClient.ts]
    W[sync.worker.ts]
  end

  subgraph Platform["Platform"]
    direction TB
    SW[Service Worker]
  end

  subgraph Cloud["External Services"]
    direction TB
    API[Vercel API]
    AI[Gemini]
    PUSH[OneSignal]
  end

  %% Main thread
  UI --> EV
  UI --> PERSIST
  PERSIST --> IDB
  PERSIST --> CLOUD

  %% Cloud orchestration (worker + remote)
  CLOUD --> WRPC --> W
  CLOUD --> API --> AI

  %% Return paths (remote updates + UI refresh)
  CLOUD -->|persist merged/remote| PERSIST
  CLOUD -->|render/update status| UI
  CLOUD -->|emitHabitsChanged| EV

  %% Service Worker (offline + background sync)
  UI --> SW
  CLOUD -->|register bg sync| SW

  %% Push notifications (delivery goes to SW)
  UI -->|opt-in/consent| PUSH
  PUSH -->|push events| SW
  SW -->|notificationclick| UI
```

## 3) Componentes Internos (C4 - Nível 3)

```mermaid
flowchart TB
  %% Layout em camadas (mais fácil de ler): UI -> Domínio -> Infra
  subgraph UI["UI (DOM)"]
    direction TB
    IDX["index.tsx (boot)"]
    LISTEN["listeners/*"]
    RENDER["render/*"]
    EVENTS["events.ts (event hub)"]
  end

  subgraph DOMAIN["Domínio"]
    direction TB
    ACTIONS["services/habitActions.ts"]
    SELECTORS["services/selectors.ts"]
    ANALYSIS["services/analysis.ts"]
    STATE["state.ts (single source of truth)"]
  end

  subgraph INFRA["Infra (persistência + sync)"]
    direction TB
    PERSIST["services/persistence.ts (IndexedDB)"]
    CLOUD["services/cloud.ts (sync)"]
    WRPC["services/workerClient.ts"]
    WORKER["services/sync.worker.ts"]
    HASH["services/murmurHash3.ts"]
    API["services/api.ts + api/*"]
    SW["sw.js (Service Worker)"]
  end

  %% Boot / UI
  IDX --> LISTEN
  IDX --> RENDER
  IDX --> EVENTS
  IDX --> SW

  %% Domínio
  LISTEN --> ACTIONS
  RENDER --> SELECTORS

  ACTIONS --> STATE
  SELECTORS --> STATE
  ANALYSIS --> STATE

  %% Persistência + Sync
  ACTIONS --> PERSIST
  PERSIST --> STATE
  PERSIST --> CLOUD

  %% Eventos globais (UI plumbing)
  ACTIONS --> EVENTS
  EVENTS --> RENDER
  EVENTS --> LISTEN

  %% Worker / Cloud
  ANALYSIS --> CLOUD
  CLOUD --> WRPC --> WORKER
  CLOUD --> API
  CLOUD --> HASH
  WORKER --> HASH
```

Leitura rápida: interação entra por `listeners/*`, regra de negócio vive em `habitActions.ts`/`selectors.ts`, estado central em `state.ts`, e persistência/sync ficam em `persistence.ts` + `cloud.ts` + `sync.worker.ts`.

## 4) Fluxo de Dados (Local-first + Sync)

```mermaid
sequenceDiagram
  participant User as Usuário
  participant UI as UI
  participant Actions as habitActions
  participant Persist as persistence
  participant DB as IndexedDB
  participant Cloud as cloud.ts
  participant WRPC as workerClient
  participant Crypto as sync.worker (crypto)
  participant API as Vercel API /api/sync
  participant Merge as dataMerge

  User->>UI: Marca hábito / adiciona nota
  UI->>Actions: Atualiza hábito/nota
  Actions->>Persist: saveState() (debounced)
  Persist->>DB: Persistência local (split core + logs)
  Persist-->>Cloud: syncHandler(snapshot)
  Cloud->>WRPC: runWorkerTask(encrypt/decrypt...)
  WRPC->>Crypto: encrypt(shards alterados, syncKey)
  Crypto-->>Cloud: shards criptografados
  Cloud->>API: POST /api/sync
  alt 200 OK
    API-->>Cloud: ACK
  else 409 CONFLICT
    API-->>Cloud: shards remotos
    Cloud->>WRPC: runWorkerTask(decrypt...)
    WRPC->>Crypto: decrypt(shards remotos, syncKey)
    Crypto-->>Cloud: estado remoto
    Cloud->>Merge: mergeStates(local, remoto)
    Merge-->>Cloud: estado consolidado
    Cloud->>Persist: persistStateLocally(merged)
  end
```

## 5) Fluxo de Conflito de Sync

```mermaid
sequenceDiagram
  participant D1 as Dispositivo A
  participant D2 as Dispositivo B
  participant Cloud as Cloud State

  D1->>Cloud: Atualização 1 (hábito renomeado)
  D2->>Cloud: Atualização 2 (mesmo hábito, outro horário)
  Cloud-->>D1: Estado combinado
  Cloud-->>D2: Estado combinado

  Note over D1,D2: Regras de merge:
  Note over D1,D2: 1) Match por ID
  Note over D1,D2: 2) Dedup por nome normalizado
  Note over D1,D2: 3) LWW por schedule/history
```

## 6) Mapa rápido de módulos (pasta → responsabilidade)

- `render/`: composição visual e atualização de DOM.
- `listeners/`: eventos de interação (toque, drag, swipe, modais).
- `services/`: domínio e infraestrutura (persistência, sync, merge, crypto, análise).
- `api/`: endpoints serverless (analyze/sync) e hardening HTTP.
- `tests/`: cenários de jornada, segurança, resiliência e performance.

## Uso no README

Você pode copiar os blocos Mermaid acima e colar no README conforme a necessidade de profundidade:

- Curto: Contexto + Contêineres.
- Médio: + Fluxo de Dados.
- Completo: todos os diagramas.
