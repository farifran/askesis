<div align="center" style="background-color: #121212; color: #e5e5e5; padding: 20px; border-radius: 12px;">
  <table border="0" cellspacing="0" cellpadding="0" style="border-collapse: collapse; border: none; background-color: #121212; color: #e5e5e5;">
    <tr>
      <td width="160" align="center" valign="middle" style="border: none;">
        <img src="icons/icon-512.svg" width="120" alt="Askesis Logo" style="border-radius: 24px;">
      </td>
      <td align="left" valign="middle" style="border: none; color: #e5e5e5; padding-left: 20px;">
        <h1 style="color: #e5e5e5; margin-bottom: 10px; margin-top: 0;">Askesis</h1>
        <a href="https://askesis-psi.vercel.app/"><img src="https://img.shields.io/badge/Acessar_App-27ae60?style=for-the-badge&logo=vercel&logoColor=white" alt="Acessar Aplicação"></a><img src="https://img.shields.io/badge/Google_Gemini-174EA6?style=for-the-badge&logo=google-gemini&logoColor=white" alt="Gemini AI" /><img src="https://img.shields.io/badge/TypeScript-000000?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" /><img src="https://img.shields.io/badge/PWA-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white" alt="PWA" />
        <br><br>
        <p style="color: #b3b3b3; margin: 0;"><em>Rastreador de Hábitos Estoico. Minimalista. Focado em Privacidade. Impulsionado por IA.</em></p>
      </td>
    </tr>
  </table>
</div>

---

<h2>A Filosofia: O que é Askesis?</h2>

**Askesis** (do grego *ἄσκησις*) é a raiz da palavra "ascetismo", mas seu significado original é muito mais prático: significa **"treinamento"** ou **"exercício"**.

Na filosofia estoica, *askesis* não se trata de sofrimento ou privação sem sentido, mas do **treinamento rigoroso e atlético da mente e do caráter**. Assim como um atleta treina o corpo para a competição, o estoico treina a mente para lidar com as adversidades da vida com virtude e tranquilidade.

A maioria dos apps de hábitos foca em gamificação superficial ou em "não quebrar a corrente". O Askesis foca na **virtude da consistência**. Ele usa Inteligência Artificial para atuar como um "Sábio Estoico", analisando seus dados não para julgar, mas para oferecer conselhos sobre como fortalecer sua vontade.

---

<h2>Como Usar o Askesis</h2>

O Askesis foi desenhado para ser intuitivo, rápido e focado na ação.

<h3>1. Adicionando Hábitos</h3>
*   **Botão FAB (+):** Clique no botão verde flutuante no canto superior esquerdo para abrir o menu de exploração.
*   **Explorar & Personalizar:** Escolha entre hábitos predefinidos (como "Meditar", "Ler", "Exercício") ou crie um totalmente personalizado.
*   **Definição:** Escolha o ícone, cor, horário (Manhã, Tarde, Noite) e a frequência desejada.

<h3>2. Interações Gestuais (Swipe)</h3>
Inspirado em interfaces móveis nativas, a interação principal é feita através de gestos nos cartões de hábito:
*   **Deslizar para a Direita (Fundo Verde/Azul):** Marca o hábito como **Concluído**. Se já estiver concluído, volta para pendente.
*   **Deslizar para a Esquerda (Fundo Amarelo/Cinza):** Revela opções secundárias.
    *   **Adiar (Snooze):** Move o hábito para um estado de "Adiado" (não conta como falha, mas não soma pontos).
    *   **Notas:** Adicione uma reflexão curta sobre aquele hábito específico no dia.

<h3>3. Gráfico de Crescimento Composto</h3>
Diferente de gráficos lineares simples, o gráfico do Askesis visualiza a **consistência como juros compostos**.
*   **Lógica:** Cada dia concluído com sucesso aumenta sua "pontuação composta". Dias perdidos penalizam levemente o crescimento, mas a consistência a longo prazo gera uma curva exponencial.
*   **Objetivo:** Ver visualmente como pequenos esforços diários se acumulam em grandes resultados ao longo do tempo.

<h3>4. Mentoria com IA</h3>
*   Clique no ícone do "cérebro" no topo da tela.
*   A IA (Google Gemini) analisará seu histórico recente.
*   Você receberá um feedback personalizado, estoico e acionável sobre seus padrões, celebrando marcos (como 21 ou 66 dias) e sugerindo correções de curso.

---

<h2>Arquitetura e Engenharia</h2>

Este projeto rejeita a complexidade desnecessária dos frameworks modernos em favor de **Performance Nativa** e **JavaScript Moderno (ESNext)**.

<h3>Estrutura do Projeto</h3>

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

<h3>Decisões Técnicas de Alto Nível</h3>

1.  **Performance Extrema ("Vanilla Speed"):**
    *   Sem React/Vue/Angular. Manipulação direta e cirúrgica do DOM.
    *   **Dirty Checking:** O sistema sabe exatamente o que mudou e atualiza apenas o texto ou classe necessária.
    *   **Zero-Cost Idle:** Tarefas pesadas (analytics, salvamento) rodam via `requestIdleCallback`, garantindo que a UI nunca trave.

2.  **Confiabilidade de Dados e Offline-First:**
    *   **Service Worker:** Estratégia *Cache-First* para o App Shell garante carregamento instantâneo (0ms latência) e funcionamento total offline.
    *   **Sincronização Resiliente:** Utiliza *Optimistic UI* (a interface atualiza antes do servidor). A sincronização com a nuvem (Vercel KV) inclui lógica de retry com backoff exponencial e resolução de conflitos para garantir consistência entre múltiplos dispositivos.

3.  **Engajamento e Notificações:**
    *   **OneSignal SDK:** Gerenciamento robusto de Web Push Notifications.
    *   **Badging API:** Integração com a API nativa de Badging do navegador para exibir o número de hábitos pendentes ("3") diretamente no ícone do aplicativo na tela inicial/dock, aumentando a retenção.

4.  **Engenharia de IA (Context Compression):**
    *   Para enviar meses de histórico para a IA sem estourar o limite de tokens ou custos, utilizamos estratégias de sumarização de dados.
    *   Os prompts são engenheirados para fornecer contexto estoico ("Persona Sábia") e dados estruturados compactos.

5.  **Segurança (Client-Side Encryption):**
    *   Utilizamos **PBKDF2** para derivar chaves e **AES-GCM** para criptografar o payload JSON no cliente antes do envio.
    *   O servidor Vercel KV atua apenas como um depósito cego de dados criptografados (Zero Knowledge Architecture).

6.  **Integridade de Estado e Migrações:**
    *   O estado da aplicação é versionado rigorosamente.
    *   Implementamos um motor de **Migração Sequencial** (`migration.ts`) que transforma automaticamente dados legados para o novo esquema estrutural (ex: adoção de `scheduleHistory`) sem perda de histórico ao atualizar o app.

<h3>Infraestrutura e Integrações Externas</h3>

O projeto utiliza serviços modernos para garantir escalabilidade e engajamento sem gerenciar servidores tradicionais.

<h4>
  <img src="https://cdn.svgporn.com/logos/vercel-icon.svg" height="24" alt="Vercel Logo" style="vertical-align: bottom; margin-right: 8px;" />
  Vercel (Serverless & Storage)
</h4>
*   **Hospedagem & CI/CD:** O frontend é compilado e distribuído globalmente pela Vercel CDN.
*   **Edge Functions:** A lógica de backend reside em `api/`, rodando no runtime Edge da Vercel. Isso permite processar requisições de IA e criptografia de sincronização com latência próxima de zero, sem "cold starts" pesados de lambdas tradicionais.
*   **Vercel KV (Redis):** A sincronização de dados utiliza o Vercel KV. O servidor atua como um "cofre burro": ele recebe e entrega blobs JSON criptografados (AES-GCM), sem nunca ter acesso às chaves de descriptografia ou aos dados reais do usuário (Zero-Knowledge Storage).

<h4>
  <img src="https://cdn.svgporn.com/logos/onesignal.svg" height="24" alt="OneSignal Logo" style="vertical-align: bottom; margin-right: 8px;" />
  OneSignal (Push Notifications)
</h4>
*   **Integração PWA:** O OneSignal foi integrado diretamente no Service Worker (`sw.js`), permitindo o envio de notificações de reengajamento ("Complete seus hábitos da tarde!") mesmo com o aplicativo fechado.
*   **Gestão de Estado:** A interface do usuário sincroniza bidirecionalmente com o estado de inscrição do OneSignal. Se o usuário bloqueia notificações no navegador, o "toggle" no app reflete isso instantaneamente; se ele ativa no app, o SDK gerencia o "handshake" de permissão nativa.

---

<h2>Deploy</h2>

Você pode implantar sua própria instância do Askesis na Vercel com um clique:

<a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fseu-usuario%2Faskesis&env=API_KEY,KV_URL,KV_REST_API_URL,KV_REST_API_TOKEN,KV_REST_API_READ_ONLY_TOKEN&project-name=askesis-habit-tracker&repository-name=askesis-habit-tracker">
  <img src="https://vercel.com/button" alt="Deploy with Vercel"/>
</a>

<h2>Licença</h2>

Este projeto é open-source e está licenciado sob a [Licença ISC](LICENSE).

---

<p align="center">
  Feito com 🖤 e Estoicismo.
</p>
