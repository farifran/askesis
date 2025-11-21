






/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Análise completa. Otimização de performance implementada: caching de estatísticas de escala para evitar recálculos pesados no evento de 'pointermove' e hoisting de variáveis invariantes no loop de cálculo de dados.
// UPDATE [2025-01-17]: Adicionado IntersectionObserver para evitar atualizações de DOM quando o gráfico está fora da viewport.
// UPDATE [2025-01-17]: Otimização de pointermove para atualizar o DOM apenas quando o ponto de dados muda (lastPointIndex).
// UPDATE [2025-01-17]: Adicionado ResizeObserver para redimensionamento independente e otimizado (evita recalculo de dados).
// UPDATE [2025-01-18]: Otimização de Memória/CPU com Dirty Flag. Recálculo de dados agora é condicional.
// UPDATE [2025-01-18]: Layout Thrashing Elimination. Tooltip positioning now relies on CSS transforms.
// UPDATE [2025-01-18]: Geometry Caching. Eliminação de getBoundingClientRect no hot-path do pointermove.
// UPDATE [2025-01-21]: Chart Header Refactor. Indicator moved to header flexbox to fix positioning bugs and remove layout thrashing.

import { state } from './state';
import { ui } from './ui';
import { t } from './i18n';
import { addDays, getTodayUTCIso, parseUTCIsoDate, toUTCIsoDateString, getDateTimeFormat } from './utils';
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

// OTIMIZAÇÃO DE GEOMETRIA [2025-01-18]: Cache das dimensões do gráfico.
// Evita chamar getBoundingClientRect() dentro do loop de animação/interação (pointermove),
// o que causaria Reflow Síncrono forçado.
let cachedChartRect: DOMRect | null = null;

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

// LAZY RENDERING [2025-01-17]: Controle de visibilidade para evitar renderização desnecessária.
let isChartVisible = true; // Assume visível inicialmente para garantir o primeiro paint (LCP)
let isChartDirty = false;
let chartObserver: IntersectionObserver | null = null;
let resizeObserver: ResizeObserver | null = null;


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
    // PERFORMANCE [2025-01-16]: Uso de cache para Intl.DateTimeFormat.
    const axisFormatter = getDateTimeFormat(state.activeLanguageCode, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    
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

    axisStart.textContent = axisFormatter.format(firstDate);
    axisEnd.textContent = axisFormatter.format(lastDate);

    // Atualiza o indicador de evolução.
    const lastPoint = chartData[chartData.length - 1];
    const referencePoint = chartData.find(d => d.scheduledCount > 0) || chartData[0];
    const evolution = ((lastPoint.value - referencePoint.value) / referencePoint.value) * 100;
    const evolutionString = `${evolution > 0 ? '+' : ''}${evolution.toFixed(1)}%`;
    const referenceDate = parseUTCIsoDate(referencePoint.date);
    
    evolutionIndicator.className = `chart-evolution-indicator ${evolution >= 0 ? 'positive' : 'negative'}`;
    evolutionIndicator.title = t('chartEvolutionSince', { date: axisFormatter.format(referenceDate) });
    evolutionIndicator.textContent = evolutionString;
    
    // REFACTOR [2025-01-21]: Removido cálculo manual de posição. O indicador agora é um item Flexbox no cabeçalho.
    // Isso elimina layout thrashing (leitura de offsetWidth) e glitches visuais em telas pequenas.
    evolutionIndicator.style.top = '';
    evolutionIndicator.style.left = '';
    
    // Atualiza o cache de geometria sempre que o DOM do gráfico é atualizado
    cachedChartRect = chartWrapper.getBoundingClientRect();
}


function _setupChartListeners() {
    // Usa elementos do cache para evitar consultas repetidas ao DOM.
    const { chartWrapper, tooltip, indicator } = chartElements;
    if (!chartWrapper || !tooltip || !indicator) return;

    // TRACKER [2025-01-17]: Armazena o índice do último ponto destacado para evitar
    // atualizações redundantes do DOM se o mouse se mover dentro da mesma área de dados.
    let lastPointIndex = -1;

    const handlePointerMove = (e: PointerEvent) => {
        if (lastChartData.length === 0) return;
        
        // PERFORMANCE [2025-01-18]: Usa o cache de geometria.
        // Se o cache estiver vazio (casos raros de inicialização), tenta obter.
        if (!cachedChartRect) {
            cachedChartRect = chartWrapper.getBoundingClientRect();
        }

        // OTIMIZAÇÃO: Largura derivada do cache, sem leitura de DOM
        const svgWidth = cachedChartRect.width;
        const padding = { top: 10, right: 10, bottom: 10, left: 10 };
        const chartWidth = svgWidth - padding.left - padding.right;
        
        // Cálculo puramente matemático usando o cache
        const x = e.clientX - cachedChartRect.left;
        
        const index = Math.round((x - padding.left) / chartWidth * (lastChartData.length - 1));
        const pointIndex = Math.max(0, Math.min(lastChartData.length - 1, index));

        // PERFORMANCE [2025-01-17]: Se o ponto de dados focado não mudou, retorna imediatamente.
        // Isso economiza recálculos de layout (offsetWidth/Height) e atualizações de innerHTML.
        if (pointIndex === lastPointIndex) return;
        lastPointIndex = pointIndex;

        const point = lastChartData[pointIndex];
        if (!point) return;

        // PERFORMANCE [2025-01-15]: Utiliza os metadados calculados previamente em _updateChartDOM
        // em vez de recalcular min/max/range a cada movimento do mouse (60fps).
        const { minVal, valueRange } = chartMetadata;
        const chartHeight = 100 - padding.top - padding.bottom;
       
        const xScale = (idx: number) => padding.left + (idx / (lastChartData.length - 1)) * chartWidth;
        const yScale = (val: number) => padding.top + chartHeight - ((val - minVal) / valueRange) * chartHeight;

        const pointX = xScale(pointIndex);
        const pointY = yScale(point.value);

        indicator.style.opacity = '1';
        // A11Y & PERF: Translate em pixels usando template string é performático
        indicator.style.transform = `translateX(${pointX}px)`;
        const dot = indicator.querySelector<HTMLElement>('.chart-indicator-dot')!;
        dot.style.top = `${pointY}px`;
        
        const date = parseUTCIsoDate(point.date);
        // PERFORMANCE [2025-01-16]: Uso de cache para Intl.DateTimeFormat no tooltip.
        const formattedDate = getDateTimeFormat(state.activeLanguageCode, { 
            weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' 
        }).format(date);
        
        tooltip.innerHTML = `
            <div class="tooltip-date">${formattedDate}</div>
            <div class="tooltip-score">
                ${t('chartTooltipScore')}: 
                <span class="tooltip-score-value">${point.value.toFixed(2)}</span>
            </div>
            <ul class="tooltip-habits">
                <li>${t('chartTooltipCompleted', { completed: point.completedCount, total: point.scheduledCount })}</li>
            </ul>
        `;

        tooltip.classList.add('visible');
        
        // PERFORMANCE [2025-01-18]: Eliminação de Layout Thrashing.
        // O posicionamento não lê offsetWidth. Usa transform para centralizar e mover.
        // translate3d força a GPU layer se possível.
        let translateX = '-50%';
        // Heurística simples para bordas baseada na largura cacheada
        if (pointX < 50) translateX = '0%';
        else if (pointX > svgWidth - 50) translateX = '-100%';

        // Zera left/top no CSS e usa apenas transform para movimento.
        tooltip.style.left = '0px';
        tooltip.style.top = '0px';
        tooltip.style.transform = `translate3d(calc(${pointX}px + ${translateX}), calc(${pointY - 20}px - 100%), 0)`;
    };

    const handlePointerLeave = () => {
        tooltip.classList.remove('visible');
        indicator.style.opacity = '0';
        lastPointIndex = -1; // Reseta o rastreador ao sair
    };

    chartWrapper.addEventListener('pointermove', handlePointerMove);
    chartWrapper.addEventListener('pointerleave', handlePointerLeave);
}

function _initIntersectionObserver() {
    if (chartObserver) return;

    chartObserver = new IntersectionObserver((entries) => {
        const entry = entries[0];
        isChartVisible = entry.isIntersecting;

        // Se tornou visível e tinha dados pendentes, renderiza agora.
        if (isChartVisible && isChartDirty) {
            isChartDirty = false;
            _updateChartDOM(lastChartData);
        }
    }, { threshold: 0.1 }); // 10% visível é suficiente

    if (ui.chartContainer) {
        chartObserver.observe(ui.chartContainer);
    }
}

function _initResizeObserver() {
    if (resizeObserver) return;

    // ROBUSTEZ: ResizeObserver permite que o gráfico se adapte a qualquer mudança de tamanho
    // do seu container, seja por redimensionamento da janela ou mudanças no layout da aplicação.
    resizeObserver = new ResizeObserver(entries => {
        if (!chartInitialized || !isChartVisible) return;
        
        // CACHE UPDATE [2025-01-18]: O redimensionamento é o único momento (além da criação)
        // onde precisamos ler as dimensões reais do DOM.
        const entry = entries[0];
        if (entry && entry.contentRect) {
             // ResizeObserverEntry fornece as dimensões, evitando getBoundingClientRect aqui também
             // No entanto, precisamos do 'left' relativo à viewport para o mouse event,
             // então ainda precisamos do getBoundingClientRect do elemento wrapper.
             const wrapper = chartElements.chartWrapper;
             if (wrapper) {
                 cachedChartRect = wrapper.getBoundingClientRect();
             }
        }

        // PERFORMANCE: Chamamos apenas _updateChartDOM, que redesenha o SVG com os dados atuais.
        // Evitamos chamar calculateChartData(), pois os dados históricos não mudam com o tamanho da tela.
        _updateChartDOM(lastChartData);
    });

    if (ui.chartContainer) {
        resizeObserver.observe(ui.chartContainer);
    }
}

export function renderChart() {
    // OTIMIZAÇÃO [2025-01-18]: Se os dados do gráfico não estiverem 'sujos' (chartDataDirty = false)
    // e já tivermos dados calculados, evitamos o cálculo pesado.
    if (state.chartDataDirty || lastChartData.length === 0) {
        lastChartData = calculateChartData();
        state.chartDataDirty = false;
    }

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
        cachedChartRect = null; // Limpa cache de geometria
        if (chartObserver) {
            chartObserver.disconnect();
            chartObserver = null;
        }
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }
        return;
    }

    if (!chartInitialized) {
        // LAYOUT REFACTOR [2025-01-21]: .chart-evolution-indicator movido para dentro de .chart-header.
        // Isso corrige posicionamento e performance.
        ui.chartContainer.innerHTML = `
            <div class="chart-header">
                <div class="chart-title-group">
                    <h3 class="chart-title">${t('appName')}</h3>
                    <p class="chart-subtitle">${t('chartTitle')}</p>
                </div>
                <div class="chart-evolution-indicator"></div>
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
        _initIntersectionObserver();
        _initResizeObserver();
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

    // LAZY RENDERING CHECK
    if (isChartVisible) {
        _updateChartDOM(lastChartData);
        isChartDirty = false;
    } else {
        isChartDirty = true; // Marca para atualização quando ficar visível
    }
}