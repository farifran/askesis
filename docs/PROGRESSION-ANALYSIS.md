# Análise de experiência e objetivos secundários

Análise do código local em 2 de outubro de 2026.

## Comportamento anterior

O XP não era um saldo persistido: era recalculado dos registros de hábitos
(`monthlyLogs`) e das datas dos objetivos (`quests`).

- Hábito concluído: 10 XP por período; superação: 15 XP; adiado: 0 XP e sem desconto.
- Cada período agendado não marcado em um dia encerrado descontava 10 XP.
- O cálculo por hábito era `max(0, ganhos históricos − faltas históricas × 10)`.
  O piso protegia outros hábitos, mas não eliminava a dívida interna. Exemplo:
  uma conclusão e cinco faltas produziam saldo visível zero e saldo interno −40;
  uma nova conclusão continuava mostrando zero.
- Objetivos: um avanço por ciclo (diário ou conforme a cadência do catálogo),
  com XP por avanço igual ao maior entre o piso configurado e o prêmio total
  dividido pelo alvo, arredondado. Personalizados concedem 25 XP por avanço.
- O avanço líquido dos objetivos também podia ser negativo. Entretanto, eles
  já saíam dos ativos ao chegar a −1, e reativar um objetivo de catálogo abria
  uma tentativa nova. Portanto, a dívida prolongada era diretamente reproduzível
  nos hábitos; nos objetivos havia também outros limites a considerar.
- Objetivos personalizados expirados desapareciam do catálogo, que só mostrava
  personalizados ativos.

## Correção aplicada

O saldo de cada hábito é reconstruído em ordem cronológica, com piso zero em
cada dia. A falta só desconta o saldo existente, incluindo qualquer resto de
bônus. Faltas seguintes não geram dívida; uma conclusão hoje concede XP de
imediato. O histórico de faltas é preservado. Hoje nunca sofre desconto por
períodos ainda não marcados; esses períodos só são cobrados quando o dia fecha.

Objetivos usam saldo não negativo por ciclo. Ao perder o último avanço, ficam
ativos durante o dia em que o saldo zerou. Se não houver nova marcação nesse
dia, saem dos ativos no dia seguinte e ficam disponíveis na lista. Isso também
vale para objetivos semanais: após zerarem, a saída acontece no próximo dia,
sem aguardar outra semana. Um objetivo recém-ativado sem nenhuma marcação
continua tendo seu primeiro ciclo inteiro para começar, como antes.

A retomada abre uma tentativa com saldo zero, conserva o histórico e permite
que a primeira marcação conceda XP. Objetivos personalizados também aparecem
na lista para retomada. Ativar um objetivo já ativo não reinicia sua tentativa.

Não há migração destrutiva: o saldo é recalculado usando os registros existentes.
Isso pode elevar o XP atual de quem tinha ganhos posteriores a faltas sem saldo.

## Regras existentes preservadas

- Descontos só ocorrem por períodos agendados; adiamento protege e horários
  substituídos pela agenda daquele dia são respeitados.
- Hábitos graduados preservam seus ganhos; registros sem hábito correspondente
  não têm uma agenda pela qual cobrar faltas.
- Objetivos concluídos preservam o prêmio, incluindo bônus de maestria de 20%.
- Abandono manual não remove imediatamente o XP: ele diminui conforme os ciclos
  vazios fecham, limitado a zero.
- O XP agregado dos objetivos continua sujeito ao teto por leva. Assim, uma
  marcação pode aumentar o progresso de um objetivo sem aumentar o XP total
  quando esse teto já foi atingido. Esse efeito é independente da dívida corrigida.
- Hábitos não têm esse teto. O grau é recalculado a partir do XP total e pode cair.
- A data usada é a do calendário local; o cache de progressão considera a
  geração do estado e a data, para atualizar na próxima leitura após a meia-noite.

## Verificação

Testes de regressão cobrem retomada após 60 dias sem marcar, faltas antes da
primeira marcação, bônus parcialmente consumido, isolamento entre hábitos,
adiamento, agenda, retorno dos objetivos no dia seguinte ao zero, cadência
semanal e retomada de objetivos personalizados preservando o histórico.
