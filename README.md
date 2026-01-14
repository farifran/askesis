Este prompt foi concebido para realizar uma **Auditoria de Integridade e Diagnóstico de Sistema**. Ele instrui a IA a agir como um observador externo neutro, cujo único objetivo é mapear a eficiência do Askesis sem alterar uma única linha de código.

Copia e cola o conteúdo abaixo:

---

# Prompt: Auditoria de Estado e Diagnóstico de Arquitetura (Askesis v7.2)

**Personagem:** Atue como um Arquiteto de Sistemas Especialista em Otimização e Segurança.
**Missão:** Realizar um "Raio-X" passivo de todo o ecossistema Askesis para avaliar o seu estado geral, eficiência e adesão aos princípios "Zero-Cost". **Nota: Não deves sugerir nem implementar alterações, apenas documentar o estado atual.**

### 1. Diagnóstico da Engine de Dados (Memory Health)

Analisa como a informação está estruturada em RAM:

* **Mapeamento de Bits:** Avalia a implementação do `HabitService`. Os bits estão a ser endereçados corretamente (6 bits por dia)? Como é que o sistema distingue os estados `NULL`, `DONE`, `DEFERRED` e `ARETE`?
* **Hibridismo de Estado:** Documenta a fronteira entre o `monthlyLogs` (BigInt64) e o `dailyData` (JSON). Há fuga de dados de status para o JSON?
* **Waterfall Integrity:** Verifica se a lógica de proteção de histórico (versão dos hábitos) está a cumprir o seu papel de isolamento.

### 2. Anatomia da Persistência (Storage Audit)

Examina a saúde dos dados no disco (IndexedDB):

* **Fase 3 Binary:** O sistema está a gravar efetivamente `ArrayBuffers`? Qual é o custo de I/O estimado para carregar 1 ano de histórico?
* **Compressão de Arquivos:** Avalia a estratégia de GZIP para dados > 90 dias. O carregamento é verdadeiramente "Lazy" ou há bloqueio da thread principal?

### 3. Avaliação de Performance (Efficiency Metrics)

Mapeia os custos operacionais:

* **CPU & Serialização:** Avalia os seletores em `selectors.ts`. Eles são verdadeiramente O(1)? Quanto tempo de CPU é gasto em cálculos de Streaks (sequências)?
* **Ciclo de Vida do Worker:** Analisa o `cloud.ts`. O padrão "instanciar e matar" está a ser respeitado? Há risco de zumbis de memória em background?

### 4. Coerência Filosófica (Askesis Sweet Spot)

Determina se o app mantém a sua "promessa" técnica:

* **Privacidade:** Onde ocorre a cifragem AES-GCM? O dado "toca" a rede de forma legível em algum momento?
* **Soberania:** O utilizador consegue exportar os bits num formato que faça sentido fora da app?

### 5. Identificação de "Tecido Cicatricial" (Technical Debt)

Identifica vestígios de versões anteriores que ainda residem no código:

* **Lógica Redundante:** Existem funções que calculam a mesma coisa por vias diferentes (JSON vs Bits)?
* **Fallbacks Obsoletos:** Existem verificações de versão (migrações v1 a v5) que já não servem a base de utilizadores atual e apenas adicionam ruído?

---

**Resultado Esperado:**
Entrega um **Relatório de Estado Geral** dividido em:

1. **Pontos Fortes:** O que está a funcionar com performance de elite.
2. **Pontos de Atenção:** Onde a complexidade pode estar a crescer sem necessidade.
3. **Mapa de Integridade:** Confirmação se o sistema é 100% "Zero-Cost" ou se ainda há "Dual Write" ativo.

**Filosofia de Observação:**
*"Observa o código como um médico observa um organismo: procura a harmonia, identifica o atrito, mas não operes sem necessidade."*

---

### Por que este prompt é útil agora?

1. **Validação de Metas:** Ele confirma se tudo o que planeámos (Bitmask, Binário, Workers) foi realmente executado como pretendido.
2. **Preparação para o Futuro:** Ter um diagnóstico claro evita que, no futuro, tentes "consertar o que não está partido".
3. **Segurança Psicológica:** Remove a preocupação de "sobre-engenharia" ao mostrar que a complexidade atual é, na verdade, uma simplificação de dados.