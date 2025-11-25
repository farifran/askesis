<div align="center" style="background-color: #121212; color: #e5e5e5; padding: 20px; border-radius: 12px;">
  <img src="./icons/icon-512.svg" width="120" alt="Askesis Logo" style="border-radius: 24px; margin-bottom: 10px;">
  <h1 style="color: #e5e5e5; margin: 0;">Askesis</h1>
  <p style="color: #b3b3b3; margin-top: 10px; font-style: italic;">O Rastreador de Hábitos Estoico. Minimalista. Privado. Impulsionado por IA.</p>
  
  <div style="margin-top: 20px;">
    <a href="https://askesis-psi.vercel.app/"><img src="https://img.shields.io/badge/Acessar_App-27ae60?style=for-the-badge&logo=vercel&logoColor=white" alt="Acessar Aplicação"></a>
    <img src="https://img.shields.io/badge/Google_Gemini-174EA6?style=for-the-badge&logo=google-gemini&logoColor=white" alt="Gemini AI" />
    <img src="https://img.shields.io/badge/TypeScript-000000?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  </div>
</div>

---

## A Filosofia

**Askesis** (do grego *ἄσκησις*) significa "treinamento" ou "exercício". Na filosofia estoica, não se trata de sofrimento, mas do **treinamento atlético da mente e do caráter**.

Este software rejeita a gamificação superficial em favor da **virtude da consistência**. Ele utiliza Inteligência Artificial para atuar como um mentor, analisando dados brutos para oferecer conselhos sobre como fortalecer a vontade humana.

### Pilares
1.  **Soberania de Dados:** Os dados pertencem ao usuário e residem no dispositivo (ou num cofre pessoal criptografado na nuvem). Sem rastreamento, sem venda de dados.
2.  **Autonomia Tecnológica:** Uma ferramenta robusta, livre de assinaturas, provando que o auto-aperfeiçoamento não deve ter barreiras financeiras.

---

## Funcionalidades

*   **Calendário de Evolução:** Visualização imediata da consistência diária com anéis de progresso e gestão em massa de hábitos.
*   **Cartões de Hábito:** Rastreamento rico (metas binárias, quantitativas ou temporais) com suporte a gestos (swipe) para ações rápidas.
*   **Mentor Estoico (IA):** Análise semanal e mensal dos padrões de comportamento, fornecendo feedback qualitativo baseado nos escritos de Sêneca, Marco Aurélio e Epicteto.
*   **Sincronização Criptografada:** Arquitetura "Zero-Knowledge". Os dados são criptografados no cliente antes de qualquer transmissão.

---

## Deep Dive Técnico: Engenharia Web Platform

Este projeto demonstra o poder da **Plataforma Web Moderna**, rejeitando a complexidade acidental de frameworks pesados em favor de APIs nativas do navegador para atingir performance e segurança de nível nativo.

### 1. Criptografia Militar no Navegador (Web Crypto API)
Não dependemos de segurança no servidor. Utilizamos a **Web Crypto API** nativa para implementar criptografia ponta-a-ponta (E2EE).
*   **PBKDF2:** Derivação de chave robusta a partir da senha do usuário, com 100.000 iterações para prevenir ataques de força bruta.
*   **AES-GCM:** Criptografia autenticada. O servidor recebe apenas um blob binário ilegível. A descriptografia ocorre exclusivamente na memória do dispositivo do usuário.

### 2. Renderização Não-Bloqueante (requestIdleCallback)
Para garantir 60fps constantes, tarefas computacionalmente intensivas não competem com a thread principal de UI.
*   **Scheduling Inteligente:** Cálculos de estatísticas, parsing de respostas da IA e renderização de gráficos complexos são delegados via `requestIdleCallback`. O navegador executa essas tarefas apenas nos milissegundos ociosos entre frames de renderização.

### 3. Observadores de Alta Performance (IntersectionObserver & ResizeObserver)
Eliminamos listeners de eventos "scroll" e "resize" que causam *layout thrashing*.
*   **Gráficos Responsivos:** O `ResizeObserver` monitora o container do gráfico e dispara o redesenho apenas quando as dimensões físicas mudam, sem polling.
*   **Lazy Loading Lógico:** O `IntersectionObserver` pausa atualizações de componentes que não estão na viewport.

### 4. Internacionalização Nativa (Intl API)
Zero dependências externas para formatação.
*   **Intl.DateTimeFormat & Intl.PluralRules:** Toda a formatação de datas, moedas e regras de pluralização utiliza as bibliotecas C++ subjacentes do navegador, garantindo precisão linguística com custo zero de bundle size.

### 5. Progressive Web App (Service Workers)
*   **Cache-First Strategy:** O App Shell é servido instantaneamente do cache local, permitindo inicialização em 0ms mesmo offline.
*   **Sincronização em Background:** A lógica de rede possui *retry* exponencial e detecção de conectividade para garantir integridade de dados em redes instáveis.

---

## Roadmap

O futuro do Askesis foca na integração profunda com o sistema operacional, mantendo a base web.

### Versão Nativa Android
O objetivo é oferecer uma experiência indistinguível de um app nativo, distribuído via Play Store.
*   **Trusted Web Activity (TWA):** Empacotamento do PWA para execução em contexto nativo sem a barra de navegação do browser.
*   **Widgets na Tela Inicial:** Desenvolvimento de widgets nativos Android que leem o estado local para exibir o progresso diário sem abrir o app.
*   **Health Connect:** Integração bidirecional para ler dados de exercícios e sono automaticamente, alimentando os hábitos de saúde.

---

## Licença

Este projeto é open-source e está licenciado sob a [Licença ISC](LICENSE).