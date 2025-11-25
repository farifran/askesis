<div align="center" style="background-color: #121212; color: #e5e5e5; padding: 20px; border-radius: 12px;">
  <table border="0" cellspacing="0" cellpadding="0" style="border-collapse: collapse; border: none; background-color: #121212; color: #e5e5e5;">
    <tr>
      <td width="160" align="center" valign="middle" style="border: none;">
        <img src="icons/icon-512.svg" width="120" alt="Askesis Logo" style="border-radius: 24px;">
      </td>
      <td align="left" valign="middle" style="border: none; color: #e5e5e5; padding-left: 20px;">
        <h1 style="color: #e5e5e5; margin-bottom: 4px; margin-top: 0;">Askesis</h1>
        <div>
          <a href="https://askesis-psi.vercel.app/"><img src="https://img.shields.io/badge/Acessar_App-27ae60?style=for-the-badge&logo=vercel&logoColor=white" alt="Acessar Aplicação"></a>
          <img src="https://img.shields.io/badge/Google_Gemini-174EA6?style=for-the-badge&logo=google-gemini&logoColor=white" alt="Gemini AI" />
          <img src="https://img.shields.io/badge/TypeScript-000000?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
          <img src="https://img.shields.io/badge/PWA-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white" alt="PWA" />
        </div>
        <br>
        <p style="color: #b3b3b3; margin: 0;"><em>O Rastreador de Hábitos Estoico. Minimalista. Privado. Impulsionado por IA.</em></p>
      </td>
    </tr>
  </table>
</div>

---

## 🏛️ A Filosofia

**Askesis** (do grego *ἄσκησις*) significa "treinamento" ou "exercício". Na filosofia estoica, não se trata de sofrimento, mas do **treinamento atlético da mente e do caráter**.

A maioria dos apps foca em gamificação superficial. O Askesis foca na **virtude da consistência**. Ele utiliza Inteligência Artificial para atuar como um "Sábio Estoico", analisando seus dados não para julgar, mas para oferecer conselhos sobre como fortalecer sua vontade.

### Os Pilares do Projeto
1.  **Soberania de Dados:** Seus hábitos são um diário íntimo. No Askesis, os dados pertencem a você e residem no seu dispositivo (ou no seu cofre pessoal criptografado na nuvem). Nada é vendido ou analisado por terceiros.
2.  **Autonomia Tecnológica:** Uma ferramenta profissional e robusta, livre de assinaturas mensais, provando que o auto-aperfeiçoamento não deve ter barreiras financeiras.

---

## ✨ Funcionalidades Principais

O Askesis foi desenhado em camadas: intuitivo na superfície, mas profundo para quem busca controle total.

### 📅 O Calendário de Evolução
A faixa de calendário no topo é sua bússola.
*   **Anéis de Progresso:** Visualização imediata do dia (Preenchido = Feito / Vazio = Pendente).
*   **Gestão em Massa:** 
    *   *Duplo clique no dia:* Marca tudo como **Feito**.
    *   *Triplo clique no dia:* Marca tudo como **Adiado**.
    *   *Pressionar (Long Press):* Abre o calendário mensal completo.

### 🃏 Cartões de Hábito Interativos
A unidade fundamental da sua rotina.
*   **Rastreamento Rico:** Suporte para metas binárias ("check"), quantitativas ("10 páginas") ou temporais ("15 minutos").
*   **Gestos Naturais (Swipe):** Deslize um cartão para revelar opções contextuais como **Adicionar Nota** (diário estoico) ou **Apagar** (apenas hoje ou para sempre).
*   **Status Inteligentes:** Pendente, Feito e Adiado (para imprevistos, sem quebrar a corrente visualmente).

### 🤖 O Mentor Estoico (IA)
Não é apenas um gráfico; é um conselheiro.
*   **Análise Semanal/Mensal:** A IA analisa seus padrões de comportamento.
*   **Feedback Qualitativo:** Receba conselhos baseados em Sêneca, Marco Aurélio e Epicteto sobre sua consistência, não apenas estatísticas frias.

### ☁️ Sincronização Criptografada
*   **Cofre Cego:** Seus dados são criptografados no seu dispositivo (AES-GCM) antes de subir para a nuvem. O servidor apenas armazena o "lixo digital" ilegível. Apenas sua Chave de Sincronização pode abri-lo.

---

## 📱 Experiência Universal (PWA & Acessibilidade)

O Askesis segue a premissa de que a tecnologia deve se adaptar ao usuário.

### Progressive Web App (PWA)
*   **Instalável:** Funciona como app nativo no iOS, Android, Windows e Mac.
*   **Offline-First:** Graças a *Service Workers* avançados, o app carrega instantaneamente e é **totalmente funcional sem internet**.
*   **Sensação Nativa:** Haptics (vibração), gestos fluidos e 60fps.

### Acessibilidade (A11y)
A disciplina estoica é para todos.
*   **Leitores de Tela:** Semântica HTML rigorosa e atributos ARIA completos.
*   **Navegação por Teclado:** Todo o app é operável sem mouse/toque, com *Focus Traps* em modais.
*   **Movimento Reduzido:** Respeita as configurações do sistema do usuário para reduzir animações.

---

## 🛠️ Arquitetura e Engenharia

Este projeto rejeita a complexidade desnecessária de frameworks pesados em favor de **Performance Nativa** e **JavaScript Moderno (ESNext)**.

### Stack Tecnológica
*   **Frontend:** Vanilla TypeScript (sem React/Vue). Manipulação cirúrgica do DOM para performance extrema.
*   **Estilização:** CSS Variables moderno (Dark Mode nativo e responsividade fluida).
*   **Backend:** Vercel Edge Functions (Serverless).
*   **Banco de Dados:** Vercel KV (Redis) para armazenamento do blob criptografado.
*   **IA:** Google Gemini API (via SDK oficial `@google/genai`).

### Decisões Técnicas de Destaque
1.  **Zero-Cost Idle:** Tarefas pesadas rodam via `requestIdleCallback`, garantindo que a interface nunca trave.
2.  **Optimistic UI:** A interface responde instantaneamente; a sincronização ocorre em segundo plano com resolução de conflitos e *backoff* exponencial.
3.  **State Management:** Um store reativo próprio, leve e tipado, com persistência local e migração automática de versão de dados.

---

## 🤖 Desenvolvimento Assistido por IA

Este projeto representa um novo paradigma. O **Askesis** foi orquestrado através do **Google AI Studio**.

*   **O Humano:** Atuou como Arquiteto de Software e Product Manager, definindo requisitos de segurança (criptografia militar), performance (offline-first) e UX.
*   **A IA (Gemini):** Atuou como Engenheiro Sênior, implementando algoritmos complexos (PBKDF2, AES-GCM, Service Workers), otimizando renderização e garantindo a tipagem estrita do TypeScript.

O resultado é uma aplicação com complexidade de *squad* inteiro, construída por uma única pessoa.

---

## 🍃 Sustentabilidade e Zero Cost

Uma arquitetura desenhada para operar com **Custo Zero ($0)** indefinidamente.

*   **Armazenamento Ultraleve:** Salvamos apenas texto comprimido e criptografado. 5 anos de histórico ocupam menos espaço que uma foto.
*   **Processamento no Edge:** A maior parte do "pensamento" (criptografia, gráficos) ocorre no dispositivo do usuário, poupando recursos do servidor.

## Licença

Este projeto é open-source e está licenciado sob a [Licença ISC](LICENSE).
