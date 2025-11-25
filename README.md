<div align="center">
  <img src="./icons/icon-512.svg" width="120" alt="Askesis Logo">
  <h1>Askesis</h1>
  <p>
    <em>O Rastreador de Hábitos Estoico. Minimalista. Focado em Privacidade. Impulsionado por IA.</em>
  </p>
  
  <p>
    <a href="https://askesis-psi.vercel.app/">
      <img src="https://img.shields.io/badge/Acessar_Aplicação-27ae60?style=for-the-badge&logo=vercel&logoColor=white" alt="Acessar App">
    </a>
  </p>

  <!-- BADGES TÉCNICAS -->
  <div>
    <img src="https://img.shields.io/badge/Google_Gemini-174EA6?style=flat-square&logo=google-gemini&logoColor=white" alt="Gemini AI" />
    <img src="https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/PWA-5A0FC8?style=flat-square&logo=pwa&logoColor=white" alt="PWA" />
    <img src="https://img.shields.io/badge/Web_Crypto_API-333333?style=flat-square" alt="Web Crypto API" />
  </div>
</div>

---

## 🏛️ A Filosofia

**Askesis** (do grego *ἄσκησις*) significa **"treinamento"**. Não se trata de sofrimento, mas do treinamento rigoroso do caráter. 

Diferente de apps focados em gamificação superficial, o Askesis utiliza **Inteligência Artificial (Google Gemini)** atuando como um "Sábio Estoico". Ele analisa seus dados não para gerar gráficos coloridos sem sentido, mas para oferecer conselhos filosóficos personalizados sobre consistência, virtude e força de vontade.

> *"Nós somos o que repetidamente fazemos. A excelência, portanto, não é um ato, mas um hábito."* — Aristóteles

---

## 🧠 Deep Dive Técnico

Este projeto foi construído para ser uma demonstração de **Engenharia de Frontend de Alta Performance**, rejeitando frameworks pesados em favor de Vanilla TypeScript e Web APIs nativas.

### 1. Criptografia "Zero-Knowledge" (Client-Side)
A segurança não é uma reflexão tardia. Utilizamos a **Web Crypto API** nativa do navegador para garantir que o servidor nunca veja os dados do usuário.
*   **Algoritmo:** AES-GCM (Galois/Counter Mode) para autenticidade e confidencialidade.
*   **Derivação de Chave:** PBKDF2 com 100.000 iterações para proteger a chave de sincronização contra força bruta.
*   **Implementação:** Veja `crypto.ts`.

### 2. Performance & Scheduler
Para garantir 60fps cravados mesmo em dispositivos móveis antigos, o app implementa um agendador de tarefas customizado.
*   **`requestIdleCallback`:** Tarefas pesadas (análise de dados para gráficos, logs, pré-carregamento de IA) são processadas apenas quando a thread principal está ociosa.
*   **`IntersectionObserver`:** Utilizado para renderização sob demanda de elementos fora da tela.
*   **DOM Recycling:** O sistema de renderização reutiliza nós DOM existentes em listas longas em vez de destruí-los e recriá-los (visto em `render.ts`), reduzindo a pressão no Garbage Collector.

### 3. Progressive Web App (PWA) Robusto
*   **Offline-First:** Estratégia de cache agressiva no Service Worker (`sw.js`) permite que o app carregue instantaneamente (0ms latência) e funcione totalmente sem internet.
*   **Sincronização Resiliente:** Sistema de filas com *Exponential Backoff* para sincronizar dados criptografados quando a conexão retorna.
*   **Integração Nativa:** Uso da **Badging API** para contadores de notificação no ícone e **Haptics API** para feedback tátil em interações.

---

## ✨ Interface & Experiência

O design segue os princípios do **Brutalismo Utilitário**: alto contraste, tipografia forte e foco absoluto no conteúdo.

*   **Gestos Naturais:** Interações fluídas inspiradas em sistemas nativos. Deslize para editar, segure para ver detalhes.
*   **Acessibilidade (A11y):** Foco gerenciado manualmente para navegação por teclado, atributos ARIA dinâmicos e respeito às preferências de `prefers-reduced-motion`.

---

## 🗺️ Roadmap

O desenvolvimento do Askesis é contínuo. Nossos próximos passos focam em expansão de plataforma e integração de hardware.

- [ ] **Versão Nativa Android:** Desenvolvimento de um app nativo (Kotlin/Jetpack Compose) para permitir Widgets na tela inicial e integração com Quick Settings Tiles.
- [ ] **Comandos de Voz:** Integração com a *Web Speech API* para permitir o registro de hábitos via voz ("Askesis, marque Leitura como feito").
- [ ] **Modo Foco:** Um timer Pomodoro integrado com citações estoicas durante os intervalos.
- [ ] **Exportação de Dados:** Permitir download dos dados em formato JSON/CSV descriptografado.

---

<div align="center">
  <p>Construído com 🧠 e 💻.</p>
  <p><em>© 2025 Askesis Project</em></p>
</div>