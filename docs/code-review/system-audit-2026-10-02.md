# Auditoria do sistema Askesis — 02/10/2026

> Registro do diagnóstico anterior às correções. Consulte o [relatório de correções](system-audit-fixes-2026-10-02.md) para o estado posterior.


Revisão do código local, incluindo as alterações de progressão ainda não commitadas. Esta entrega é uma análise: nenhuma correção funcional, atualização de dependência, publicação ou chamada real a Gemini/OneSignal foi feita nesta etapa.

## Escopo e método

Revisados os caminhos de API, autenticação por chave de sincronização, controle de requisições, criptografia, importação/exportação, migração, persistência, merge entre dispositivos, worker, renderização, service worker, build e CI. O grafo das cinco entradas principais contém 89 módulos locais. A revisão concentrou leitura detalhada nas fronteiras de confiança e de persistência; não é uma certificação de ausência de falhas em cada linha.

Foram executadas dez reproduções locais com dados sintéticos e provedores simulados. O código está em [reproduções](system-audit-reproductions-2026-10-02.txt). Para repetir, copie esse arquivo para `tests/audit-reproduction.tmp.test.ts`, execute `npx vitest run tests/audit-reproduction.tmp.test.ts` e remova apenas essa cópia depois. As asserções demonstram o comportamento defeituoso atual; não devem ser incorporadas como requisitos permanentes.

P1 = corrigir prioritariamente por risco de perda de dados, abuso de recursos ou envio indevido. P2 = falha relevante de confiabilidade, manutenção ou proteção. Não foi confirmado comprometimento de produção; configurações reais da hospedagem e do banco não foram inspecionadas.

## Achados prioritários

| ID | Prioridade | Problema | Evidência |
|---|---|---|---|
| A01 | P1 | IA acessível sem autenticação e com instrução arbitrária | Teste local |
| A02 | P1 | Lembretes sem autenticação quando falta CRON_SECRET | Teste local, depende da configuração |
| A03 | P1 | Trocar o hash de sync contorna a cota por IP | Teste do limitador + leitura do handler |
| A04 | P1 | Merge perde conteúdo de arquivos anuais de outro aparelho | Dois testes locais |
| A05 | P1 | Reset pode ser desfeito por aparelho antigo com nova edição | Condição e merge reproduzidos |
| A06 | P2 | Desmarcação e retomada de objetivos não sobrevivem ao merge | Dois testes locais |
| A07 | P2 | Worker altera textos iniciados em 0x e quebra JSON | Teste de encrypt/decrypt |
| A08 | P2 | Campos persistidos de IA e frase não são restaurados | Teste de loadState |
| A09 | P2 | keepalive em todos os POST limita sync e IA a 64 KiB | Código + especificação Fetch |
| A10 | P2 | Auditoria de segurança reporta sucesso quando npm audit falha | Script executado em sandbox VM |
| A11 | P2 | Dependências com advisories pendentes | npm audit atual |
| A12 | P2 | Backup exportado exclui histórico arquivado | Código e política explícita |
| A13 | P2 | Erros de gravação local são absorvidos como sucesso | Fluxo de código |

### A01 — IA pública pode consumir a chave paga do servidor

[api/analyze.ts:111](/Users/rafaelfarias/Documents/IDE/askesis/api/analyze.ts:111)

`/api/analyze` não exige credencial de usuário. Uma chamada sem `Origin` passa inclusive com CORS estrito e fornece livremente `prompt`, `systemInstruction` e schema. A reprodução recebeu HTTP 200 e atingiu o provedor simulado. CORS não autentica clientes fora do navegador. Existe limite por IP de 20 chamadas/minuto, mas não há orçamento por conta nem limite diário imposto no servidor. O limite mostrado no app é apenas local.

Impacto: uso do serviço para tarefas arbitrárias, gasto e esgotamento de cota. Corrigir com uma forma de autorização adequada ao modelo anônimo do app, orçamento global e por identidade, limites de saída e tarefas/instruções definidas no servidor. Exigir apenas um hash escolhido pelo próprio cliente não resolve o abuso de identidades ilimitadas.

O timeout de geração também usa `Promise.race` sem cancelar a operação do SDK; devolver 504 não garante que a geração e seu custo tenham terminado. Tratar cancelamento e concorrência junto desta correção.

### A02 — Ausência de segredo libera disparos para todos os assinantes

[api/reminder.ts:146](/Users/rafaelfarias/Documents/IDE/askesis/api/reminder.ts:146)

O guard está dentro de `if (cronSecret)`. Se `ONESIGNAL_REST_API_KEY` existir e `CRON_SECRET` estiver vazio/ausente, GET ou POST anônimo dispara uma notificação para o segmento inteiro. Teste local confirmou a chamada ao provedor simulado. A deduplicação é por minuto, não por dia, portanto não limita a um lembrete diário.

Corrigir recusando execução sem segredo e exigindo o Bearer em toda chamada. Separar necessidades de testes manuais da idempotência diária do cron. Não foi verificado se o segredo está ausente na implantação atual.

### A03 — Limite de sync não contém criação abusiva de cofres

[api/sync.ts:185](/Users/rafaelfarias/Documents/IDE/askesis/api/sync.ts:185)

A chave de rate limit é `${keyHash}:${ip}:${method}`. O próprio cliente escolhe qualquer hash hexadecimal de 64 caracteres, e não há cadastro anterior obrigatório. Trocar esse valor cria um contador novo para o mesmo IP. O teste do limitador confirmou a sequência permitido → bloqueado → permitido após trocar apenas o hash.

Além disso, os limites de tamanho são por requisição. O handler aceita nomes arbitrários de shards, faz HSET cumulativo e não aplica quota total do cofre ou TTL dos dados. Pedidos repetidos com novos hashes/shards permitem crescimento do Redis e consumo de comandos, sujeitos apenas a eventuais controles externos da hospedagem que não foram verificados.

Corrigir com limites independentes por IP e identidade, quota global, validação de nomes de shards e limite de armazenamento por cofre. Não se trata de acesso ao cofre de outra pessoa: o problema é abuso de recursos disponíveis publicamente.

### A04 — Arquivos anuais não participam do merge

[services/dataMerge/merge.ts:170](/Users/rafaelfarias/Documents/IDE/askesis/services/dataMerge/merge.ts:170)

O resultado começa como clone do vencedor. Há merge explícito de hábitos, dailyData, bitmasks e objetivos, mas não de `archives`. Um ano existente só no perdedor desaparece do resultado local; quando ambos têm o mesmo ano com dias diferentes, o conteúdo do perdedor também é descartado. Ambos os cenários foram reproduzidos.

No mesmo ano, uma posterior gravação do shard vencedor pode substituir também a cópia remota. Notas antigas são especialmente afetadas. Corrigir descomprimindo e mesclando por data/hábito/instância, com regras de edição e exclusão; preservar a origem se não conseguir ler um arquivo. Reutilizar o tratamento cuidadoso de arquivos ilegíveis que já existe no worker.

### A05 — lastModified não é uma geração de reset

[services/cloud.ts:734](/Users/rafaelfarias/Documents/IDE/askesis/services/cloud.ts:734)

O cliente só limpa sua base antiga quando `resetAt > state.lastModified`. Cenário: aparelho A apaga a conta em T2; B estava offline com dados anteriores, registra uma ação em T3 e sincroniza. Como T3 > T2, a base velha de B é mantida. O merge favorece o lado com hábitos e devolve os dados antigos. A comparação e o merge desse cenário foram reproduzidos; não foi executado um ensaio em dois dispositivos reais.

Há ainda um caminho direto: o POST com timestamp T3 pode ser aceito pelo servidor sem que o cliente tenha reconhecido o reset T2. Corrigir com uma geração/identificador de reset explícito nos dados e nas requisições, verificado no servidor; timestamps de edição não distinguem dados antigos de uma conta reiniciada.

### A06 — Merge de objetivos não representa desfazer e retomar

[services/dataMerge/merge.ts:124](/Users/rafaelfarias/Documents/IDE/askesis/services/dataMerge/merge.ts:124)

`days` faz união de conjuntos. Uma data retirada no aparelho mais recente volta quando o outro ainda a possui. `abandonedOn` usa a data mais antiga, então uma tentativa retomada perde para a marca de abandono da tentativa anterior. As duas falhas foram reproduzidas.

Corrigir representando desmarcações e mudanças de tentativa com metadados de edição/tombstones, vinculando abandono e conclusão à tentativa correspondente. A correção de XP realizada antes desta auditoria não corrige essas regras de sincronização.

Também há comportamento relacionado nas notas: notas de objetivos apagadas podem voltar por união de propriedades, e notas de hábitos mais longas podem substituir uma edição recente mais curta (`mergeDayRecord`, linhas 56–57). Comprimento de texto não deve definir qual edição vence.

### A07 — Conversão genérica de hexadecimal corrompe texto legítimo

[services/sync.worker.ts:29](/Users/rafaelfarias/Documents/IDE/askesis/services/sync.worker.ts:29)

O `jsonReviver` converte qualquer string iniciada por `0x` em BigInt, independentemente do campo. No round-trip criptográfico testado, `{note: "0x123"}` voltou como `{note: 291n}`; `JSON.stringify` desse objeto lança erro. Nomes, notas e títulos podem sofrer a mesma transformação.

É um resquício da representação hexadecimal dos bitmasks, que já possui parser dedicado em HabitService. Restringir a conversão aos campos de logs ou aos envelopes explicitamente tipados; preservar textos de usuário sem coerção.

### A08 — Persistir e carregar usam listas divergentes de campos

[services/persistence.ts:417](/Users/rafaelfarias/Documents/IDE/askesis/services/persistence.ts:417)

`getPersistableState()` salva `quoteState`, `aiDailyCount`, `aiQuotaDate` e `lastAIContextHash`, mas `loadState()` não os atribui ao estado global. A reprodução mostrou que quota 5, hash e frase salvos não são restaurados. Em um boot novo, o limite local de IA volta ao padrão; em um import, podem sobreviver valores da sessão anterior.

Corrigir com uma hidratação centralizada e um teste de ida e volta dos campos persistíveis. A quota de segurança deve continuar sendo controlada no servidor, mesmo depois dessa correção.

### A09 — keepalive não é reutilização de conexão HTTP

[services/api.ts:146](/Users/rafaelfarias/Documents/IDE/askesis/services/api.ts:146)

Todos os POST recebem `keepalive: true`. Esse parâmetro permite que a requisição sobreviva ao encerramento da página e tem um limite agregado de 64 KiB para corpos em trânsito, segundo o [Fetch Standard](https://fetch.spec.whatwg.org/#http-network-or-cache-fetch). O app aceita prompts até aproximadamente 150 KB e o servidor de sync aceita corpos até 5 MB.

Conclusão por inspeção e pela especificação: payloads acima de 64 KiB não podem usar esse caminho em navegadores conformes, mesmo com servidor saudável; não foi feita reprodução em navegador real nesta auditoria. Usar fetch normal para operações grandes e uma estratégia de encerramento específica para pequenos payloads. Repetir o mesmo pedido com keepalive não elimina o limite.

### A10 — Falha de auditoria vira resultado “sem vulnerabilidades”

[scripts/guardrail-audit.js:25](/Users/rafaelfarias/Documents/IDE/askesis/scripts/guardrail-audit.js:25)

O script ignora o exit code e assume zero quando não existe `metadata.vulnerabilities`. Ao simular `npm audit` saindo com código 1 e erro `ENOTFOUND`, o guardrail exibiu “Nenhuma vulnerabilidade encontrada” e terminou com código 0.

Corrigir distinguindo falha operacional de resultado válido, validando a estrutura do JSON e recusando marcar auditoria como aprovada quando ela não foi executada. O workflow noturno também usa `|| true`, sem transformar descobertas em falha; isso é aceitável como coleta de artefato, mas não como garantia de bloqueio.

### A11 — Dependências vulneráveis: presença confirmada, exploração separada

`npm audit --omit=dev`: **2 pacotes**, sendo 1 high e 1 moderate. Incluindo desenvolvimento: **15 pacotes**, sendo 5 high, 8 moderate e 2 low; nenhum critical informado. Esses números são pacotes sinalizados, não quinze exploits comprovados no Askesis.

| Pacote em produção | Instalado | Resultado e alcance |
|---|---|---|
| brace-expansion | 2.1.4 | High no npm audit; chega por @google/genai → google-auth-library → gaxios → rimraf → glob → minimatch. Não foi demonstrado caminho do input HTTP até o parser de glob no runtime Edge. |
| dompurify | 3.4.12 | Moderate no npm audit. O advisory exige IN_PLACE com hook que remove elementos; `render/dom.ts` não usa essa configuração. Não foi confirmado XSS por esse advisory no app. |

DOMPurify tem correção em 3.4.13 conforme o [aviso do mantenedor](https://github.com/cure53/DOMPurify/security/advisories/GHSA-55q2-fjhq-7xh7). Para a linha 2.x de brace-expansion, o [advisory consultado](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) indica 2.1.7 para a falha de expansão quadrática. A classificação desse advisory individual pode diferir da maior severidade atribuída ao pacote por outros advisories.

Nos pacotes de desenvolvimento aparecem também fast-uri, js-yaml, nanoid, undici e ferramentas Vitest. Priorizar atualizações compatíveis e repetir testes; não usar atualização major indiscriminada como correção automática.

### A12 — Arquivo chamado backup não contém todo o histórico

[services/habitActions/io.ts:77](/Users/rafaelfarias/Documents/IDE/askesis/services/habitActions/io.ts:77)

`exportData()` exclui `archives` explicitamente para reduzir tamanho. Como o arquivamento move registros antigos de dailyData para esses arquivos, exportar e importar não restaura o histórico completo de notas/instâncias. Os bitmasks de conclusão podem continuar presentes, o que torna a perda parcial menos evidente.

É uma decisão explícita de produto, não um acidente escondido; ainda assim, o nome `askesis-backup` sugere recuperabilidade que não existe. Oferecer backup integral ou distinguir claramente exportação parcial de backup completo.

### A13 — Falha de IndexedDB não chega ao chamador

[services/persistence.ts:208](/Users/rafaelfarias/Documents/IDE/askesis/services/persistence.ts:208)

`saveStateInternal()` e `persistStateLocally()` capturam falha de escrita e só registram no console. A Promise pode resolver normalmente sem persistir. Em falta de espaço ou erro do IndexedDB, ações/importações podem aparentar sucesso e os dados desaparecerem ao fechar, especialmente offline. Essa conclusão veio do fluxo de erro, sem simular quota real de navegador.

Corrigir com retorno explícito de sucesso/falha, sinalização ao usuário e fila recuperável; os caminhos de merge/importação não devem confirmar gravação antes do commit da transação. A nuvem pode salvar uma cópia quando disponível, mas não substitui a garantia local do fluxo offline.

## Código legado e redundâncias

1. **Lint não executa lint.** `package.json:16` mapeia lint para typecheck. `eslint.config.mjs` importa três pacotes não instalados (eslint e dois @typescript-eslint). O CI executa typecheck e depois repete o mesmo trabalho no passo Lint. Escolher entre manter ESLint funcional ou remover a configuração que não participa da validação.
2. **Barrels duplicados e dependências circulares.** `services/habitActions.ts` reexporta `services/habitActions/index.ts`. Migration e merge importam normalizadores pelo barrel que também carrega UI, persistência e cloud. O grafo detectou um componente circular de 19 módulos. Não foi comprovada uma falha de inicialização decorrente disso; é acoplamento evitável. Importar funções puras diretamente de normalization e separar fronteiras de UI/persistência antes de remover barrels.
3. **Fallback remoto que o servidor já proíbe.** `contracts/api-sync.ts:27` ainda expõe `fallback`; `services/cloud.ts:523` trata a resposta, enquanto o servidor retorna 503 e declara o fallback não atômico desativado. Confirmar compatibilidade com implantações antigas e remover o contrato/comentário mortos.
4. **Normalização repetida.** Migration e merge repetem a comparação e atribuição de mode/times/frequency. Centralizar a normalização do schedule evita que import e sync aceitem formas diferentes.
5. **Restos pequenos verificáveis.** `index.tsx:24` importa updateUIText sem usar; `build.js` tem um bloco vazio após a substituição de locale; `scripts/guardrail-audit.js` mantém execSync, countBySeverity e exitCode sem consumo relevante; `services/api.ts` diz “falling back to raw auth”, embora o código retorne null e não envie chave bruta.
6. **Documentação de contratos desatualizada.** `services/crypto.ts` descreve retorno null/formato v1 em função que retorna boolean e só aceita v3. `docs/DEPENDENCY-AUDIT.md` registra um levantamento antigo de Vite e não representa o audit atual. Atualizar a documentação sem tratá-la como evidência de comportamento presente.

O compilador com `--noUnusedLocals --noUnusedParameters` apontou sete ocorrências. Só uma era import sem uso; as demais eram parâmetros não usados. Não classifico parâmetros de callbacks ou rotinas de migração como código morto automaticamente. A migração v8→v9 e a leitura de arquivos JSON antigos ainda atendem backups e não devem ser removidas sem decisão explícita de suporte.

## Proteções existentes e limites da revisão

Há AES-GCM com sal e IV aleatórios e derivação PBKDF2; o cliente envia hash em vez da chave de criptografia. Renderização de texto utiliza nós de texto e os sinks de HTML passam por sanitização. Há cabeçalhos de CSP, controles de tamanho por requisição, atualização Redis via Lua e tombstones nos bitmasks dos hábitos. São proteções reais, mas não resolvem as falhas específicas acima.

A busca limitada por padrões comuns de chaves privadas/API no diretório de código não retornou arquivos; isso não equivale a varrer histórico Git, segredos da hospedagem ou todos os formatos possíveis. Não foram acessados dados pessoais reais, chaves de produção nem disparados testes de carga.

Pontos adicionais que exigem ensaio específico antes de concluir impacto: ETag gravado antes da reconstrução/decriptação completa (`cloud.ts:690`), descarte de erros de rede da fila quando não têm status HTTP (`cloud.ts:544`), atualização do worker de URL fixa entre deploys e limites de descompressão/importação. Não estão contabilizados como vulnerabilidades comprovadas.

## Verificação e sequência sugerida

- Suíte regular: **47 arquivos / 669 testes aprovados** (`npx vitest run`).
- Diagnóstico separado: **10 reproduções aprovadas**, demonstrando os comportamentos defeituosos descritos; a cópia temporária foi retirada da suíte regular.
- `npm run typecheck` e `npm run build`: aprovados.
- Guardrails de HTML, idiomas e service worker: aprovados.
- `npm audit --omit=dev`: 1 high e 1 moderate; o guardrail de dependências bloqueia o comando agregado `npm test` com esse resultado. A suíte foi executada diretamente, sem ocultar esse bloqueio.
- Auditoria com registry indisponível simulada em VM: saída 0 incorreta e mensagem de ausência de vulnerabilidades.
- `tsc --noUnusedLocals --noUnusedParameters`: sete apontamentos; essa opção adicional não faz parte do typecheck regular.
- Resultados brutos das dependências: [JSON de evidências](system-audit-dependencies-2026-10-02.json).

Ordem recomendada: primeiro A01–A03 (controle dos endpoints); depois A04–A08 (integridade e sincronização), com regressões de dois aparelhos; depois A09–A13 e atualização de dependências; por último limpeza de barrels, lint, duplicações e documentação. As correções de merge precisam preservar histórico e compatibilidade: substituir união por “último estado inteiro vence” criaria novas perdas de edições offline.
