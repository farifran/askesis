<p align="center">
  <img src="icons/icon-512.svg" width="140" alt="Askesis Logo">
</p>

# Askesis

*Um rastreador de hábitos dinâmico, focado em privacidade, com visualização de dados e feedback personalizado impulsionado por IA, construído com uma arquitetura de alta performance.*

<p align="center">
  <a href="https://askesis-psi.vercel.app/">
    <img src="https://img.shields.io/badge/Acessar_App-Ver_Demo_Online-27ae60?style=for-the-badge&logo=vercel" alt="Acessar Aplicação">
  </a>
</p>

## 🏛️ A Filosofia: O que é "Askesis"?

**Askesis** (do grego *ἄσκησις*) significa literalmente "exercício", "treinamento" ou "prática". 

Na Grécia Antiga, o termo era usado para descrever o treinamento rigoroso dos atletas. Os filósofos estoicos adotaram essa palavra não para pregar a autoprivação ou sofrimento, mas para descrever o **treinamento da mente e do caráter**. 

Assim como um atleta treina o corpo, um estoico pratica *askesis* para fortalecer sua vontade, dominar seus impulsos e viver de acordo com a virtude. Este aplicativo foi desenhado para ser sua ferramenta diária nesse treinamento.

## 📱 Como Usar o Askesis

O Askesis foi desenhado para ser intuitivo, mas poderoso. Aqui estão as principais partes da aplicação:

### 1. Adicionando Hábitos
Toque no botão flutuante **`+`** no canto superior esquerdo.
*   **Explorar:** Escolha entre diversos hábitos predefinidos (Ler, Meditar, Beber Água) com ícones e cores já configurados.
*   **Personalizar:** Crie seu próprio hábito do zero, definindo nome, ícone, cor, frequência (diária, dias da semana ou intervalos) e horário (Manhã, Tarde, Noite).

### 2. O Fluxo Diário (Gestos)
A interação principal acontece através de gestos nos cartões de hábitos:
*   **Toque Simples:** Marca o hábito como **Feito** (Verde), **Pendente** (Cinza) ou **Adiado** (Listrado).
*   **Deslizar para a Direita (Swipe Right):** Revela a opção de **Excluir** (remover apenas o agendamento daquele horário).
*   **Deslizar para a Esquerda (Swipe Left):** Revela a opção de **Notas**. Adicione reflexões ou detalhes sobre a execução do hábito naquele dia.

### 3. Gráfico de Crescimento Composto
Localizado na parte inferior, este não é um gráfico comum.
*   Ele visualiza a **consistência** ao longo do tempo, inspirado no conceito de juros compostos.
*   Fazer seus hábitos aumenta sua pontuação. Falhar diminui.
*   A "curva de projeção" recompensa sequências longas (streaks) e pune interrupções, incentivando você a não "quebrar a corrente".

### 4. Mentoria com IA (Sábio Estoico)
Toque no ícone de **Cérebro/Brilho** no cabeçalho.
*   A IA analisa seu histórico recente e gera um feedback personalizado baseado na filosofia estoica.
*   Receba conselhos sobre consistência, celebrações por marcos atingidos (21 ou 66 dias) e reflexões sobre seus maiores desafios.

---

## ✨ Principais Funcionalidades Técnicas

*   **Sincronização na Nuvem com Criptografia de Ponta a Ponta:** Seus dados são criptografados no seu dispositivo (usando AES-GCM e PBKDF2) antes de serem enviados para a nuvem.
*   **100% Offline (PWA):** Funciona perfeitamente sem conexão com a internet.
*   **Interface Multilíngue:** Suporte para Português, Inglês e Espanhol.

## 🚀 Pilha Tecnológica (Tech Stack)

*   **Frontend:** TypeScript, HTML5, CSS3 (Arquitetura "Vanilla" sem frameworks, focada em performance).
*   **Infraestrutura e Backend (Vercel):** Vercel Edge Functions & Vercel KV (Redis).
*   **Inteligência Artificial:** Google Gemini API.
*   **Notificações:** OneSignal.
*   **Build Tool:** esbuild.

## 🏛️ Engenharia e Design de Software

O Askesis foi projetado seguindo princípios de engenharia de software de classe mundial, priorizando a experiência do usuário, performance e privacidade.

### 1. Performance Extrema ("Performance-First")
O código evita o peso desnecessário de frameworks (bloat), implementando otimizações manuais para garantir 60fps:
*   **Renderização Cirúrgica:** Utiliza um sistema de "Dirty Checking" para atualizar apenas os nós do DOM que realmente mudaram.
*   **Zero-Cost Idle:** Tarefas pesadas são agendadas para momentos de ociosidade do navegador (`requestIdleCallback`).
*   **Prevenção de Layout Thrashing:** Leituras e escritas no DOM são estrategicamente separadas.

### 2. Arquitetura Offline-First (PWA Real)
*   **Cache-First:** O Service Worker serve o App Shell instantaneamente (0ms de latência).
*   **Sincronização Resiliente:** Implementa fila com *debounce* e travamento (mutex) para sincronização de dados.

### 3. Segurança e Privacidade por Design (E2EE)
*   **Criptografia no Cliente:** A chave de sincronização nunca é enviada pura para o servidor. O servidor armazena apenas blobs criptografados ilegíveis sem a chave do usuário.

### 4. Otimização de IA
*   **Compressão de Contexto:** O histórico é enviado para a IA usando compressão RLE (Run-Length Encoding) para economizar tokens e custos.

### 5. UX/UI Nativa
*   **Haptics:** Uso preciso da API de vibração para feedback tátil.
*   **Física:** Implementação manual de inércia e gestos de arrastar.

## 💡 Filosofia de Desenvolvimento

**Askesis** representa um modelo de "Engenheiro Aumentado por IA", onde a colaboração entre um engenheiro de sistemas e uma inteligência artificial avançada (Gemini) foi o motor central do projeto, permitindo a criação de um produto complexo com a agilidade de um único desenvolvedor.

## 📄 Licença

Este projeto está licenciado sob a [Licença ISC](LICENSE).