/**
 * @license
 * SPDX-License-Identifier: MIT
 */

/**
 * @file services/progression.ts
 * @description Motor de Grau, XP e Objetivos Secundários.
 *
 * ARQUITETURA (Derivar, não acumular):
 * O XP de hábitos NÃO é um contador guardado. Ele é recalculado a partir de
 * `state.monthlyLogs`, que o merge da nuvem já une bit a bit. Um saldo escalar
 * teria o destino oposto: o merge escolhe um vencedor por `lastModified` e o
 * outro lado seria descartado inteiro — dois aparelhos usados offline no mesmo
 * dia perderiam o XP de um deles. Derivar custa uma varredura; guardar custaria
 * dados do usuário.
 *
 * O grau nunca cai SOZINHO. Objetivo abandonado ou caducado conserva o que já
 * rendeu, e falhar um dia apenas deixa de somar: punir quem falha é o oposto do
 * que este app se propõe, e um grau que anda para trás por si transformaria a
 * barra em ansiedade. A única coisa que baixa o grau é a correção manual —
 * desmarcar hoje um avanço que não houve —, exatamente como desmarcar um hábito
 * já fazia. A barra do OBJETIVO, essa sim, recua com o dia perdido; ela mede a
 * tentativa em curso, e não o que foi feito.
 *
 * [PUREZA]: este módulo não conhece i18n nem DOM. Devolve dados estruturados
 * (chaves e números); quem traduz e desenha é `render/progression.ts`.
 */

import { state, QuestRecord, bumpLastModified, getStateGeneration } from '../state';
import { QUEST_CATALOG, QUEST_TIERS, getQuestCatalogItem, type QuestCatalogItem } from '../data/quests';
import { getTodayUTCIso, generateUUID, sanitizeText, parseUTCIsoDate, MS_PER_DAY } from '../utils';
import { saveState } from './persistence';
import { emitRenderApp } from '../events';
import {
    GRADE_XP_BASE, GRADE_XP_STEP, MAX_GRADE,
    XP_PER_COMPLETION, XP_PER_OVERACHIEVEMENT,
    QUEST_MAX_ACTIVE, QUEST_FAILURE_FLOOR, QUEST_MASTERY_BONUS, QUEST_MIN_STEP_XP,
    CUSTOM_QUEST_XP_PER_DAY, CUSTOM_QUEST_MAX_TARGET, CUSTOM_QUEST_MAX_TITLE_LENGTH,
    QUEST_NOTE_MAX_LENGTH
} from '../constants';

// --- PATENTES ---

export interface RankTier {
    readonly minGrade: number;
    readonly maxGrade: number;
    readonly key: string;
}

/** As seis faixas cobrem 1..MAX_GRADE sem buraco; `getRankTier` conta com isso. */
export const RANK_TIERS: readonly RankTier[] = [
    { minGrade: 1, maxGrade: 5, key: 'rankInitiate' },
    { minGrade: 6, maxGrade: 15, key: 'rankPractitioner' },
    { minGrade: 16, maxGrade: 30, key: 'rankGuardian' },
    { minGrade: 31, maxGrade: 50, key: 'rankForger' },
    { minGrade: 51, maxGrade: 75, key: 'rankMaster' },
    { minGrade: 76, maxGrade: MAX_GRADE, key: 'rankSovereign' }
] as const;

export function getRankTier(grade: number): RankTier {
    return RANK_TIERS.find(tier => grade >= tier.minGrade && grade <= tier.maxGrade) ?? RANK_TIERS[0];
}

// --- CURVA DE GRAU ---

export interface GradeInfo {
    grade: number;
    /** XP acumulado dentro do grau atual. */
    xpInGrade: number;
    /** Custo total do grau atual; 0 quando já se está no topo. */
    xpForNext: number;
    totalXp: number;
}

/** Custo em XP para sair deste grau e entrar no seguinte. */
export function xpToAdvanceFrom(grade: number): number {
    return GRADE_XP_BASE + (grade - 1) * GRADE_XP_STEP;
}

export function gradeFromXp(totalXp: number): GradeInfo {
    let grade = 1;
    let remaining = Math.max(0, totalXp);

    while (grade < MAX_GRADE) {
        const cost = xpToAdvanceFrom(grade);
        if (remaining < cost) break;
        remaining -= cost;
        grade++;
    }

    return {
        grade,
        xpInGrade: remaining,
        xpForNext: grade >= MAX_GRADE ? 0 : xpToAdvanceFrom(grade),
        totalXp
    };
}

// --- XP DE HÁBITOS (derivado dos bitmasks) ---

/**
 * Conta instâncias concluídas percorrendo os blocos de 3 bits de cada mês.
 *
 * O deslocamento é progressivo (`v >>= 3n`) em vez de indexado por dia: um mês
 * pouco preenchido termina no primeiro bloco zerado à esquerda, em vez de varrer
 * os 93 blocos sempre. O layout é o de `HabitService`: bits 0-1 são o status,
 * bit 2 é a lápide, e bloco com lápide vale NULL — por isso só 1 (DONE) e
 * 3 (DONE_PLUS) contam.
 */
function countCompletions(): { done: number; overachieved: number } {
    let done = 0;
    let overachieved = 0;

    const logs = state.monthlyLogs;
    if (!logs) return { done, overachieved };

    for (const log of logs.values()) {
        let remaining = log;
        while (remaining > 0n) {
            const block = remaining & 7n;
            if (block === 1n) done++;
            else if (block === 3n) overachieved++;
            remaining >>= 3n;
        }
    }

    return { done, overachieved };
}

// --- OBJETIVOS: LEITURA ---

export function getQuestTarget(quest: QuestRecord): number {
    return getQuestCatalogItem(quest.id)?.target ?? quest.customTarget ?? 1;
}

export function getQuestTotalXp(quest: QuestRecord): number {
    const item = getQuestCatalogItem(quest.id);
    if (item) return item.xp;
    return (quest.customTarget ?? 1) * CUSTOM_QUEST_XP_PER_DAY;
}

/** XP creditado a cada avanço diário registrado. */
export function getQuestStepXp(quest: QuestRecord): number {
    return Math.max(QUEST_MIN_STEP_XP, Math.round(getQuestTotalXp(quest) / getQuestTarget(quest)));
}

/** Mesma conta, para um item de catálogo ainda não ativado. */
export function getCatalogStepXp(target: number, xp: number): number {
    return Math.max(QUEST_MIN_STEP_XP, Math.round(xp / target));
}

/** Cadência esperada, em dias, entre um avanço e o seguinte (1 = diário). */
function getQuestCadence(quest: QuestRecord): number {
    return getQuestCatalogItem(quest.id)?.cadence ?? 1;
}

/** Começo da tentativa em curso; sem retomada, é o dia da ativação. */
function attemptStart(quest: QuestRecord): string {
    return quest.attemptFrom ?? quest.startedOn;
}

/**
 * Avanço LÍQUIDO: dias marcados menos dias perdidos.
 *
 * O dia de hoje nunca cobra — só ciclos JÁ FECHADOS. Quem marcou três dias e
 * deixa o quarto passar vê 3 durante todo o quarto dia e 2 na manhã do quinto:
 * a conta muda quando o dia acaba, não quando ele começa.
 *
 * A perda é DEFINITIVA dentro da tentativa. Contar "quantos avanços faltam para
 * a data de hoje" seria mais curto, mas apagaria o prejuízo no instante em que a
 * pessoa se pusesse em dia — quem perdeu o quarto dia e marcou o quinto voltaria
 * de 2 direto para 4. Por isso o que se conta são os ciclos vazios, um por um.
 *
 * A cadência agrupa os dias: um objetivo de ritmo semanal deve um avanço a cada
 * sete dias, e cobrá-lo diariamente o mataria antes da primeira semana.
 *
 * Nada disso é guardado. Sai de `days` + calendário, então dois aparelhos que se
 * sincronizam chegam ao mesmo número sem nenhum campo para conciliar.
 */
export function getQuestNetProgress(quest: QuestRecord): number {
    const from = parseUTCIsoDate(attemptStart(quest)).getTime();
    const cadence = getQuestCadence(quest);

    const closedDays = Math.max(0, Math.round((parseUTCIsoDate(getTodayUTCIso()).getTime() - from) / MS_PER_DAY));
    const closedCycles = Math.floor(closedDays / cadence);

    let marked = 0;
    const cyclesWithProgress = new Set<number>();
    for (const day of quest.days) {
        const offset = Math.round((parseUTCIsoDate(day).getTime() - from) / MS_PER_DAY);
        if (offset < 0) continue;  // dias de uma tentativa anterior
        marked++;
        cyclesWithProgress.add(Math.floor(offset / cadence));
    }

    let missed = 0;
    for (let cycle = 0; cycle < closedCycles; cycle++) {
        if (!cyclesWithProgress.has(cycle)) missed++;
    }

    return marked - missed;
}

/** O que a barra mostra: o líquido, preso entre zero e o alvo. */
export function getQuestProgress(quest: QuestRecord): number {
    return Math.min(getQuestTarget(quest), Math.max(0, getQuestNetProgress(quest)));
}

/**
 * Caducou: o abandono que a própria falta de uso escreve.
 *
 * Sem lápide no estado, de propósito. A data de hoje é o que decide, e ela é a
 * mesma nos dois aparelhos — gravar `expiredOn` num deles criaria um conflito
 * onde não havia nenhum. Retomar depois é possível (ver `activateQuest`).
 */
export function isQuestExpired(quest: QuestRecord): boolean {
    if (quest.completedOn || quest.abandonedOn) return false;
    return getQuestNetProgress(quest) <= QUEST_FAILURE_FLOOR;
}

function isQuestActive(quest: QuestRecord): boolean {
    return !quest.completedOn && !quest.abandonedOn && !isQuestExpired(quest);
}

/**
 * Todos os objetivos em curso — deliberadamente SEM cortar em QUEST_MAX_ACTIVE.
 *
 * A união da nuvem pode devolver mais de três: dois aparelhos com dois slots
 * ocupados, cada um ativando um objetivo diferente offline, somam quatro. Cortar
 * aqui esconderia o excedente numa posição de onde ele não poderia ser
 * registrado nem abandonado — perda silenciosa de dado, justamente o que o
 * modelo de dados foi desenhado para evitar. O teto vale para ATIVAR; passar
 * dele é um estado visível, que o usuário desfaz abandonando.
 */
export function getActiveQuests(): QuestRecord[] {
    return state.quests.filter(isQuestActive);
}

export function getCompletedQuestIds(): Set<string> {
    const ids = new Set<string>();
    for (const quest of state.quests) {
        if (quest.completedOn) ids.add(quest.id);
    }
    return ids;
}

export function isQuestRegisteredOn(quest: QuestRecord, dateISO: string): boolean {
    return quest.days.includes(dateISO);
}

/**
 * XP já rendido por um objetivo — contado em DIAS MARCADOS, não no líquido.
 *
 * É aqui que a regressão para. A barra do objetivo recua quando um dia se perde,
 * porque ela mede a tentativa em curso; o grau não recua nunca, porque mede o
 * que foi feito. Um dia cumprido e depois "perdido" continua tendo sido cumprido
 * — descontá-lo do XP faria a barra de grau andar para trás, que é a única coisa
 * que este motor promete nunca fazer.
 *
 * Objetivo abandonado ou caducado conserva o mesmo pelo mesmo motivo.
 */
function questEarnedXp(quest: QuestRecord): number {
    const stepXp = getQuestStepXp(quest);
    let xp = quest.days.length * stepXp;
    if (quest.completedOn) xp += Math.round(getQuestTotalXp(quest) * QUEST_MASTERY_BONUS);
    return xp;
}

// --- TETO DE XP POR LEVA ---

/** XP acumulado para estar no COMEÇO de um grau (zero de avanço dentro dele). */
function xpToReachGrade(grade: number): number {
    let total = 0;
    for (let g = 1; g < grade; g++) total += xpToAdvanceFrom(g);
    return total;
}

/**
 * Teto acumulado que os objetivos podem somar, leva por leva.
 *
 * Limpar uma leva leva no máximo ao grau imediatamente ANTERIOR ao exigido pela
 * leva seguinte: os objetivos nunca entregam de graça a chave da porta de cima.
 * O último grau que falta é sempre dos hábitos, que é onde a disciplina de fato
 * mora — sem isto, uma sequência de desafios curtos abriria a escada inteira.
 *
 * O excedente é DESCARTADO, não guardado para depois: se transbordasse para a
 * leva seguinte, o teto seria apenas um atraso, e limpar a leva 1 continuaria
 * abrindo a leva 3 com um dia de diferença. A última leva não tem teto — dali
 * para cima não há porta nenhuma a proteger.
 */
const TIER_XP_CEILINGS: readonly number[] = QUEST_TIERS.map((tier, index) => {
    const nextTier = QUEST_TIERS[index + 1];
    return nextTier === undefined ? Infinity : xpToReachGrade(nextTier - 1);
});

/**
 * XP dos objetivos, somado por leva e cortado no teto de cada uma.
 *
 * Objetivo personalizado entra na leva em que a pessoa está trabalhando: é
 * trabalho dela, e o mesmo teto vale. Deixá-lo fora daria a volta em toda a
 * regra — um objetivo de 365 dias renderia 9.125 XP e cunharia o grau à vontade.
 */
function cappedQuestXp(): number {
    const fallbackTier = currentTierState().tier;
    const byTier = new Map<number, number>();

    for (const quest of state.quests) {
        const tier = getQuestCatalogItem(quest.id)?.reqGrade ?? fallbackTier;
        byTier.set(tier, (byTier.get(tier) ?? 0) + questEarnedXp(quest));
    }

    let total = 0;
    QUEST_TIERS.forEach((tier, index) => {
        total = Math.min(total + (byTier.get(tier) ?? 0), TIER_XP_CEILINGS[index]);
    });
    return total;
}

// --- AGREGADO (memoizado) ---

let cachedGrade: GradeInfo | null = null;
let cachedForGeneration = -1;

/**
 * Grau e XP atuais.
 *
 * A varredura dos bitmasks é barata mas não é de graça, e `renderApp` chega aqui
 * a cada frame de navegação entre dias. A chave é a geração do estado, e não
 * `lastModified`: reset, import e volta da nuvem podem reinstalar um timestamp
 * já visto, e o cache devolveria um grau calculado sobre outros dados.
 */
export function getProgression(): GradeInfo {
    if (cachedGrade && cachedForGeneration === getStateGeneration()) return cachedGrade;

    const { done, overachieved } = countCompletions();
    const habitXp = done * XP_PER_COMPLETION + overachieved * (XP_PER_COMPLETION + XP_PER_OVERACHIEVEMENT);

    // Hábito não tem teto; objetivo tem, por leva. Somar depois do corte é o que
    // garante que o teto limite os objetivos e não a disciplina diária.
    cachedGrade = gradeFromXp(habitXp + cappedQuestXp());
    cachedForGeneration = getStateGeneration();
    return cachedGrade;
}

// --- DESBLOQUEIO ---

export type UnlockStatus =
    | { unlocked: true }
    | { unlocked: false; reason: 'grade'; requiredGrade: number }
    | { unlocked: false; reason: 'slots'; tierGrade: number; pending: number }
    | { unlocked: false; reason: 'later'; tierGrade: number };

/**
 * A leva em que a pessoa está e quantos objetivos dela ainda esperam por um slot.
 *
 * "Está" não é a leva do grau atual: é a primeira que ainda tem o que oferecer.
 * Quem chegou ao grau 10 sem tocar nos objetivos do grau 1 continua no 1 — e é o
 * que mantém o catálogo apontando para o que destrava o caminho, em vez de
 * esconder os fáceis justamente de quem precisa deles.
 *
 * Concluído sai da conta para sempre. Ativo sai porque já está num slot. Tudo o
 * mais conta, inclusive o que caducou: caducar não é cumprir, e se tirasse da
 * conta, ativar a leva inteira e abandoná-la ao relento seria o caminho mais
 * rápido para a leva seguinte.
 *
 * Devolve os dois números juntos porque quem pergunta um quase sempre precisa do
 * outro, e separá-los custava cinco varreduras do catálogo em vez de uma.
 */
function currentTierState(): { tier: number; pending: number } {
    const completedIds = getCompletedQuestIds();
    const activeIds = new Set(getActiveQuests().map(quest => quest.id));

    const pendingByTier = new Map<number, number>();
    for (const item of QUEST_CATALOG) {
        if (completedIds.has(item.id) || activeIds.has(item.id)) continue;
        pendingByTier.set(item.reqGrade, (pendingByTier.get(item.reqGrade) ?? 0) + 1);
    }

    for (const tier of QUEST_TIERS) {
        const pending = pendingByTier.get(tier) ?? 0;
        if (pending > 0) return { tier, pending };
    }

    // Catálogo esgotado: a última leva é o fim da escada.
    return { tier: QUEST_TIERS[QUEST_TIERS.length - 1], pending: 0 };
}

/**
 * Regra dos SLOTS: a leva seguinte abre quando a atual já não tem com que
 * encher os seus três slots.
 *
 * Com três slots e dois objetivos de grau 1 sobrando, um slot fica sem
 * candidato da leva atual — e é esse slot que a leva seguinte pode ocupar. A
 * conta é `ativos + pendentes da leva atual < QUEST_MAX_ACTIVE`, então o slot
 * excedente continua disponível indefinidamente: quem nunca fizer aqueles dois
 * segue evoluindo naquele slot, um objetivo da leva de cima após o outro.
 *
 * A regra anterior era "conclua todos menos dois da leva anterior", que dizia a
 * mesma coisa por acidente quando nada estava ativo, e mentia no resto do tempo:
 * ignorava o que já ocupava slot e cobrava conclusão de quem só precisava sair
 * do caminho. Nenhuma leva além da seguinte abre — pular graus tiraria o sentido
 * da escada.
 */
export function getQuestUnlockStatus(reqGrade: number): UnlockStatus {
    const { grade } = getProgression();
    if (grade < reqGrade) return { unlocked: false, reason: 'grade', requiredGrade: reqGrade };

    const { tier: currentTier, pending } = currentTierState();
    if (reqGrade <= currentTier) return { unlocked: true };

    const nextTier = QUEST_TIERS[QUEST_TIERS.indexOf(currentTier) + 1];
    if (reqGrade !== nextTier) return { unlocked: false, reason: 'later', tierGrade: nextTier ?? currentTier };

    if (getActiveQuests().length + pending < QUEST_MAX_ACTIVE) return { unlocked: true };

    return { unlocked: false, reason: 'slots', tierGrade: currentTier, pending };
}

// --- OBJETIVOS: MUTAÇÕES ---

export type QuestFailure =
    | 'slotsFull'
    | 'locked'
    | 'unknownQuest'
    | 'invalidTitle';

/**
 * `completed` é o único dado que o resultado carrega: XP não vem por aqui.
 *
 * Havia um `gainedXp` calculado a cada registro para alimentar um aviso de "+N
 * XP" que já não existe. Além de morto, repetia a fórmula do prêmio de maestria
 * que `questEarnedXp` também aplica — duas contas para o mesmo valor, livres
 * para divergir. O saldo é sempre derivado; ninguém o anuncia.
 */
export type QuestActionResult =
    | { ok: true; completed: boolean }
    | { ok: false; reason: QuestFailure };

/**
 * Persiste e repinta após uma mudança em objetivos.
 *
 * `saveState(true)` grava na hora em vez de esperar o debounce de 800ms: o
 * registro de avanço é uma ação por dia, e fechar o app logo depois não pode
 * desfazê-la — mesma razão do toggle de status do hábito.
 */
function notifyQuestChange() {
    bumpLastModified();
    void saveState(true);
    requestAnimationFrame(() => emitRenderApp());
}

export function activateQuest(questId: string): QuestActionResult {
    const item = getQuestCatalogItem(questId);
    if (!item) return { ok: false, reason: 'unknownQuest' };
    if (getActiveQuests().length >= QUEST_MAX_ACTIVE) return { ok: false, reason: 'slotsFull' };
    if (!getQuestUnlockStatus(item.reqGrade).unlocked) return { ok: false, reason: 'locked' };

    // Retomada: um só registro por id, sempre. Nasce uma TENTATIVA nova — a
    // lápide sai e a janela do avanço passa a contar de hoje, senão os dias
    // perdidos da tentativa anterior matariam o objetivo no mesmo instante em
    // que ele volta ao slot. Os dias antigos ficam em `days`: são XP ganho, e
    // apagá-los faria o grau andar para trás.
    const existing = state.quests.find(q => q.id === questId);
    if (existing) {
        if (existing.completedOn) return { ok: false, reason: 'unknownQuest' };
        existing.abandonedOn = undefined;
        existing.attemptFrom = getTodayUTCIso();
    } else {
        state.quests.push({ id: questId, startedOn: getTodayUTCIso(), days: [] });
    }

    notifyQuestChange();
    return { ok: true, completed: false };
}

export function createCustomQuest(rawTitle: string, rawTarget: number): QuestActionResult {
    if (getActiveQuests().length >= QUEST_MAX_ACTIVE) return { ok: false, reason: 'slotsFull' };

    const title = sanitizeText(rawTitle, CUSTOM_QUEST_MAX_TITLE_LENGTH);
    if (!title) return { ok: false, reason: 'invalidTitle' };

    // O alvo vem de um campo de formulário, então é preso na faixa aqui. O XP
    // sai do alvo e não do usuário: no protótipo `createCustomQuest` recebia o
    // XP como argumento, o que deixava qualquer um cunhar o próprio grau.
    const target = Math.min(CUSTOM_QUEST_MAX_TARGET, Math.max(1, Math.floor(rawTarget) || 1));

    state.quests.push({
        id: `custom:${generateUUID()}`,
        startedOn: getTodayUTCIso(),
        days: [],
        customTitle: title,
        customTarget: target
    });

    notifyQuestChange();
    return { ok: true, completed: false };
}

/**
 * Marca ou desmarca o avanço de hoje — dois estados, como o cartão de hábito.
 *
 * Não existe "adiado" aqui: um objetivo secundário foi feito hoje ou não foi. E
 * como no hábito, tocar de novo desfaz — o toque errado se corrige onde
 * aconteceu, sem menu.
 *
 * Desmarcar DEVOLVE o XP daquele dia, e é a única coisa em todo o motor que
 * baixa o grau. Não é regressão automática: é a mesma correção manual que
 * desmarcar um hábito já fazia. O que o grau promete é nunca cair sozinho.
 *
 * `getTodayUTCIso` devolve a data do calendário LOCAL. Um
 * `toISOString().slice(0,10)` cru daria a data UTC e, a leste ou a oeste de
 * Greenwich, marcaria o avanço no dia errado.
 */
export function toggleQuestProgress(questId: string): QuestActionResult {
    const quest = state.quests.find(q => q.id === questId);
    if (!quest || !isQuestActive(quest)) return { ok: false, reason: 'unknownQuest' };

    const today = getTodayUTCIso();

    if (isQuestRegisteredOn(quest, today)) {
        quest.days = quest.days.filter(day => day !== today);
        // Conclusão de hoje se desfaz junto; a de outro dia já tirou o objetivo
        // da lista e não há cartão para tocar.
        if (quest.completedOn === today) quest.completedOn = undefined;
        notifyQuestChange();
        return { ok: true, completed: false };
    }

    quest.days.push(today);
    quest.days.sort();

    // Fecha pelo LÍQUIDO da tentativa em curso, não pelo total de dias marcados:
    // um dia perdido pelo caminho tem de ser reposto antes de o objetivo fechar.
    const completed = getQuestNetProgress(quest) >= getQuestTarget(quest);
    if (completed) quest.completedOn = today;

    notifyQuestChange();
    return { ok: true, completed };
}

/** Nota do dia num objetivo, como a nota do cartão de hábito. */
export function getQuestNote(quest: QuestRecord, dateISO: string): string {
    return quest.notes?.[dateISO] ?? '';
}

/**
 * Grava (ou apaga) a nota de um dia.
 *
 * Texto vazio remove a chave em vez de guardar `''`: um dia sem nota não deve
 * ocupar espaço no payload da nuvem nem contar como escrita no merge.
 */
export function setQuestNote(questId: string, dateISO: string, rawText: string): void {
    const quest = state.quests.find(q => q.id === questId);
    if (!quest) return;

    const text = sanitizeText(rawText, QUEST_NOTE_MAX_LENGTH);
    if (getQuestNote(quest, dateISO) === text) return;

    if (!text) {
        if (quest.notes) delete quest.notes[dateISO];
    } else {
        quest.notes = { ...quest.notes, [dateISO]: text };
    }

    notifyQuestChange();
}

export function abandonQuest(questId: string): QuestActionResult {
    const quest = state.quests.find(q => q.id === questId);
    if (!quest || !isQuestActive(quest)) return { ok: false, reason: 'unknownQuest' };

    quest.abandonedOn = getTodayUTCIso();
    notifyQuestChange();
    return { ok: true, completed: false };
}

/**
 * O que o catálogo mostra: a leva atual e a seguinte.
 *
 * Objetivos em curso entram sempre, de qualquer leva — sem isso, um objetivo
 * ativado antes de avançar sairia da lista e ficaria impossível de abandonar,
 * já que abandonar só existe aqui.
 */
export function getVisibleCatalog(): readonly QuestCatalogItem[] {
    const current = currentTierState().tier;
    const next = QUEST_TIERS[QUEST_TIERS.indexOf(current) + 1];
    const tiers = new Set(next === undefined ? [current] : [current, next]);
    const activeIds = new Set(getActiveQuests().map(q => q.id));

    return QUEST_CATALOG.filter(item => tiers.has(item.reqGrade) || activeIds.has(item.id));
}

/**
 * Existe leva além das duas que o catálogo mostra?
 *
 * Serve para o aviso do fim da lista aparecer só quando há de fato mais coisa
 * guardada — no topo da escada ele seria uma promessa falsa.
 */
export function hasHiddenQuestTiers(): boolean {
    return QUEST_TIERS.indexOf(currentTierState().tier) + 2 < QUEST_TIERS.length;
}

