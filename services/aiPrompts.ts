/** Montadores puros compartilhados; o servidor escolhe os templates confiáveis. */
type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Nome exibível de um hábito a partir do último agendamento. */
function habitDisplayName(lastSchedule: Record<string, unknown>, translations: Record<string, unknown>): string {
    const translatedName = typeof lastSchedule.nameKey === 'string' ? translations[lastSchedule.nameKey] : undefined;
    return (typeof lastSchedule.name === 'string' && lastSchedule.name)
        || (typeof translatedName === 'string' && translatedName)
        || 'Hábito';
}

/** Último agendamento de um hábito, ou `null` se a entrada não for utilizável. */
function lastScheduleOf(habitEntry: unknown): Record<string, unknown> | null {
    if (!isRecord(habitEntry)) return null;
    const scheduleHistory = Array.isArray(habitEntry.scheduleHistory) ? habitEntry.scheduleHistory : [];
    const lastSchedule = scheduleHistory[scheduleHistory.length - 1];
    return isRecord(lastSchedule) ? lastSchedule : null;
}

/**
 * Notas do usuário como texto, e não como JSON.
 *
 * O template sempre pediu esta seção (`{notesSection}`), mas o montador nunca a
 * preenchia: as notas chegavam à IA soterradas no despejo de `dailyData`, junto
 * de status e horários. Aqui elas saem em prosa, agrupadas por dia, e por isso
 * são removidas do JSON do histórico — que fica só com o padrão de ✅/⚪️/➡️.
 *
 * Objetivo secundário entra na mesma seção e só quando concluído: um objetivo
 * cumprido é um ato episódico que merece reflexão, um objetivo pela metade é
 * ruído. As anotações do percurso vêm agregadas à entrada da conclusão.
 */
function buildNotesSection(
    dailyData: Record<string, unknown>,
    habitNameById: Map<string, string>,
    questNotes: unknown[],
    translations: Record<string, unknown>
): string {
    const linhasPorDia = new Map<string, string[]>();
    const anotar = (dateKey: string, linha: string) => {
        const linhas = linhasPorDia.get(dateKey);
        if (linhas) linhas.push(linha);
        else linhasPorDia.set(dateKey, [linha]);
    };

    Object.entries(dailyData).forEach(([dateKey, day]) => {
        if (!isRecord(day)) return;
        Object.entries(day).forEach(([habitId, info]) => {
            if (!isRecord(info) || !isRecord(info.instances)) return;
            Object.entries(info.instances).forEach(([time, instance]) => {
                const note = isRecord(instance) && typeof instance.note === 'string' ? instance.note.trim() : '';
                if (note) anotar(dateKey, `  - ${habitNameById.get(habitId) || 'Hábito'} (${time}): ${note}`);
            });
        });
    });

    questNotes.forEach((entry) => {
        if (!isRecord(entry)) return;
        const date = typeof entry.date === 'string' ? entry.date : '';
        const title = typeof entry.title === 'string' ? entry.title : '';
        if (!date || !title) return;
        const target = typeof entry.target === 'number' ? entry.target : 0;
        // Marca estrutural, na mesma convenção de `[mode=scheduled]`: distingue o
        // ato episódico da nota de hábito diário sem precisar de tradução — texto
        // fixo aqui dentro sairia em português para quem usa o app em inglês.
        const marcador = target > 0 ? `[quest_completed target=${target}]` : '[quest_completed]';
        const complementos = Array.isArray(entry.notes)
            ? entry.notes
                .map((n) => (isRecord(n) && typeof n.text === 'string' ? n.text.trim() : ''))
                .filter((texto) => texto.length > 0)
            : [];
        const corpo = complementos.length > 0 ? `: ${complementos.join(' | ')}` : '';
        anotar(date, `  - ${marcador} ${title}${corpo}`);
    });

    if (linhasPorDia.size === 0) return '';

    const header = typeof translations.aiPromptNotesSectionHeader === 'string'
        ? translations.aiPromptNotesSectionHeader
        : '\nNotes:\n';
    const corpo = [...linhasPorDia.keys()].sort()
        .map((dateKey) => `${dateKey}:\n${linhasPorDia.get(dateKey)!.join('\n')}`)
        .join('\n');
    return `${header}${corpo}\n`;
}

/** Seção de hábitos graduados; vazia quando não há nenhum. */
function buildGraduatedSection(habits: unknown[], translations: Record<string, unknown>): string {
    const linhas = habits.flatMap((h) => {
        if (!isRecord(h) || !h.graduatedOn || h.deletedOn) return [];
        const lastSchedule = lastScheduleOf(h);
        return lastSchedule ? [`- ${habitDisplayName(lastSchedule, translations)}`] : [];
    });
    if (linhas.length === 0) return '';
    const template = typeof translations.aiPromptGraduatedSection === 'string'
        ? translations.aiPromptGraduatedSection
        : '{graduatedHabitDetails}';
    return template.replace('{graduatedHabitDetails}', () => linhas.join('\n'));
}

export function buildAiPrompt(data: unknown) {
    const payload = isRecord(data) ? data : {};
    const habits = Array.isArray(payload.habits) ? payload.habits : [];
    const dailyData = isRecord(payload.dailyData) ? payload.dailyData : {};
    const translations = isRecord(payload.translations) ? payload.translations : {};
    const languageName = typeof payload.languageName === 'string' ? payload.languageName : 'English';
    const questNotes = Array.isArray(payload.questNotes) ? payload.questNotes : [];
    const habitNameById = new Map<string, string>();
    let details = "";
    habits.forEach((habitEntry) => {
        if (!isRecord(habitEntry) || habitEntry.deletedOn) return;
        const lastSchedule = lastScheduleOf(habitEntry);
        if (!lastSchedule) return;
        const name = habitDisplayName(lastSchedule, translations);
        if (typeof habitEntry.id === 'string') habitNameById.set(habitEntry.id, name);
        if (habitEntry.graduatedOn) return;
        const mode = lastSchedule.mode === 'attitudinal' ? 'attitudinal' : 'scheduled';
        details += `- ${name} [mode=${mode}]\n`;
    });

    let recordedDays = 0;
    const orderedDates = Object.keys(dailyData).sort();
    orderedDates.forEach((dateKey) => {
        const day = isRecord(dailyData[dateKey]) ? dailyData[dateKey] : {};
        const hasEntries = Object.values(day).some((info) => {
            if (!isRecord(info)) return false;
            const instances = isRecord(info.instances) ? info.instances : {};
            if (Object.keys(instances).length > 0) return true;
            return !!Object.values(instances).find((instance) => isRecord(instance) && instance.note && String(instance.note).trim());
        });
        if (hasEntries) recordedDays++;
    });

    const isFirstEntry = recordedDays <= 1;
    const sparseHistory = recordedDays > 1 && recordedDays < 7;
    const contextBlock = [
        '',
        '[DATA_CONTEXT]',
        `first_entry=${isFirstEntry ? 'true' : 'false'}`,
        `sparse_history=${sparseHistory ? 'true' : 'false'}`,
        `recorded_days_in_payload=${recordedDays}`,
        'analysis_rules=When first_entry=true, treat this as beginning of journey. Do not infer "month without records" or prolonged inactivity. Focus only on provided data.'
    ].join('\n');

    const promptTemplate = typeof translations.promptTemplate === 'string' ? translations.promptTemplate : '';
    const systemTemplate = typeof translations.aiSystemInstruction === 'string' ? translations.aiSystemInstruction : '';

    // O template declara cinco marcadores; até aqui só dois eram substituídos, e
    // `{aiPeriodX}`, `{graduatedHabitsSection}` e `{notesSection}` viajavam
    // literais até o modelo. Todos os valores já existiam nos locales.
    const periodLabel = typeof translations.periodLabel === 'string' ? translations.periodLabel : '';
    const notesSection = buildNotesSection(dailyData, habitNameById, questNotes, translations);
    const graduatedSection = buildGraduatedSection(habits, translations);

    // Substituição por função: nomes de hábitos e notas são texto do usuário e
    // não podem ser interpretados como padrões (`$&`, `$\``, `$'`, `$$`).
    const prompt = promptTemplate
        .replace('{activeHabitDetails}', () => details)
        .replace(/\{aiPeriod(Monthly|Quarterly|Historical)\}/, () => periodLabel)
        .replace('{graduatedHabitsSection}', () => graduatedSection)
        .replace('{notesSection}', () => notesSection)
        // A nota já viaja em prosa na sua seção; aqui ela só duplicaria tokens.
        .replace('{history}', () => JSON.stringify(dailyData, (chave, valor) => chave === 'note' ? undefined : valor));

    return {
        prompt: prompt + contextBlock,
        systemInstruction: systemTemplate.replace('{languageName}', () => languageName)
    };
}

export function buildAiQuoteAnalysisPrompt(data: unknown) {
    const payload = isRecord(data) ? data : {};
    const context = isRecord(payload.dataContext) ? payload.dataContext : {};
    const habitModes = typeof payload.habitModes === 'string' ? payload.habitModes : '';
    const habitModesBlock = (habitModes && String(habitModes).trim())
        ? `\n\n[HABIT_MODES]\n${habitModes}`
        : '';
    const contextBlock = [
        '',
        '[DATA_CONTEXT]',
        `first_entry=${context.firstEntry ? 'true' : 'false'}`,
        `historical_days_with_notes=${context.historicalDaysWithNotes ?? 0}`,
        `historical_days_before_target=${context.daysBeforeTargetWithNotes ?? 0}`,
        'analysis_rules=When first_entry=true, evaluate only today notes and avoid assumptions about prior missing months.'
    ].join('\n');

    const translations = isRecord(payload.translations) ? payload.translations : {};
    const promptTemplate = typeof translations.aiPromptQuote === 'string' ? translations.aiPromptQuote : '';
    const systemInstruction = typeof translations.aiSystemInstructionQuote === 'string' ? translations.aiSystemInstructionQuote : '';
    const notes = typeof payload.notes === 'string' ? payload.notes : '';
    const themeList = typeof payload.themeList === 'string' ? payload.themeList : '';

    return {
        // Substituição por função: com string, `$&`, `$\``, `$'` e `$$` dentro das
        // notas seriam interpretados como padrões e corromperiam o texto do usuário.
        prompt: promptTemplate.replace('{notes}', () => notes).replace('{theme_list}', () => themeList) + habitModesBlock + contextBlock,
        systemInstruction
    };
}

