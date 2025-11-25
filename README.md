<div align="center" style="background-color: #121212; color: #e5e5e5; padding: 40px; border-radius: 20px;">
  <img src="icons/icon-512.svg" width="120" alt="Askesis Logo" style="border-radius: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
  <h1 style="font-size: 3em; margin-bottom: 10px; margin-top: 20px;">Askesis</h1>
  <p style="font-size: 1.2em; color: #b3b3b3; max-width: 600px; margin: 0 auto;">
    <em>O Rastreador de Hábitos Estoico. Minimalista. Focado em Privacidade. Impulsionado por IA.</em>
  </p>
  <br>
  
  <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
    <a href="https://askesis-psi.vercel.app/">
      <img src="https://img.shields.io/badge/Acessar_Aplicação-27ae60?style=for-the-badge&logo=vercel&logoColor=white" alt="Acessar App" height="40">
    </a>
  </div>
  
  <br>

  <!-- BADGES TÉCNICAS -->
  <div>
    <img src="https://img.shields.io/badge/Google_Gemini-174EA6?style=flat-square&logo=google-gemini&logoColor=white" alt="Gemini AI" />
    <img src="https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/PWA-5A0FC8?style=flat-square&logo=pwa&logoColor=white" alt="PWA" />
    <img src="https://img.shields.io/badge/Vercel_KV-000000?style=flat-square&logo=vercel&logoColor=white" alt="Vercel KV" />
    <img src="https://img.shields.io/badge/Zero_Dependencies-FF5733?style=flat-square" alt="Zero Dependencies (Runtime)" />
  </div>
</div>

---

## 🏛️ A Filosofia

**Askesis** (do grego *ἄσκησις*) significa **"treinamento"**. Não se trata de sofrimento, mas do treinamento rigoroso do caráter. 

Diferente de apps focados em gamificação superficial, o Askesis utiliza **Inteligência Artificial (Google Gemini)** atuando como um "Sábio Estoico". Ele analisa seus dados não para gerar gráficos coloridos sem sentido, mas para oferecer conselhos filosóficos personalizados sobre consistência, virtude e força de vontade.

> *"Nós somos o que repetidamente fazemos. A excelência, portanto, não é um ato, mas um hábito."* — Aristóteles (frequentemente citado pelos Estoicos)

---

## ✨ Interface & Experiência

<!-- 
  PLACEHOLDER PARA IMAGENS:
  Substitua os caminhos abaixo pelos seus arquivos reais na pasta 'assets'.
  Se não tiver as imagens ainda, esta seção ficará oculta ou mostrará o texto alternativo.
-->

O design segue os princípios do **Brutalismo Utilitário**: alto contraste, tipografia forte e foco absoluto no conteúdo.

### Gestos Naturais
Interações fluídas inspiradas em sistemas nativos. Deslize para editar, segure para ver detalhes.

<!-- Exemplo: ![Demo do Swipe](assets/swipe-demo.gif) -->

### O Anel de Progresso
Uma visualização imediata do dia. O anel se completa conforme a virtude é exercitada.

<!-- Exemplo: ![Screenshot Mobile](assets/mobile-view.png) -->

---

## 🛠️ Engenharia "World-Class"

Este projeto rejeita frameworks pesados em favor de **Performance Nativa** e **JavaScript Moderno (ESNext)**. É uma demonstração de como construir software complexo, performático e acessível utilizando apenas os padrões da Web Plataform.

### Core Tech Stack
*   **Frontend:** Vanilla TypeScript (Sem React, Vue ou Angular). Manipulação cirúrgica do DOM.
*   **Estado:** Gerenciamento de estado reativo customizado com persistência local.
*   **Build:** `esbuild` para compilação ultra-rápida.

### Uso Avançado de Web APIs
O diferencial técnico do projeto reside no uso profundo de APIs do navegador:

1.  **Performance & Rendering**
    *   `requestIdleCallback`: Tarefas pesadas (como análise de dados e logs) são agendadas para momentos de ociosidade da CPU, garantindo que a interface nunca trave (60fps cravados).
    *   `IntersectionObserver`: Renderização eficiente de listas longas e gráficos, carregando conteúdo apenas quando visível.
    *   `CSS Containment`: Uso da propriedade `contain: content` para isolar cálculos de layout e pintura, otimizando a renderização do calendário.

2.  **Segurança (Criptografia Militar no Cliente)**
    *   `Web Crypto API`: Implementação nativa de **AES-GCM** para criptografar dados e **PBKDF2** para derivação de chaves.
    *   **Zero-Knowledge:** O servidor (Vercel KV) armazena apenas *blobs* criptografados. A chave de descriptografia nunca sai do dispositivo do usuário.

3.  **Progressive Web App (PWA)**
    *   `Service Workers`: Estratégia **Cache-First** para o App Shell, garantindo carregamento instantâneo (0ms de latência de rede) e funcionamento **100% Offline**.
    *   `Badging API`: Integração com o sistema operacional para exibir contadores de notificação no ícone do app.
    *   `Web Share API` & `Clipboard API`: Integração nativa para compartilhamento de citações e chaves.

4.  **UX Tátil**
    *   `Vibration API`: Feedback háptico (tátil) preciso para micro-interações (sucesso, erro, seleção), aumentando a imersão.
    *   `Pointer Events`: Lógica física personalizada para gestos de "Swipe" e "Drag-and-Drop".

---

## 🔐 Privacidade e Soberania

*   **Seus Dados, Seu Controle:** Os dados residem primariamente no `localStorage` do seu dispositivo.
*   **Sincronização Opcional:** A nuvem é usada apenas como backup criptografado. Sem rastreadores, sem venda de dados, sem análise de terceiros.

---

## 🚀 Roadmap (O Futuro)

O desenvolvimento do Askesis é contínuo, focado em aprofundar a integração com a rotina do usuário.

- [ ] **Comandos de Voz:** Integração com *Web Speech API* para registrar hábitos via voz ("Askesis, marque Leitura como feito").
- [ ] **Modo Foco:** Um timer Pomodoro integrado com citações estoicas durante os intervalos.
- [ ] **Versão Nativa Android:** Desenvolvimento de um aplicativo nativo (Kotlin/Jetpack Compose) para integração profunda com o sistema operacional (Widgets de tela inicial, Quick Settings Tiles).

---

<div align="center">
  <p>Construído com 🧠 e 💻.</p>
  <p><em>© 2025 Askesis Project</em></p>
</div>
