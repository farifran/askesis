<p align="center">
  <img src="icons/icon-512.svg" width="120" alt="Askesis Logo" style="border-radius: 24px; box-shadow: 0 8px 24px rgba(0,0,0,0.2);">
</p>

<h1 align="center">Askesis</h1>

<p align="center">
  <em>O Rastreador de Hábitos Estoico. Minimalista. Focado em Privacidade. Impulsionado por IA.</em>
</p>

<p align="center">
  <a href="https://askesis-psi.vercel.app/">
    <img src="https://img.shields.io/badge/LIVE_DEMO-Acessar_App-27ae60?style=for-the-badge&logo=vercel&logoColor=white" alt="Acessar Aplicação">
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Google_Gemini-8E75B2?style=for-the-badge&logo=google-gemini&logoColor=white" alt="Gemini AI" />
  <img src="https://img.shields.io/badge/Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white" alt="Vercel" />
  <img src="https://img.shields.io/badge/PWA-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white" alt="PWA" />
</p>

---

## 🏛️ A Filosofia

**Askesis** (do grego *ἄσκησις*) significa "treinamento". Na filosofia estoica, não se trata de sofrimento, mas do **treinamento rigoroso da mente e do caráter**.

A maioria dos apps de hábitos foca em "não quebrar a corrente". O Askesis foca na **virtude da consistência**. Ele usa Inteligência Artificial para atuar como um "Sábio Estoico", analisando seus dados não para julgar, mas para oferecer conselhos sobre como fortalecer sua vontade.

---

## ✨ Funcionalidades Principais

<table>
  <tr>
    <td width="50%">
      <h3>🎯 Gestão de Hábitos Fluida</h3>
      <p>Crie hábitos personalizados ou escolha modelos predefinidos. Defina frequências flexíveis (diária, dias da semana ou intervalos).</p>
    </td>
    <td width="50%">
      <h3>👆 Interações Gestuais (Swipe)</h3>
      <p>Interface inspirada em apps nativos. Deslize para <strong>Adiar</strong>, <strong>Excluir</strong> ou adicionar <strong>Notas</strong> contextuais ao seu dia.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🧠 Mentoria com IA (Gemini)</h3>
      <p>Receba feedback personalizado baseado na filosofia estoica. A IA analisa seus padrões e celebra marcos (21 e 66 dias).</p>
    </td>
    <td width="50%">
      <h3>📈 Crescimento Composto</h3>
      <p>Um gráfico exclusivo que visualiza a consistência como juros compostos. Seus esforços diários se acumulam visualmente.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🔒 Privacidade Absoluta (E2EE)</h3>
      <p>Seus dados são criptografados no seu dispositivo (AES-GCM) antes de tocar a nuvem. Nem nós podemos lê-los.</p>
    </td>
    <td width="50%">
      <h3>⚡ 100% Offline & PWA</h3>
      <p>Funciona sem internet. Instale no seu celular como um aplicativo nativo.</p>
    </td>
  </tr>
</table>

---

## 🏗️ Arquitetura e Engenharia

Este projeto rejeita a complexidade desnecessária dos frameworks modernos em favor de **Performance Nativa** e **JavaScript Moderno (ESNext)**.

### Estrutura do Projeto

```text
/
├── api/                 # Vercel Edge Functions (Backend Serverless)
├── locales/             # Arquivos de Tradução (i18n)
├── index.html           # App Shell (Critical Render Path)
├── index.css            # CSS Variável e Responsivo
├── index.tsx            # Ponto de Entrada
├── state.ts             # Gerenciamento de Estado Reativo
├── render.ts            # Motor de Renderização Cirúrgica (DOM Updates)
├── cloud.ts             # Camada de Sincronização e Resolução de Conflitos
├── crypto.ts            # Criptografia AES-GCM no lado do cliente
├── habitActions.ts      # Lógica de Negócios
├── swipeHandler.ts      # Física de Gestos Manuais
└── sw.js                # Service Worker (Cache Strategy)
```

### Decisões Técnicas de Alto Nível

1.  **Performance Extrema ("Vanilla Speed"):**
    *   Sem React/Vue/Angular. Manipulação direta e cirúrgica do DOM.
    *   **Dirty Checking:** O sistema sabe exatamente o que mudou e atualiza apenas o texto ou classe necessária.
    *   **Zero-Cost Idle:** Tarefas pesadas (analytics, salvamento) rodam via `requestIdleCallback`, garantindo que a UI nunca trave.

2.  **Engenharia de IA (Context Compression):**
    *   Para enviar meses de histórico para a IA sem estourar o limite de tokens ou custos, utilizamos **RLE (Run-Length Encoding)**.
    *   O histórico `[Feito, Feito, Feito, Pendente]` vira `3xFeito, 1xPendente` antes de ir para o prompt.

3.  **Segurança (Client-Side Encryption):**
    *   Utilizamos **PBKDF2** para derivar chaves e **AES-GCM** para criptografar o payload JSON.
    *   O servidor Vercel KV atua apenas como um depósito cego de dados criptografados.

---

## 🚀 Deploy

Você pode implantar sua própria instância do Askesis na Vercel com um clique:

<a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fseu-usuario%2Faskesis&env=API_KEY,KV_URL,KV_REST_API_URL,KV_REST_API_TOKEN,KV_REST_API_READ_ONLY_TOKEN&project-name=askesis-habit-tracker&repository-name=askesis-habit-tracker">
  <img src="https://vercel.com/button" alt="Deploy with Vercel"/>
</a>

## 📄 Licença

Este projeto é open-source e está licenciado sob a [Licença ISC](LICENSE).

---

<p align="center">
  Feito com 🖤 e Estoicismo.
</p>
