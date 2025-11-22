<div align="center">
  <table border="0">
    <tr>
      <td width="160" align="center" valign="middle">
        <img src="icons/icon-512.svg" width="120" alt="Askesis Logo" style="border-radius: 24px;">
      </td>
      <td align="left" valign="middle">
        <h1>Askesis</h1>
        <p><em>O Rastreador de Hábitos Estoico. Minimalista. Focado em Privacidade. Impulsionado por IA.</em></p>
        <!-- Linha 1 -->
        <a href="https://askesis-psi.vercel.app/">
          <img src="https://img.shields.io/badge/LIVE_DEMO-Acessar_App-27ae60?style=for-the-badge&logo=vercel&logoColor=white" alt="Acessar Aplicação">
        </a>
        <br>
        <!-- Linha 2 -->
        <a href="https://askesis-psi.vercel.app/">
          <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
        </a>
        <a href="https://askesis-psi.vercel.app/">
          <img src="https://img.shields.io/badge/Google_Gemini-8E75B2?style=for-the-badge&logo=google-gemini&logoColor=white" alt="Gemini AI" />
        </a>
        <br>
        <!-- Linha 3 -->
        <a href="https://askesis-psi.vercel.app/">
          <img src="https://img.shields.io/badge/Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white" alt="Vercel" />
        </a>
        <a href="https://askesis-psi.vercel.app/">
          <img src="https://img.shields.io/badge/PWA-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white" alt="PWA" />
        </a>
      </td>
    </tr>
  </table>
</div>

---

## 🏛️ A Filosofia: O que é Askesis?

**Askesis** (do grego *ἄσκησις*) é a raiz da palavra "ascetismo", mas seu significado original é muito mais prático: significa **"treinamento"** ou **"exercício"**.

Na filosofia estoica, *askesis* não se trata de sofrimento ou privação sem sentido, mas do **treinamento rigoroso e atlético da mente e do caráter**. Assim como um atleta treina o corpo para a competição, o estoico treina a mente para lidar com as adversidades da vida com virtude e tranquilidade.

A maioria dos apps de hábitos foca em gamificação superficial ou em "não quebrar a corrente". O Askesis foca na **virtude da consistência**. Ele usa Inteligência Artificial para atuar como um "Sábio Estoico", analisando seus dados não para julgar, mas para oferecer conselhos sobre como fortalecer sua vontade.

---

## 📱 Como Usar o Askesis

O Askesis foi desenhado para ser intuitivo, rápido e focado na ação.

### 1. Adicionando Hábitos
*   **Botão FAB (+):** Clique no botão verde flutuante no canto superior esquerdo para abrir o menu de exploração.
*   **Explorar & Personalizar:** Escolha entre hábitos predefinidos (como "Meditar", "Ler", "Exercício") ou crie um totalmente personalizado.
*   **Definição:** Escolha o ícone, cor, horário (Manhã, Tarde, Noite) e a frequência desejada.

### 2. Interações Gestuais (Swipe)
Inspirado em interfaces móveis nativas, a interação principal é feita através de gestos nos cartões de hábito:
*   **Deslizar para a Direita (Fundo Verde/Azul):** Marca o hábito como **Concluído**. Se já estiver concluído, volta para pendente.
*   **Deslizar para a Esquerda (Fundo Amarelo/Cinza):** Revela opções secundárias.
    *   **Adiar (Snooze):** Move o hábito para um estado de "Adiado" (não conta como falha, mas não soma pontos).
    *   **Notas:** Adicione uma reflexão curta sobre aquele hábito específico no dia.

### 3. Gráfico de Crescimento Composto
Diferente de gráficos lineares simples, o gráfico do Askesis visualiza a **consistência como juros compostos**.
*   **Lógica:** Cada dia concluído com sucesso aumenta sua "pontuação composta". Dias perdidos penalizam levemente o crescimento, mas a consistência a longo prazo gera uma curva exponencial.
*   **Objetivo:** Ver visualmente como pequenos esforços diários se acumulam em grandes resultados ao longo do tempo.

### 4. Mentoria com IA
*   Clique no ícone do "cérebro" no topo da tela.
*   A IA (Google Gemini) analisará seu histórico recente.
*   Você receberá um feedback personalizado, estoico e acionável sobre seus padrões, celebrando marcos (como 21 ou 66 dias) e sugerindo correções de curso.

---

## 🏗️ Arquitetura e Engenharia

Este projeto rejeita a complexidade desnecessária dos frameworks modernos em favor de **Performance Nativa** e **JavaScript Moderno (ESNext)**.

### Estrutura do Projeto

```text
.
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