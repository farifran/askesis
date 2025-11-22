<p align="center">
  <img src="icons/icon-512.svg" width="100" alt="Askesis Logo" style="border-radius: 20px;">
</p>

<h1 align="center">Askesis</h1>

<p align="center">
  Rastreador de Hábitos Estoico. Minimalista. Focado em Privacidade. Impulsionado por IA.
</p>

<p align="center">
  <strong>URL de Produção:</strong> <a href="https://askesis-psi.vercel.app/">https://askesis-psi.vercel.app/</a>
</p>

---

## A Filosofia

Askesis (do grego *ἄσκησις*) significa "treinamento". Na filosofia estoica, refere-se não ao sofrimento físico, mas ao treinamento rigoroso da mente e do caráter.

A maioria das aplicações de rastreamento foca na manutenção de sequências ininterruptas ("streaks"). O Askesis foca na virtude da consistência. O sistema utiliza Inteligência Artificial para atuar como um mentor estoico, analisando padrões de comportamento para oferecer orientações sobre o fortalecimento da disciplina e da vontade, em vez de apenas métricas binárias de sucesso ou falha.

## Funcionalidades Principais

### Gestão de Hábitos
O sistema permite a criação de hábitos personalizados ou a seleção a partir de modelos predefinidos. A configuração de frequência é flexível, suportando periodicidade diária, dias específicos da semana ou intervalos numéricos.

### Interações Gestuais
A interface utiliza padrões de interação nativos móveis. O gesto de deslizar (swipe) permite adiar, excluir ou adicionar notas contextuais aos registros diários, proporcionando uma experiência de uso fluida e eficiente.

### Mentoria com IA (Gemini)
Feedback personalizado baseado na filosofia estoica. O sistema analisa os dados do usuário para celebrar marcos de consolidação (21 e 66 dias) e oferecer insights qualitativos sobre o progresso.

### Crescimento Composto
Visualização de dados que interpreta a consistência como juros compostos. O gráfico demonstra o acúmulo de esforço diário ao longo do tempo, incentivando a persistência a longo prazo.

### Privacidade e Segurança (E2EE)
Implementação de criptografia de ponta a ponta (Client-Side Encryption). Os dados são criptografados localmente utilizando AES-GCM antes da sincronização com a nuvem, garantindo que o servidor não tenha acesso ao conteúdo em texto plano.

### Arquitetura Offline-First (PWA)
A aplicação opera integralmente sem conexão com a internet, sincronizando dados quando a conectividade é restabelecida. Pode ser instalada em dispositivos móveis como um aplicativo nativo.

---

## Arquitetura e Engenharia

Este projeto prioriza princípios de engenharia de software robusta, evitando a complexidade de frameworks de frontend em favor de performance nativa e JavaScript moderno (ESNext).

### Estrutura do Projeto

```text
/
├── api/                 # Vercel Edge Functions (Backend Serverless)
├── locales/             # Arquivos de Tradução (i18n)
├── index.html           # App Shell (Critical Render Path)
├── index.css            # CSS Variável e Responsivo
├── index.tsx            # Ponto de Entrada
├── state.ts             # Gerenciamento de Estado Reativo
├── render.ts            # Motor de Renderização (DOM Updates)
├── cloud.ts             # Sincronização e Resolução de Conflitos
├── crypto.ts            # Criptografia AES-GCM
├── habitActions.ts      # Lógica de Negócios
├── swipeHandler.ts      # Física de Gestos Manuais
└── sw.js                # Service Worker (Estratégia de Cache)
```

### Decisões Técnicas

**1. Performance**
A aplicação não utiliza frameworks como React ou Vue. A manipulação do DOM é direta e otimizada.
*   **Dirty Checking:** O sistema identifica alterações de estado e atualiza apenas os nós do DOM necessários.
*   **Zero-Cost Idle:** Processos intensivos (análise de dados, persistência) são executados via `requestIdleCallback` para não bloquear a thread principal da interface.

**2. Engenharia de Prompt (Otimização de Contexto)**
Para viabilizar a análise de longos históricos de dados pela IA dentro dos limites de tokens, utiliza-se RLE (Run-Length Encoding). Sequências de dados repetitivos são comprimidas antes do envio para a API.

**3. Segurança**
A segurança dos dados é garantida por criptografia simétrica no cliente.
*   **PBKDF2:** Utilizado para derivação de chaves a partir da senha do usuário.
*   **AES-GCM:** Utilizado para criptografar o payload JSON.
*   **Vercel KV:** Utilizado exclusivamente como armazenamento de dados cifrados (blob storage).

---

## Licença

Este projeto é open-source e está licenciado sob a Licença ISC.

---

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Google_Gemini-8E75B2?style=flat-square&logo=google-gemini&logoColor=white" alt="Gemini AI" />
  <img src="https://img.shields.io/badge/Vercel-000000?style=flat-square&logo=vercel&logoColor=white" alt="Vercel" />
  <img src="https://img.shields.io/badge/PWA-5A0FC8?style=flat-square&logo=pwa&logoColor=white" alt="PWA" />
</p>