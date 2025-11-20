/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Análise completa. Otimização de performance implementada: caching de estatísticas de escala para evitar recálculos pesados no evento de 'pointermove' e hoisting de variáveis invariantes no loop de cálculo de dados.

import { state } from './state';
import { ui } from './ui';
import { t } from './i18n';
import { addDays, getTodayUTCIso, parseUTCIsoDate, toUTCIsoDateString } from './utils';
import { getActiveHabitsForDate } from './state';

const CHART_DAYS = 30;
const INITIAL_SCORE = 100; // Pontuação inicial para o crescimento composto
const MAX_DAILY_CHANGE_RATE = 0.015; // Mudança máxima de 1.5% por dia

type ChartDataPoint = {
    date: string;
    value: number; // Agora representa a pontuação composta
    completedCount: number;
    scheduledCount: number;
};


// OTIMIZAÇÃO DE PERFORMANCE [2024-10-10]: Variáveis de estado do módulo para gerenciar a renderização do gráfico.
// `chartInitialized` previne a recriação do DOM. `lastChartData` é usado pelos listeners de eventos
// para evitar o recálculo de dados em cada movimento do mouse.
let chartInitialized = false;
let lastChartData: ChartDataPoint[] = [];

// PERFORMANCE [2025-01-15]: Cache para metadados de escala (min/max/range).
// Evita recalcular Math.min/max em todo o array de dados a cada evento de 'pointermove'.
let chartMetadata = {
    minVal: 0,
    maxVal: 100,
    valueRange: 100
};

// OTIMIZAÇÃO DE PERFORMANCE [2024-12-25]: Os elementos internos do gráfico são armazenados
// em cache após a primeira renderização para evitar consultas repetidas ao DOM.
let chartElements: {
    chartSvg?: SVGSVGElement;
    areaPath?: SVGPathElement;
    linePath?: SVGPathElement;
    evolutionIndicator?: HTMLElement;
    axisStart?: HTMLElement;
    axisEnd?: HTMLElement;
    chartWrapper?: HTMLElement;
    tooltip?: HTMLElement;
    indicator?: HTMLElement;
} = {};


function calculateChartData(): ChartDataPoint[] {
    const data: ChartDataPoint[] = [];
    const endDate = parseUTCIsoDate(state.selectedDate);
    const startDate = addDays(endDate, -(CHART_DAYS - 1));
    const todayISO = getTodayUTCIso(); // PERFORMANCE: Hoisted out of loop

    let previousDayValue = INITIAL_SCORE;

    for (let i = 0; i < CHART_DAYS; i++) {
        const currentDate = addDays(startDate, i);
        const currentDateISO = toUTCIsoDateString(currentDate);

        const activeHabitsData = getActiveHabitsForDate(currentDate);
        const dailyInfo = state.dailyData[currentDateISO] || {};

        let scheduledCount = 0;
        let completedCount = 0;
        let pendingCount = 0;

        activeHabitsData.forEach(({ habit, schedule: scheduleForDay }) => {
            const instances = dailyInfo[habit.id]?.instances || {};

            scheduledCount += scheduleForDay.length;
            scheduleForDay.forEach(time => {
                const status = instances[time]?.status ?? 'pending';
                if (status === 'completed') {
                    completedCount++;
                } else if (status === 'pending') {
                    pendingCount++;
                }
            });
        });

        const hasPending = pendingCount > 0;
        const isToday = currentDateISO === todayISO;

        let currentValue: number;
        // CORREÇÃO DE LÓGICA DE DADOS [2024-12-25]: A lógica foi corrigida novamente para garantir que a pontuação
        // só "congele" se o dia com pendências for o dia de *hoje*. Isso estabiliza
        // os dados históricos, pois a pontuação de dias passados é sempre calculada com base no que foi concluído.
        if (isToday && hasPending) {
            currentValue = previousDayValue;
        } else if (scheduledCount > 0) {
            const completionRatio = completedCount / scheduledCount;
            // Mapeia a taxa de conclusão [0, 1] para um fator de performance [-1, 1]
            // 0% -> -1, 50% -> 0, 100% -> 1
            const performanceFactor = (completionRatio - 0.5) * 2;
            const dailyChange = performanceFactor * MAX_DAILY_CHANGE_RATE;
            currentValue = previousDayValue * (1 + dailyChange);
        } else {
            // Se não houver hábitos agendados, a pontuação não muda.
            currentValue = previousDayValue;
        }
        
        data.push({
            date: currentDateISO,
            value: currentValue,
            completedCount,
            scheduledCount,
        });

        previousDayValue = currentValue;
    }

    return data;
}

function _updateChartDOM(chartData: ChartDataPoint[]) {
    // Usa elementos do cache para evitar consultas repetidas ao DOM.
    const { chartSvg, areaPath, linePath, evolutionIndicator, axisStart, axisEnd, chartWrapper } = chartElements;
    if (!chartSvg || !areaPath || !linePath || !evolutionIndicator || !axisStart || !axisEnd || !chartWrapper) return;


    const firstDate = parseUTCIsoDate(chartData[0].date);
    const lastDate = parseUTCIsoDate(chartData[chartData.length - 1].date);
    const formatDate = (date: Date) => date.toLocaleDateString(state.activeLanguageCode, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    
    // Recalcula escalas e caminhos com base nos novos dados e no tamanho do contêiner.
    const svgWidth = ui.chartContainer.clientWidth;
    const svgHeight = 100;
    const padding = { top: 10, right: 10, bottom: 10, left: 10 };
    const chartWidth = svgWidth - padding.left - padding.right;
    const chartHeight = svgHeight - padding.top - padding.bottom;
    
    chartSvg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);

    const values = chartData.map(d => d.value);
    const minVal = Math.min(...values) * 0.98;
    const maxVal = Math.max(...values) * 1.02;
    const valueRange = maxVal - minVal;
    
    // PERFORMANCE [2025-01-15]: Atualiza o cache de metadados para uso nos listeners
    chartMetadata = { minVal, maxVal, valueRange: valueRange > 0 ? valueRange : 1 };

    const xScale = (index: number) => padding.left + (index / (chartData.length - 1)) * chartWidth;
    const yScale = (value: number) => padding.top + chartHeight - ((value - minVal) / chartMetadata.valueRange) * chartHeight;

    const pathData = chartData.map((point, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(point.value)}`).join(' ');
    const areaPathData = `${pathData} V ${yScale(minVal)} L ${xScale(0)} ${yScale(minVal)} Z`;

    areaPath.setAttribute('d', areaPathData);
    linePath.setAttribute('d', pathData);

    axisStart.textContent = formatDate(firstDate);
    axisEnd.textContent = formatDate(lastDate);

    // Atualiza o indicador de evolução.
    const lastPoint = chartData[chartData.length - 1];
    const referencePoint = chartData.find(d => d.scheduledCount > 0) || chartData[0];
    const evolution = ((lastPoint.value - referencePoint.value) / referencePoint.value) * 100;
    const evolutionString = `${evolution > 0 ? '+' : ''}${evolution.toFixed(1)}%`;
    const referenceDate = parseUTCIsoDate(referencePoint.date).toLocaleDateString(state.activeLanguageCode, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    
    evolutionIndicator.className = `chart-evolution-indicator ${evolution >= 0 ? 'positive' : 'negative'}`;
    evolutionIndicator.title = t('chartEvolutionSince', { date: referenceDate });
    evolutionIndicator.textContent = evolutionString;
    
    const lastPointX = xScale(chartData.length - 1);
    const lastPointY = yScale(lastPoint.value);
    evolutionIndicator.style.top = `${lastPointY}px`;
    let indicatorX = lastPointX + 10;
    if (indicatorX + evolutionIndicator.offsetWidth > chartWrapper.offsetWidth) {
        indicatorX = lastPointX - evolutionIndicator.offsetWidth - 10;
    }
    evolutionIndicator.style.left = `${indicatorX}px`;
}


function _setupChartListeners() {
    // Usa elementos do cache para evitar consultas repetidas ao DOM.
    const { chartWrapper, tooltip, indicator } = chartElements;
    if (!chartWrapper || !tooltip || !indicator) return;

    const handlePointerMove = (e: PointerEvent) => {
        if (lastChartData.length === 0) return;

        // Recalcula escalas dentro do handler para responder a redimensionamentos.
        const svgWidth = ui.chartContainer.clientWidth;
        const padding = { top: 10, right: 10, bottom: 10, left: 10 };
        const chartWidth = svgWidth - padding.left - padding.right;
        const chartHeight = 100 - padding.top - padding.bottom;

        const rect = chartWrapper.getBoundingClientRect();
        const x = e.clientX - rect.left;
        
        const index = Math.round((x - padding.left) / chartWidth * (lastChartData.length - 1));
        const pointIndex = Math.max(0, Math.min(lastChartData.length - 1, index));

        const point = lastChartData[pointIndex];
        if (!point) return;

        // PERFORMANCE [2025-01-15]: Utiliza os metadados calculados previamente em _updateChartDOM
        // em vez de recalcular min/max/range a cada movimento do mouse (60fps).
        const { minVal, valueRange } = chartMetadata;
       
        const xScale = (idx: number) => padding.left + (idx / (lastChartData.length - 1)) * chartWidth;
        const yScale = (val: number) => padding.top + chartHeight - ((val - minVal) / valueRange) * chartHeight;

        const pointX = xScale(pointIndex);
        const pointY = yScale(point.value);

        indicator.style.opacity = '1';
        indicator.style.transform = `translateX(${pointX}px)`;
        const dot = indicator.querySelector<HTMLElement>('.chart-indicator-dot')!;
        dot.style.top = `${pointY}px`;
        
        const date = parseUTCIsoDate(point.date).toLocaleDateString(state.activeLanguageCode, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
        
        tooltip.innerHTML = `
            <div class="tooltip-date">${date}</div>
            <div class="tooltip-score">
                ${t('chartTooltipScore')}: 
                <span class="tooltip-score-value">${point.value.toFixed(2)}</span>
            </div>
            <ul class="tooltip-habits">
                <li>${t('chartTooltipCompleted', { completed: point.completedCount, total: point.scheduledCount })}</li>
            </ul>
        `;

        tooltip.classList.add('visible');
        const tooltipWidth = tooltip.offsetWidth;
        let tooltipX = pointX - (tooltipWidth / 2);
        if (tooltipX < 0) tooltipX = 5;
        if (tooltipX + tooltipWidth > svgWidth) tooltipX = svgWidth - tooltipWidth - 5;
        
        tooltip.style.transform = `translate(${tooltipX}px, ${pointY - tooltip.offsetHeight - 20}px)`;
    };

    const handlePointerLeave = () => {
        tooltip.classList.remove('visible');
        indicator.style.opacity = '0';
    };

    chartWrapper.addEventListener('pointermove', handlePointerMove);
    chartWrapper.addEventListener('pointerleave', handlePointerLeave);
}

export function renderChart() {
    lastChartData = calculateChartData();
    const isEmpty = lastChartData.length < 2 || lastChartData.every(d => d.scheduledCount === 0);

    // REFINAMENTO DE UI [2024-11-25]: O cabeçalho do gráfico foi reestruturado para exibir o nome da aplicação como título principal e o título original como subtítulo, melhorando a identidade da marca na seção de dados.
    if (isEmpty) {
        ui.chartContainer.innerHTML = `
            <div class="chart-header">
                <div class="chart-title-group">
                    <h3 class="chart-title">${t('appName')}</h3>
                    <p class="chart-subtitle">${t('chartTitle')}</p>
                </div>
            </div>
            <div class="chart-empty-state">${t('chartEmptyState')}</div>
        `;
        chartInitialized = false;
        chartElements = {}; // Limpa o cache de elementos do DOM
        return;
    }

    if (!chartInitialized) {
        ui.chartContainer.innerHTML = `
            <div class="chart-header">
                <div class="chart-title-group">
                    <h3 class="chart-title">${t('appName')}</h3>
                    <p class="chart-subtitle">${t('chartTitle')}</p>
                </div>
            </div>
            <div class="chart-wrapper">
                <svg class="chart-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <defs>
                        <linearGradient id="chart-gradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stop-color="var(--accent-blue)" stop-opacity="0.3"/>
                            <stop offset="100%" stop-color="var(--accent-blue)" stop-opacity="0"/>
                        </linearGradient>
                    </defs>
                    <path class="chart-area"></path>
                    <path class="chart-line"></path>
                </svg>
                <div class="chart-tooltip"></div>
                <div class="chart-indicator">
                    <div class="chart-indicator-dot"></div>
                </div>
                <div class="chart-evolution-indicator"></div>
            </div>
            <div class="chart-axis-labels">
                <span></span>
                <span></span>
            </div>
        `;
        
        // OTIMIZAÇÃO: Armazena em cache os elementos internos do gráfico após criá-los.
        chartElements = {
            chartSvg: ui.chartContainer.querySelector<SVGSVGElement>('.chart-svg')!,
            areaPath: ui.chartContainer.querySelector<SVGPathElement>('.chart-area')!,
            linePath: ui.chartContainer.querySelector<SVGPathElement>('.chart-line')!,
            evolutionIndicator: ui.chartContainer.querySelector<HTMLElement>('.chart-evolution-indicator')!,
            axisStart: ui.chartContainer.querySelector<HTMLElement>('.chart-axis-labels span:first-child')!,
            axisEnd: ui.chartContainer.querySelector<HTMLElement>('.chart-axis-labels span:last-child')!,
            chartWrapper: ui.chartContainer.querySelector<HTMLElement>('.chart-wrapper')!,
            tooltip: ui.chartContainer.querySelector<HTMLElement>('.chart-tooltip')!,
            indicator: ui.chartContainer.querySelector<HTMLElement>('.chart-indicator')!,
        };

        _setupChartListeners();
        chartInitialized = true;
    } else {
        // Atualiza os títulos caso já existam (ex: mudança de idioma)
        const titleEl = ui.chartContainer.querySelector<HTMLElement>('.chart-title');
        const subtitleEl = ui.chartContainer.querySelector<HTMLElement>('.chart-subtitle');
        if (titleEl) {
            titleEl.innerHTML = t('appName');
        }
        if (subtitleEl) {
            subtitleEl.textContent = t('chartTitle');
        }
    }

    _updateChartDOM(lastChartData);
}