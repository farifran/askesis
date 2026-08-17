# ADR-0008: Account Reset — Vault Purge and `resetAt` Epoch

- Status: accepted
- Date: 2026-08-17
- Owners: Sync and API

## Context

"Apagar dados" nas Configurações Gerais tinha um alcance só: limpava o estado
local, apagava o IndexedDB, **descartava a chave de sync** e recarregava. Quem
sincroniza queria a outra coisa — zerar a conta e continuar sincronizado — e o
caminho para isso não existia em nenhuma camada:

1. **O POST de sync não sabe apagar.** O script Lua em `api/sync.ts` só faz
   `HSET` por shard. Mandar um estado vazio sobrescreve `core`, mas deixa de pé
   todo `logs:<mês>` e `archive:<ano>` que o aparelho já esqueceu — o cofre
   continua cheio, com um `core` vazio por cima.
2. **O merge ressuscita o lado cheio.** `mergeStates` tem regra explícita: se um
   lado está sem hábitos e o outro não, o cheio vence, independentemente do
   carimbo (`services/dataMerge/merge.ts`). Um aparelho zerado que mantivesse a
   chave baixaria tudo de volta no boot seguinte.
3. **Outros aparelhos não sabem do reset.** Mesmo com o cofre limpo, o segundo
   aparelho ainda tem a base antiga e a reenvia no primeiro sync.

## Decision

Dois escopos no botão, com uma pergunta antes da confirmação destrutiva:

- **Dados do aplicativo** — comportamento anterior: limpa o local e desvincula a
  chave. O cofre continua na nuvem e volta ao colar a chave de novo. A chave sai
  de propósito: mantê-la faria o boot rebaixar tudo, o que é "limpar cache", não
  apagar.
- **Dados da conta** — zera a conta inteira, mantendo a sincronização ligada e a
  mesma chave.

O segundo escopo precisou de duas peças novas:

**Purge no servidor.** O POST aceita `purge: true` (booleano estrito). No Lua, o
purge faz `DEL` da chave antes de gravar os shards enviados, e grava `resetAt`
junto do `lastModified`. O purge **não** passa pelo controle otimista de
concorrência: apagar é ordem explícita do dono da chave, e um relógio atrasado
não pode prendê-lo a um cofre que ele mandou apagar. Para manter a ordem, o
carimbo avança à força (`newTs = max(newTs, currentTs + 1)`).

**Epoch `resetAt`.** Campo em texto claro no hash, ao lado de `lastModified` —
não é shard cifrado, e `decryptServerShards` o ignora como já ignorava o
`lastModified`. No boot, `fetchStateFromCloud` compara: se
`resetAt > state.lastModified`, a base local é anterior ao reset e é descartada
antes do merge. O que foi registrado **depois** do carimbo sobrevive: é trabalho
novo, não sobra do que o usuário mandou apagar.

Ordem de execução do reset de conta: purga primeiro, apaga o local depois. Se a
nuvem recusar, nada é apagado e o erro chega à tela — um aparelho vazio diante de
um cofre cheio desfaria o reset no boot seguinte e viraria um susto sem efeito.

## Alternatives considered

- **Método `DELETE` no endpoint.** Mesma semântica, mas exigiria mexer no CORS
  (`Access-Control-Allow-Methods`) e num segundo caminho de rate limit. O flag no
  POST reusa validação, limites e script já existentes.
- **Só purgar o cofre, sem `resetAt`.** Metade do trabalho: o segundo aparelho
  reenviaria a base antiga no primeiro sync e ressuscitaria a conta.
- **Lápides por hábito em vez do epoch.** O merge respeita lápides, mas elas não
  cobrem `dailyData`, `archives` nem `monthlyLogs`, e o custo de gerar uma lápide
  por hábito cresce com o histórico — justamente o que o reset quer jogar fora.
- **Manter a chave no "apagar dados do aplicativo".** Vira um repovoamento a
  partir da nuvem; não é o que o botão promete.

## Consequences

- O purge é a primeira operação destrutiva do endpoint. A validação do flag é
  estrita (`typeof === 'boolean'`) para que nenhum valor "quase verdadeiro" de
  cliente antigo ou proxy vire um apagar.
- Entre o purge e o reload, o cliente trava o sync (`isVaultResetInProgress`):
  um envio pendente com carimbo antigo levaria 409, e a resolução de conflito
  ressuscitaria o estado que acabou de ser apagado.
- Um aparelho offline que registre algo depois do reset mantém esses dados e os
  reenvia. É a mesma política Last-Write-Wins do ADR-0003, aplicada ao reset.
- Hashes de shard e ETag são zerados nos dois escopos: descrevem um cofre que não
  existe mais e fariam o sync seguinte pular shards por "nada mudou".
- A semântica do Lua só roda de verdade contra o Redis; os testes cobrem o
  cabeamento dos ARGV e a validação do flag.

## Rollback plan

- Reverter o cliente para um único escopo (o de aparelho) desativa o caminho sem
  tocar no servidor.
- O `purge` e o `resetAt` no servidor são compatíveis com clientes antigos: sem o
  flag, o script se comporta como antes; sem leitura do `resetAt`, o cliente
  antigo só ignora o campo.

## References

- `api/sync.ts`
- `services/cloud.ts`
- `services/reset.ts`
- `services/habitActions/deletion.ts`
- `listeners/modals.ts`
- `listeners/resetData.test.ts`
- `services/cloud.test.ts`
- `api/sync.test.ts`
