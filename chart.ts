
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
// [ANALYSIS PROGRESS]: 100% - Otimização "Platinum". Migração de "Game Loop" para "Event-Driven Throttling".
// PERFORMANCE [2025-01-30]: True Zero-Cost Idle. O código só executa quando o evento pointermove dispara,
// eliminado completamente o overhead de CPU quando o mouse está parado sobre o gráfico.
// BUGFIX [2025-02-02]: Tooltip Stale Data fix. Ensures tooltip updates immediately when data changes even if mouse is stationary.

import { state } from './state';
import { ui } from './ui';
import { t } from './i18n';
import { addDays, getTodayUTCIso, parseUTCIsoDate, toUTCIsoDateString, getDateTimeFormat } from './utils';
import { getActiveHabitsForDate } from './state';

const CHART_DAYS = 30;
const INITIAL_SCORE = 100;
const MAX_DAILY_CHANGE_RATE = 0.015;

type ChartDataPoint = {
    date: string;
    value: number;
    completedCount: number;
    scheduledCount: number;
};

// Variáveis de estado do módulo
let chartInitialized = false;
let lastChartData: ChartDataPoint[] = [];

// Cache de metadados para escala (Performance)
let chartMetadata = { minVal: 0, maxVal: 100, valueRange: 100 };

// Cache de geometria do gráfico (Evita Reflow no hot-path)
let cachedChartRect: DOMRect | null = null;

// BUGFIX: Módulo-scoped para permitir reset externo quando os dados mudam
let lastRenderedPointIndex = -1;

// Cache de referências DOM (Evita querySelector no hot-path)
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
    // Elementos internos do Tooltip para atualização cirúrgica
    tooltipDate?: HTMLElement;
    tooltipScoreLabel?: HTMLElement;
    tooltipScoreValue?: HTMLElement;
    tooltipHabits?: HTMLElement;
} = {};

// Controle de visibilidade e observadores
let isChartVisible = true;
let isChartDirty = false;
let chartObserver: IntersectionObserver | null = null;
let resizeObserver: ResizeObserver | null = null;

// INTERACTION STATE [2025-02-02]: Hoisted to module scope to allow external re-render triggers.
let rafId: number | null = null;
let inputClientX = 0;


function calculateChartData(): ChartDataPoint[] {
    const data: ChartDataPoint[] = [];
    const endDate = parseUTCIsoDate(state.selectedDate);
    const startDate = addDays(endDate, -(CHART_DAYS - 1));
    const todayISO = getTodayUTCIso();

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
                if (status === 'completed') completedCount++;
                else if (status === 'pending') pendingCount++;
            });
        });

        const hasPending = pendingCount > 0;
        const isToday = currentDateISO === todayISO;

        let currentValue: number;
        // Congela pontuação apenas se houver pendências HOJE. Passado é imutável.
        if (isToday && hasPending) {
            currentValue = previousDayValue;
        } else if (scheduledCount > 0) {
            const completionRatio = completedCount / scheduledCount;
            const performanceFactor = (completionRatio - 0.5) * 2;
            const dailyChange = performanceFactor * MAX_DAILY_CHANGE_RATE;
            currentValue = previousDayValue * (1 + dailyChange);
        } else {
            currentValue = previousDayValue;
        }
        
        data.push({ date: currentDateISO, value: currentValue, completedCount, scheduledCount });
        previousDayValue = currentValue;
    }
    return data;
}

function _updateChartDOM(chartData: ChartDataPoint[]) {
    const { chartSvg, areaPath, linePath, evolutionIndicator, axisStart, axisEnd, chartWrapper } = chartElements;
    if (!chartSvg || !areaPath || !linePath || !evolutionIndicator || !axisStart || !axisEnd || !chartWrapper) return;

    const firstDate = parseUTCIsoDate(chartData[0].date);
    const lastDate = parseUTCIsoDate(chartData[chartData.length - 1].date);
    
    // UX FIX [2025-02-05]: Show year if range spans across different years.
    const startYear = firstDate.getUTCFullYear();
    const endYear = lastDate.getUTCFullYear();
    const showYear = startYear !== endYear;
    
    const axisFormatter = getDateTimeFormat(state.activeLanguageCode, { 
        month: 'short', 
        day: 'numeric', 
        timeZone: 'UTC',
        year: showYear ? '2-digit' : undefined
    });
    
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
    
    chartMetadata = { minVal, maxVal, valueRange: valueRange > 0 ? valueRange : 1 };

    const xScale = (index: number) => padding.left + (index / (chartData.length - 1)) * chartWidth;
    const yScale = (value: number) => padding.top + chartHeight - ((value - minVal) / chartMetadata.valueRange) * chartHeight;

    const pathData = chartData.map((point, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(point.value)}`).join(' ');
    const areaPathData = `${pathData} V ${yScale(minVal)} L ${xScale(0)} ${yScale(minVal)} Z`;

    areaPath.setAttribute('d', areaPathData);
    linePath.setAttribute('d', pathData);

    axisStart.textContent = axisFormatter.format(firstDate);
    axisEnd.textContent = axisFormatter.format(lastDate);

    const lastPoint = chartData[chartData.length - 1];
    const referencePoint = chartData.find(d => d.scheduledCount > 0) || chartData[0];
    const evolution = ((lastPoint.value - referencePoint.value) / referencePoint.value) * 100;
    const evolutionString = `${evolution > 0 ? '+' : ''}${evolution.toFixed(1)}%`;
    
    evolutionIndicator.className = `chart-evolution-indicator ${evolution >= 0 ? 'positive' : 'negative'}`;
    evolutionIndicator.textContent = evolutionString;
    
    const lastPointX = xScale(chartData.length - 1);
    const lastPointY = yScale(lastPoint.value);
    evolutionIndicator.style.top = `${lastPointY}px`;
    
    let indicatorX = lastPointX + 10;
    if (indicatorX + evolutionIndicator.offsetWidth > chartWrapper.offsetWidth) {
        indicatorX = lastPointX - evolutionIndicator.offsetWidth - 10;
    }
    evolutionIndicator.style.left = `${indicatorX}px`;
    
    cachedChartRect = chartWrapper.getBoundingClientRect();
}

// CORE RENDER LOGIC [2025-02-02]: Extracted for re-use.
function updateTooltipPosition() {
    rafId = null; // Clear flag to allow next frame request
    const { chartWrapper, tooltip, indicator, tooltipDate, tooltipScoreLabel, tooltipScoreValue, tooltipHabits } = chartElements;

    if (!chartWrapper || !tooltip || !indicator || !tooltipDate || !tooltipScoreLabel || !tooltipScoreValue || !tooltipHabits) return;
    if (lastChartData.length === 0 || !chartWrapper.isConnected) return;

    if (!cachedChartRect) {
        cachedChartRect = chartWrapper.getBoundingClientRect();
    }

    const svgWidth = cachedChartRect.width;
    if (svgWidth === 0) return;

    const padding = { top: 10, right: 10, bottom: 10, left: 10 };
    const chartWidth = svgWidth - padding.left - padding.right;
    
    // Math optimization: Single calculation path
    const x = inputClientX - cachedChartRect.left;
    const index = Math.round((x - padding.left) / chartWidth * (lastChartData.length - 1));
    const pointIndex = Math.max(0, Math.min(lastChartData.length - 1, index));

    // Dirty Check: Surgical DOM update only on index change
    if (pointIndex !== lastRenderedPointIndex) {
        lastRenderedPointIndex = pointIndex;
        
        const point = lastChartData[pointIndex];
        const { minVal, valueRange } = chartMetadata;
        const chartHeight = 100 - padding.top - padding.bottom;
    
        const pointX = padding.left + (pointIndex / (lastChartData.length - 1)) * chartWidth;
        const pointY = padding.top + chartHeight - ((point.value - minVal) / valueRange) * chartHeight;

        indicator.style.opacity = '1';
        indicator.style.transform = `translateX(${pointX}px)`;
        const dot = indicator.querySelector<HTMLElement>('.chart-indicator-dot');
        if (dot) dot.style.top = `${pointY}px`;
        
        const date = parseUTCIsoDate(point.date);
        const formattedDate = getDateTimeFormat(state.activeLanguageCode, { 
            weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' 
        }).format(date);
        
        tooltipDate.textContent = formattedDate;
        tooltipScoreLabel.textContent = t('chartTooltipScore') + ': ';
        tooltipScoreValue.textContent = point.value.toFixed(2);
        tooltipHabits.textContent = t('chartTooltipCompleted', { completed: point.completedCount, total: point.scheduledCount });

        if (!tooltip.classList.contains('visible')) {
            tooltip.classList.add('visible');
        }
        
        let translateX = '-50%';
        if (pointX < 50) translateX = '0%';
        else if (pointX > svgWidth - 50) translateX = '-100%';

        tooltip.style.transform = `translate3d(calc(${pointX}px + ${translateX}), calc(${pointY - 20}px - 100%), 0)`;
    }
}

function _setupChartListeners() {
    const { chartWrapper, tooltip, indicator } = chartElements;
    if (!chartWrapper || !tooltip || !indicator) return;

    // Handler de Input: Solicita o frame APENAS se um não estiver pendente
    const handlePointerMove = (e: PointerEvent) => {
        inputClientX = e.clientX;
        if (!rafId) {
            rafId = requestAnimationFrame(updateTooltipPosition);
        }
    };

    const handlePointerLeave = () => {
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        tooltip.classList.remove('visible');
        indicator.style.opacity = '0';
        lastRenderedPointIndex = -1;
    };

    chartWrapper.addEventListener('pointermove', handlePointerMove);
    chartWrapper.addEventListener('pointerleave', handlePointerLeave);
    chartWrapper.addEventListener('pointercancel', handlePointerLeave);
}

function _initObservers() {
    if (!ui.chartContainer) return;

    if (!chartObserver) {
        chartObserver = new IntersectionObserver((entries) => {
            const entry = entries[0];
            isChartVisible = entry.isIntersecting;
            if (isChartVisible && isChartDirty) {
                isChartDirty = false;
                _updateChartDOM(lastChartData);
            }
        }, { threshold: 0.1 });
        chartObserver.observe(ui.chartContainer);
    }

    if (!resizeObserver) {
        resizeObserver = new ResizeObserver(entries => {
            if (!chartInitialized || !isChartVisible) return;
            // Invalida cache de geometria no resize
            if (entries[0]?.contentRect && chartElements.chartWrapper) {
                 cachedChartRect = chartElements.chartWrapper.getBoundingClientRect();
            }
            _updateChartDOM(lastChartData);
        });
        resizeObserver.observe(ui.chartContainer);
    }
}

export function renderChart() {
    if (state.chartDataDirty || lastChartData.length === 0) {
        lastChartData = calculateChartData();
        state.chartDataDirty = false;
        // BUGFIX: Reset rendered index to force tooltip update even if mouse didn't move
        lastRenderedPointIndex = -1; 
    }

    const isEmpty = lastChartData.length < 2 || lastChartData.every(d => d.scheduledCount === 0);

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
        chartElements = {};
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
                <svg class="chart-svg" preserveAspectRatio="none"><defs><linearGradient id="chart-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--accent-blue)" stop-opacity="0.3"/><stop offset="100%" stop-color="var(--accent-blue)" stop-opacity="0"/></linearGradient></defs><path class="chart-area"></path><path class="chart-line"></path></svg>
                <div class="chart-tooltip">
                    <div class="tooltip-date"></div>
                    <div class="tooltip-score"><span class="tooltip-score-label"></span><span class="tooltip-score-value"></span></div>
                    <ul class="tooltip-habits"><li class="tooltip-habits-content"></li></ul>
                </div>
                <div class="chart-indicator"><div class="chart-indicator-dot"></div></div>
                <div class="chart-evolution-indicator"></div>
            </div>
            <div class="chart-axis-labels"><span></span><span></span></div>
        `;
        
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
            tooltipDate: ui.chartContainer.querySelector<HTMLElement>('.tooltip-date')!,
            tooltipScoreLabel: ui.chartContainer.querySelector<HTMLElement>('.tooltip-score-label')!,
            tooltipScoreValue: ui.chartContainer.querySelector<HTMLElement>('.tooltip-score-value')!,
            tooltipHabits: ui.chartContainer.querySelector<HTMLElement>('.tooltip-habits-content')!,
        };

        _setupChartListeners();
        _initObservers();
        chartInitialized = true;
    }

    if (isChartVisible) {
        _updateChartDOM(lastChartData);
        
        // REACTIVE TOOLTIP UPDATE [2025-02-02]:
        // If the tooltip is currently visible, force an immediate position/content update.
        // This fixes the issue where checking a habit via keyboard didn't update the tooltip value instantly.
        if (chartElements.tooltip && chartElements.tooltip.classList.contains('visible')) {
            updateTooltipPosition();
        }
        
        isChartDirty = false;
    } else {
        isChartDirty = true;
    }
}
