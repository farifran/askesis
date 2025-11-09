<div align="center">
<svg width="100%" height="150" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#1e1e1e;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#121212;stop-opacity:1" />
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="3.5" result="coloredBlur"/>
      <feMerge>
        <feMergeNode in="coloredBlur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <rect width="100%" height="150" fill="url(#grad1)"/>
  <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" font-size="60" font-weight="bold" fill="#e5e5e5">
    <tspan fill="#e5e5e5">Askes</tspan><tspan fill="#27ae60" style="filter: url(#glow);">I</tspan><tspan fill="#e5e5e5">s</tspan>
  </text>
  <text x="50%" y="75%" dominant-baseline="middle" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" font-size="16" fill="#b3b3b3">
    Rastreador de Hábitos com IA
  </text>
</svg>
</div>

*Um rastreador de hábitos dinâmico, focado em privacidade, com visualização de dados e feedback personalizado impulsionado por IA, construído com uma arquitetura de alta performance.*

<!-- Inserir aqui um GIF ou screenshot da aplicação -->

---

## Principais Funcionalidades

*   **Rastreamento de Hábitos Detalhado:** Acompanhe hábitos diários, semanais ou com frequência personalizada, com metas numéricas (páginas, minutos) ou simples check-ins.
*   **Visualização de Crescimento Composto:** Um gráfico interativo que visualiza seu progresso e consistência ao longo do tempo.
*   **Feedback com IA (Gemini):** Receba análises semanais, mensais ou gerais sobre sua jornada, com insights e reflexões baseadas na filosofia estoica.
*   **Sincronização na Nuvem com Criptografia de Ponta a Ponta:** Seus dados são criptografados no seu dispositivo (usando AES-GCM e PBKDF2) antes de serem enviados para a nuvem, garantindo privacidade total.
*   **100% Offline (PWA):** Funciona perfeitamente sem conexão com a internet graças a uma robusta estratégia de cache via Service Worker.
*   **Interface Multilíngue:** Suporte para Português, Inglês e Espanhol.
*   **UX Refinada:** Interações fluidas, como deslizar para ações, arrastar e soltar para reorganizar, e atalhos de múltiplos cliques no calendário.

---

## Pilha Tecnológica (Tech Stack)

*   **Frontend:** TypeScript, HTML5, CSS3 (Arquitetura "Vanilla" sem frameworks, focada em performance).
*   **Infraestrutura e Backend (Vercel):**
    *   **Vercel Edge Functions:** Todo o backend, incluindo a comunicação com a API do Gemini e a lógica de sincronização, é executado em Edge Functions. Esta escolha oferece latência global ultrabaixa, escalabilidade automática e se encaixa perfeitamente no generoso plano gratuito da Vercel, eliminando custos de servidor.
    *   **Vercel KV:** Utilizado como banco de dados serverless (baseado em Redis) para armazenar os dados criptografados dos usuários. Sua simplicidade, durabilidade e integração perfeita com o ecossistema Vercel o tornaram a escolha ideal, também coberta pelo plano gratuito.
*   **Inteligência Artificial (Google Gemini):**
    *   A API do Gemini é o cérebro por trás das análises e feedbacks personalizados, orquestrada através das Vercel Edge Functions.
*   **Notificações Push (OneSignal):**
    *   Responsável por gerenciar as inscrições e o envio de notificações push. Foi escolhido por sua robustez, facilidade de integração e, crucialmente, por um plano gratuito completo que atende a todas as necessidades do projeto sem nenhum custo.
*   **Build Tool (esbuild):**
    *   Garante um processo de compilação extremamente rápido, tanto para desenvolvimento quanto para produção.

---

## Estrutura do Projeto

O projeto segue uma arquitetura modular com uma clara separação de responsabilidades:

*   `index.tsx`: Ponto de entrada da aplicação, orquestra a sequência de inicialização.
*   `state.ts`: Define a estrutura de dados (tipos), o estado global e helpers de manipulação de estado.
*   `render.ts`: Contém toda a lógica de renderização e manipulação do DOM.
*   `listeners.ts`: Configura todos os event listeners da aplicação.
*   `habitActions.ts`: Lógica de negócio para criar, editar e atualizar hábitos.
*   `cloud.ts` / `sync.ts` / `crypto.ts`: Lógica do cliente para a sincronização segura na nuvem.
*   `/api`: Contém as Vercel Edge Functions para o backend (análise da IA e sincronização).

---

## Como Executar Localmente

1.  **Instale as dependências:**
    ```bash
    npm install
    ```
2.  **Configure as variáveis de ambiente:** Crie um arquivo `.env` na raiz do projeto e adicione sua chave da API do Gemini:
    ```
    API_KEY="SUA_CHAVE_DA_API_AQUI"
    ```
3.  **Inicie o servidor de desenvolvimento:**
    ```bash
    npm run dev
    ```
    O script de build (`build.js`) irá compilar os arquivos, copiá-los para a pasta `public/` e iniciar um servidor no modo de observação (watch). Para visualizar o projeto, você precisará servir a pasta `public/` com um servidor local.

---

## Destaques da Arquitetura

*   **Performance-First:** A UI utiliza uma estratégia de reconciliação do DOM (similar ao React, mas implementada manualmente) que evita re-renderizações completas. Em vez de reconstruir o HTML, o código atualiza cirurgicamente os atributos e o texto dos elementos existentes, resultando em uma experiência de usuário extremamente rápida e fluida.

*   **Segurança e Privacidade por Design:** A implementação da criptografia de ponta a ponta (E2EE) é um diferencial crucial. A chave de sincronização do usuário nunca sai do dispositivo; ela é usada para derivar uma chave de criptografia (via PBKDF2) que criptografa os dados (via AES-GCM) antes de enviá-los para a nuvem. Isso garante que nem mesmo o servidor possa ler os dados do usuário.

*   **Integridade de Dados Históricos:** O uso de `scheduleHistory` para cada hábito é uma solução sofisticada que permite que as propriedades de um hábito (nome, frequência, etc.) mudem ao longo do tempo sem corromper os dados passados. Quando um hábito é editado, um novo "segmento" de agendamento é criado a partir da data da edição, preservando a precisão do histórico para o gráfico de progresso e as análises da IA.

---

## Um Paradigma de Desenvolvimento: A Simbiose Engenheiro-IA

**Askesis** representa mais do que um projeto de software; é um *case study* sobre um novo paradigma de desenvolvimento. O aplicativo foi inteiramente concebido, arquitetado e construído através de uma colaboração simbiótica entre um único engenheiro de sistemas e a IA Gemini.

<div style="display: flex; gap: 16px; justify-content: space-around; flex-wrap: wrap; margin: 24px 0;">
  <div style="background-color: #1e1e1e; border: 1px solid #2a2a2a; border-radius: 8px; padding: 16px; text-align: center; flex: 1; min-width: 200px;">
    <h4 style="margin: 0 0 8px 0; color: #b3b3b3; font-size: 14px; font-weight: 500;">TEMPO DE DESENVOLVIMENTO</h4>
    <p style="margin: 0; color: #e5e5e5; font-size: 24px; font-weight: 700;">~40 Horas</p>
    <p style="margin: 4px 0 0 0; color: #737373; font-size: 12px;">(1 semana)</p>
  </div>
  <div style="background-color: #1e1e1e; border: 1px solid #2a2a2a; border-radius: 8px; padding: 16px; text-align: center; flex: 1; min-width: 200px;">
    <h4 style="margin: 0 0 8px 0; color: #b3b3b3; font-size: 14px; font-weight: 500;">TAMANHO DA EQUIPE</h4>
    <p style="margin: 0; color: #e5e5e5; font-size: 24px; font-weight: 700;">1 Engenheiro + IA</p>
    <p style="margin: 4px 0 0 0; color: #737373; font-size: 12px;">(Parceria simbiótica)</p>
  </div>
  <div style="background-color: #1e1e1e; border: 1px solid #2a2a2a; border-radius: 8px; padding: 16px; text-align: center; flex: 1; min-width: 200px;">
    <h4 style="margin: 0 0 8px 0; color: #b3b3b3; font-size: 14px; font-weight: 500;">CUSTO DE INFRAESTRUTURA</h4>
    <p style="margin: 0; color: #e5e5e5; font-size: 24px; font-weight: 700;">$0 / mês</p>
    <p style="margin: 4px 0 0 0; color: #737373; font-size: 12px;">(Vercel & OneSignal Free Tier)</p>
  </div>
</div>

<div style="margin: 32px 0; text-align: center;">
  <h4 style="margin: 0 0 16px 0; color: #b3b3b3; font-size: 16px; font-weight: 600;">Comparativo de Tempo de Desenvolvimento (Estimado)</h4>
  <svg width="90%" height="250" viewBox="0 0 300 250" xmlns="http://www.w3.org/2000/svg" style="background-color: #1e1e1e; border-radius: 8px; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;">
    <!-- Eixo Y e linhas de grade -->
    <text x="35" y="55" text-anchor="end" fill="#737373" font-size="12">6 sem</text>
    <line x1="40" y1="50" x2="280" y2="50" stroke="#2a2a2a" stroke-dasharray="2"/>
    <text x="35" y="95" text-anchor="end" fill="#737373" font-size="12">4 sem</text>
    <line x1="40" y1="90" x2="280" y2="90" stroke="#2a2a2a" stroke-dasharray="2"/>
    <text x="35" y="135" text-anchor="end" fill="#737373" font-size="12">2 sem</text>
    <line x1="40" y1="130" x2="280" y2="130" stroke="#2a2a2a" stroke-dasharray="2"/>
    <text x="35" y="175" text-anchor="end" fill="#737373" font-size="12">0 sem</text>
    <line x1="40" y1="170" x2="280" y2="170" stroke="#737373"/>

    <!-- Barra 1: Tradicional -->
    <rect x="80" y="70" width="50" height="100" fill="#737373" rx="4"/>
    <text x="105" y="65" text-anchor="middle" fill="#e5e5e5" font-size="12" font-weight="bold">~5 semanas</text>
    <text x="105" y="190" text-anchor="middle" fill="#b3b3b3" font-size="12">Tradicional</text>

    <!-- Barra 2: Askesis (IA) -->
    <rect x="170" y="150" width="50" height="20" fill="#27ae60" rx="4"/>
    <text x="195" y="145" text-anchor="middle" fill="#e5e5e5" font-size="12" font-weight="bold">1 semana</text>
    <text x="195" y="190" text-anchor="middle" fill="#b3b3b3" font-size="12">Askesis (IA)</text>
  </svg>
</div>

Neste modelo, os papéis foram divididos de forma complementar:

#### O Engenheiro como Visionário e Tomador de Decisões:
*   **Definiu a visão do produto,** os requisitos funcionais e os objetivos estratégicos.
*   Atuou como o **árbitro final da qualidade,** avaliando criticamente as sugestões da IA, selecionando as melhores abordagens arquitetônicas e garantindo que cada funcionalidade estivesse alinhada com a experiência do usuário desejada.
*   Foi responsável pela **decomposição de problemas complexos** em prompts acionáveis, guiando a IA na direção correta.
*   **Integrou, depurou e refinou** todo o código gerado, garantindo a coesão e a robustez do sistema como um todo.

#### A IA como Colaborador Especializado:
Enquanto o engenheiro guiava, a IA transcendia o papel de uma simples ferramenta, atuando como:
*   **Arquiteto de Software:** Colaborou na definição da estrutura modular, na estratégia de gerenciamento de estado e na arquitetura de segurança.
*   **Especialista em UI/UX:** Idealizou e refinou componentes da interface, desde o design do gráfico até a implementação de microinterações.
*   **Analista de Qualidade e Performance:** Analisou proativamente o código em busca de otimizações, identificou bugs de lógica e sugeriu correções robustas.
*   **Especialista de Domínio:** Forneceu as citações estoicas e ajudou a estruturar os prompts para obter o máximo da API do Gemini.

Este modelo de desenvolvimento não se trata de substituir o engenheiro, mas de **amplificar suas capacidades**. A IA acelera a execução e oferece uma vasta gama de soluções, enquanto o engenheiro fornece a direção estratégica, o julgamento crítico e a coesão do sistema. O resultado é um produto que demonstra o potencial transformador da colaboração humano-IA na engenharia de software moderna.

---

## Licença

Este projeto está licenciado sob a [Licença ISC](LICENSE).
