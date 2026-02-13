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
flowchart LR
  subgraph Client[Cliente (Browser/PWA)]
    UI[UI + Render]
    SW[Service Worker]
    IDB[(IndexedDB)]
    SYNC[Sync Worker]
    CRYPTO[Crypto AES-GCM]
  end

  subgraph Cloud[Nuvem]
    API[Vercel API]
    AI[Gemini]
    PUSH[OneSignal]
  end

  UI --> IDB
  UI --> CRYPTO
  CRYPTO --> IDB
  UI --> SW
  UI --> SYNC
  SYNC --> API
  API --> AI
  UI --> PUSH
```

## 3) Componentes Internos (C4 - Nível 3)

```mermaid
flowchart TB
  subgraph App[Askesis App]
    IDX[index.tsx]
    RENDER[render/*]
    LISTEN[listeners/*]
    STATE[state.ts]
    SERVICES[services/*]
  end

  IDX --> RENDER
  IDX --> LISTEN
  LISTEN --> STATE
  RENDER --> STATE
  SERVICES --> STATE

  subgraph Services[Principais serviços]
    PERSIST[persistence.ts]
    MERGE[dataMerge.ts]
    CLOUD[cloud.ts]
    CRYP[crypto.ts]
    ANALYSIS[analysis.ts]
    ACTIONS[habitActions.ts]
  end

  SERVICES --> PERSIST
  SERVICES --> MERGE
  SERVICES --> CLOUD
  SERVICES --> CRYP
  SERVICES --> ANALYSIS
  SERVICES --> ACTIONS
```

## 4) Fluxo de Dados (Local-first + Sync)

```mermaid
sequenceDiagram
  participant User as Usuário
  participant UI as UI
  participant Crypto as Crypto AES-GCM
  participant DB as IndexedDB
  participant Sync as Sync Worker
  participant API as Vercel API

  User->>UI: Marca hábito / adiciona nota
  UI->>Crypto: Serializa e criptografa
  Crypto->>DB: Persiste estado local
  UI->>Sync: Agenda sincronização
  Sync->>API: Envia diff/estado
  API-->>Sync: Estado remoto
  Sync->>UI: Merge resiliente (LWW + dedup)
  UI->>DB: Persistência final consolidada
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

## 6) Máquina de Estados do Hábito

```mermaid
stateDiagram-v2
  [*] --> Pendente
  Pendente --> Concluido: Marcar feito
  Pendente --> Adiado: Marcar adiado
  Adiado --> Concluido: Completar depois
  Concluido --> Pendente: Ajuste de status

  Pendente --> Graduado: Graduação
  Concluido --> Graduado: Graduação
  Adiado --> Graduado: Graduação

  Pendente --> Deletado: Remoção
  Concluido --> Deletado: Remoção
  Adiado --> Deletado: Remoção
  Graduado --> Deletado: Remoção
```

## 7) Mapa rápido de módulos (pasta → responsabilidade)

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
