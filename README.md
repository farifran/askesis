
<div align="center">
  <img src="./icons/icon-512.svg" width="120" alt="Askesis Logo" style="border-radius: 24px;">
  <h1>Askesis</h1>
  
  <p>
    <a href="https://askesis-psi.vercel.app/"><img src="https://img.shields.io/badge/Acessar_App-27ae60?style=for-the-badge&logo=vercel&logoColor=white" alt="Acessar Aplicação"></a>
    <img src="https://img.shields.io/badge/Google_Gemini-174EA6?style=for-the-badge&logo=google-gemini&logoColor=white" alt="Gemini AI" />
    <img src="https://img.shields.io/badge/TypeScript-000000?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/PWA-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white" alt="PWA" />
  </p>

  <p><em>O Rastreador de Hábitos Estoico. Minimalista. Privado. Impulsionado por IA.</em></p>
</div>

---

## 🏛️ A Filosofia

**Askesis** (do grego *ἄσκησις*) significa "treinamento". Na filosofia estoica, não se trata de sofrimento, mas do **treinamento atlético da mente e do caráter**.

A maioria dos apps foca em gamificação superficial. O Askesis foca na **virtude da consistência**. Ele utiliza Inteligência Artificial para atuar como um "Sábio Estoico", analisando seus dados não para julgar, mas para oferecer conselhos sobre como fortalecer sua vontade.

### Os Pilares
1.  **Soberania de Dados:** Seus dados residem no seu dispositivo. A sincronização na nuvem utiliza um "Cofre Cego" (Criptografia de Ponta-a-Ponta), garantindo que nem o servidor possa ler seus hábitos.
2.  **Engenharia de Elite:** Uma demonstração técnica de que a Web Platform é capaz de performance nativa (60 FPS) sem o peso de frameworks modernos.

---

## 🔬 Deep Dive Técnico (Showcase)

Este projeto rejeita a complexidade acidental em favor de **Performance Nativa** e **JavaScript Moderno (ESNext)**. A engenharia foca no uso cirúrgico de Web APIs padrão.

### Stack Tecnológica
*   **Frontend:** Vanilla TypeScript (Zero-Bundle-Overhead).
*   **Backend:** Vercel Edge Functions (Serverless).
*   **Banco de Dados:** Vercel KV (Redis) para blobs criptografados.
*   **IA:** Google Gemini API (via SDK oficial).

### Domínio da Plataforma Web (Native APIs)
Em vez de bibliotecas externas pesadas, o Askesis extrai o máximo do navegador:

*   **`requestIdleCallback` (Scheduler):** Orquestração de tarefas não urgentes (como renderizar citações ou verificar notificações) para momentos de ociosidade da CPU, garantindo que a thread principal (UI) nunca trave.
*   **`Web Crypto API` (Security):** Implementação manual de **PBKDF2** (derivação de chaves) e **AES-GCM** (criptografia autenticada) rodando no cliente. Segurança de nível militar sem dependências npm.
*   **`IntersectionObserver` & `ResizeObserver` (Performance):** Virtualização de listas e gráficos responsivos que pausam a renderização quando fora da tela, eliminando *Layout Thrashing*.
*   **`Intl.DateTimeFormat` & `Intl.PluralRules` (i18n):** Internacionalização robusta e leve, usando as APIs nativas do motor V8 em vez de bibliotecas como `moment.js` ou `i18next`.
*   **`Navigator.vibrate` (Haptics):** Feedback tátil preciso (micro-pulsos de 8-15ms) para simular a "textura" de botões físicos em dispositivos móveis.
*   **`Service Workers` (Offline-First):** Estratégia de cache agressiva ("Cache-First") para o App Shell, permitindo carregamento instantâneo (0ms) e funcionamento pleno sem rede.

---

## ✨ Funcionalidades

### 📅 Calendário de Evolução
*   **Anéis de Progresso:** Visualização imediata da consistência diária.
*   **Gestão em Massa:** Duplo-clique para completar tudo, triplo-clique para adiar.

### 🤖 O Mentor Estoico (IA)
*   **Análise Semanal/Mensal:** Detecta padrões de comportamento e oferece conselhos baseados em Sêneca, Marco Aurélio e Epicteto.

### ☁️ Sincronização Segura
*   **Criptografia Client-Side:** Seus dados saem do seu dispositivo já ilegíveis. Sua chave de sincronização é a única forma de decifrá-los.

---

## 🚀 Roadmap

O desenvolvimento do Askesis é contínuo, visando integração profunda com o sistema operacional.

*   **Versão Nativa Android:**
    *   Empacotamento TWA (Trusted Web Activity) para publicação na Play Store.
    *   Widgets de tela inicial para check-in rápido.
    *   Integração com Health Connect para marcar hábitos automaticamente (ex: "Caminhar 10min").

---

## Licença

Este projeto é open-source e está licenciado sob a [Licença ISC](LICENSE).
