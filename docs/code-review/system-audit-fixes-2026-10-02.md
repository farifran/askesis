# Correções da auditoria — 2 de outubro de 2026

Implementação local para os achados A01–A13 do
[diagnóstico original](system-audit-2026-10-02.md). Nenhuma alteração foi publicada
na hospedagem nem aplicada a dados pessoais de produção.

## Comportamento de experiência

O XP de cada hábito é reconstruído em ordem cronológica, com piso zero em cada
dia: faltas posteriores ao esgotamento não criam dívida. Uma nova conclusão
volta a conceder XP imediatamente. Objetivos ficam ativos no dia em que zeram
e retornam à lista no dia seguinte; objetivos personalizados também podem ser
retomados. Histórico existente é preservado e recalculado sem migração destrutiva.
Regras e limites existentes, incluindo teto de XP dos objetivos, estão detalhados
em [PROGRESSION-ANALYSIS.md](../PROGRESSION-ANALYSIS.md).

## Alterações por achado

| Achado | Correção |
|---|---|
| A01 — IA aberta e instruções arbitrárias | Sessão anônima assinada em cookie HttpOnly/Secure/SameSite, emissão limitada e cotas independentes por sessão, IP e aplicativo. Templates, instruções e schema são escolhidos no servidor. Resposta limitada a 4096 tokens; chamada cancelada após 30 segundos. Cliente aguarda 35 segundos e não repete geração paga automaticamente após erro de rede. |
| A02 — lembrete sem segredo | Configuração sem CRON_SECRET retorna 503; Bearer inválido retorna 401. Idempotência por aplicativo e dia UTC evita disparos duplicados. |
| A03 — limites de sync contornáveis | Cotas por IP, cofre e aplicativo. Lista fechada de nomes de shards. Lua valida tamanho acumulado, quantidade de shards e capacidade de cofres antes de alterar dados. Limitação distribuída indisponível não libera operações. Leitura de corpos tem teto de bytes e prazo, inclusive sem Content-Length. |
| A04 — arquivos históricos descartados | União de anos e mesclagem do conteúdo do mesmo ano, com suporte a gzip e JSON legado. Remapeamento de IDs também alcança arquivos. Arquivo ilegível aborta a mesclagem, preservando as fontes. |
| A05 — reset desfeito por dispositivo offline | Geração persistente da conta, validada no servidor e no cliente. Uma base de geração antiga não pode escrever sobre a nova por ter timestamp maior. Repetir o mesmo purge é idempotente. Estado substituto só é aplicado após gravação local; filas da geração anterior são descartadas. |
| A06 — desmarcações e notas ressuscitadas | Metadados por edição de dia, nota e ciclo de vida. Desmarcações e exclusões têm registros explícitos, e retomadas não herdam abandono anterior. Alterar outra parte do estado não sobrepõe automaticamente uma nota mais recente. |
| A07 — texto 0x convertido em número | Removida a conversão genérica de strings no worker. BigInt e Map continuam usando envelopes tipados. |
| A08 — campos persistidos ignorados | Restauração de quoteState, aiDailyCount, aiQuotaDate e lastAIContextHash, além da geração da conta. |
| A09 — limite de keepalive | POSTs normais não usam keepalive; cargas superiores a 64 KiB deixam de esbarrar nesse teto do navegador. |
| A10 — auditoria indisponível reportada como limpa | Erro de execução, JSON inválido e metadados ausentes bloqueiam o guardrail. CI e rotina noturna não ocultam falhas. |
| A11 — dependências | Árvore atualizada; auditoria atual sem vulnerabilidades reportadas. |
| A12 — backup incompleto | Exportação inclui arquivos anuais, hábitos excluídos e seus logs. Importação preserva a geração da conta atual e só aplica/sincroniza após commit local. |
| A13 — falha silenciosa no disco | saveState retorna sucesso/falha; persistStateLocally propaga erro. Transações abortadas também são tratadas. Alerta persistente informa o problema e há nova tentativa ao voltar ao app/ficar online. Snapshots são copiados e gravações serializadas. |

A mesclagem por campos aplica os novos metadados às edições feitas nesta versão.
Backups antigos continuam legíveis; exclusões antigas que nunca foram registradas
não podem ser inferidas com certeza, e dados já perdidos não são recriados.

## Limpeza e correções relacionadas

- ESLint instalado e comando de lint efetivo; TypeScript permanece separado.
- Um único barrel público de habitActions; normalizadores importados diretamente
  pelos módulos de migração e merge, com normalização de agenda centralizada.
- Contrato e ramo de fallback não atômico removidos; imports/comentários mortos corrigidos.
- ETag só é confirmado após reconstrução e aplicação. Apenas baixar um backup
  não marca o estado como já aplicado.
- Falhas de rede sem status HTTP são identificadas e reenfileiradas no sync.
- Erro de autenticação da IA não apaga a chave de sincronização.
- Mantida compatibilidade das migrações antigas e dos arquivos JSON históricos.

## Configuração operacional

IA e sincronização exigem Redis disponível em produção (`KV_REST_API_URL` e
`KV_REST_API_TOKEN`, ou equivalentes `UPSTASH_REDIS_REST_*`). A sessão de IA usa
`AI_SESSION_SECRET` quando configurado; na ausência, deriva a chave de assinatura
de `API_KEY`/`GEMINI_API_KEY`. São sessões anônimas: não comprovam identidade humana.
As cotas independentes limitam abuso e custo; proteção contra bots distribuídos
pode exigir controles adicionais da hospedagem.

| Configuração | Padrão |
|---|---|
| AI_SESSION_DAILY_LIMIT | 4 gerações por sessão / janela de 24 horas |
| AI_IP_DAILY_LIMIT | 20 gerações por IP / janela de 24 horas |
| AI_GLOBAL_DAILY_LIMIT | 200 gerações no aplicativo / janela de 24 horas |
| Emissão de sessões | 4 por IP e 500 no aplicativo / janela de 24 horas |
| SYNC_RATE_LIMIT_MAX_REQUESTS | 120 por IP e por cofre / minuto |
| SYNC_GLOBAL_RATE_LIMIT | 600 / minuto |
| SYNC_MAX_VAULT_BYTES | 16 MiB de ciphertext por cofre |
| SYNC_MAX_VAULT_SHARDS | 512 por cofre |
| SYNC_MAX_VAULTS | 1000 cofres registrados |

Esses limites são limites técnicos, não previsão de custos. Cofres existentes
continuam acessíveis; não há expiração automática de dados pessoais para controlar
armazenamento. CRON_SECRET é obrigatório para envio de lembretes. Os endpoints e
o frontend precisam ser publicados juntos; clientes antigos devem atualizar o app.

## Validação

Testes de regressão abrangem experiência, retorno dos objetivos, merge de dois
aparelhos, arquivos comprimidos, recuperação após reset, notas e desmarcações,
roundtrip criptográfico, sessões inválidas/expiradas, cotas, erros de disco,
importação e falhas simuladas do npm audit. Endpoints usam mocks de Redis/Gemini/
OneSignal: nenhuma chamada paga ou disparo de notificação foi feito. O Lua foi
revisado, mas não executado contra Redis de produção.

TypeScript, ESLint, build de produção, validação de metadados, Stylelint e
os guardrails de HTML, idiomas, dependências e service worker foram aprovados.
A execução final aprovou **700 testes em 53 arquivos**, com inventário atualizado
em [tests/README.md](../../tests/README.md). A auditoria npm reportou zero vulnerabilidades
em produção e desenvolvimento na consulta desta data.
