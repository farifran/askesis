# Askesis: Rastreador de Hábitos com IA

*Um rastreador de hábitos dinâmico, focado em privacidade, com visualização de dados e feedback personalizado impulsionado por IA, construído com uma arquitetura de alta performance.*

<!-- Inserir aqui um GIF ou screenshot da aplicação -->

## ✨ Principais Funcionalidades

*   **Rastreamento de Hábitos Detalhado:** Acompanhe hábitos diários, semanais ou com frequência personalizada, com metas numéricas (páginas, minutos) ou simples check-ins.
*   **Visualização de Crescimento Composto:** Um gráfico interativo que visualiza seu progresso e consistência ao longo do tempo.
*   **Feedback com IA (Gemini):** Receba análises semanais, mensais ou gerais sobre sua jornada, com insights e reflexões baseadas na filosofia estoica.
*   **Sincronização na Nuvem com Criptografia de Ponta a Ponta:** Seus dados são criptografados no seu dispositivo (usando AES-GCM e PBKDF2) antes de serem enviados para a nuvem, garantindo privacidade total.
*   **100% Offline (PWA):** Funciona perfeitamente sem conexão com a internet graças a uma robusta estratégia de cache via Service Worker.
*   **Interface Multilíngue:** Suporte para Português, Inglês e Espanhol.
*   **UX Refinada:** Interações fluidas, como deslizar para ações, arrastar e soltar para reorganizar, e atalhos de múltiplos cliques no calendário.

## 🚀 Pilha Tecnológica (Tech Stack)

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

## 📂 Estrutura do Projeto

O projeto segue uma arquitetura modular com uma clara separação de responsabilidades:

*   `index.tsx`: Ponto de entrada da aplicação, orquestra a sequência de inicialização.
*   `state.ts`: Define a estrutura de dados (tipos), o estado global e helpers de manipulação de estado.
*   `render.ts`: Contém toda a lógica de renderização e manipulação do DOM.
*   `listeners.ts`: Configura todos os event listeners da aplicação.
*   `habitActions.ts`: Lógica de negócio para criar, editar e atualizar hábitos.
*   `cloud.ts` / `sync.ts` / `crypto.ts`: Lógica do cliente para a sincronização segura na nuvem.
*   `/api`: Contém as Vercel Edge Functions para o backend (análise da IA e sincronização).

## 🏃‍♂️ Como Executar Localmente

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

## 🏛️ Destaques da Arquitetura

*   **Performance-First:** A UI utiliza uma estratégia de reconciliação do DOM (similar ao React, mas implementada manualmente) que evita re-renderizações completas. Em vez de reconstruir o HTML, o código atualiza cirurgicamente os atributos e o texto dos elementos existentes, resultando em uma experiência de usuário extremamente rápida e fluida.

*   **Segurança e Privacidade por Design:** A implementação da criptografia de ponta a ponta (E2EE) é um diferencial crucial. A chave de sincronização do usuário nunca sai do dispositivo; ela é usada para derivar uma chave de criptografia (via PBKDF2) que criptografa os dados (via AES-GCM) antes de enviá-los para a nuvem. Isso garante que nem mesmo o servidor possa ler os dados do usuário.

*   **Integridade de Dados Históricos:** O uso de `scheduleHistory` para cada hábito é uma solução sofisticada que permite que as propriedades de um hábito (nome, frequência, etc.) mudem ao longo do tempo sem corromper os dados passados. Quando um hábito é editado, um novo "segmento" de agendamento é criado a partir da data da edição, preservando a precisão do histórico para o gráfico de progresso e as análises da IA.

## 💡 Filosofia e Processo de Desenvolvimento

**Askesis** representa um novo paradigma no desenvolvimento de software, onde a colaboração entre um engenheiro de sistemas e uma inteligência artificial avançada (Gemini) foi o motor central do projeto. Desde a concepção inicial da ideia até a implementação de cada funcionalidade, arquitetura de segurança e refinamento da UI/UX, o projeto foi inteiramente construído por esta parceria inovadora.

Este modelo de "Engenheiro Aumentado por IA" permitiu a criação de um produto complexo e de alta qualidade com a agilidade e o foco de um único desenvolvedor, demonstrando o potencial da colaboração humano-IA para acelerar a inovação e a engenharia de software de ponta.

## 📄 Licença

Este projeto está licenciado sob a [Licença ISC](LICENSE).