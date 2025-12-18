

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { state, calculateDaySummary, isChartDataDirty } from '../state';
import { ui } from './ui';
import { t } from '../i18n';
import { addDays, getTodayUTCIso, parseUTCIsoDate, toUTCIsoDateString, getDateTimeFormat } from '../utils';

const CHART_DAYS = 30;
const INITIAL_SCORE = 100;
const MAX_DAILY_CHANGE_RATE = 0.015;

type ChartDataPoint = {
    date: string;
    value: number;
    completedCount: number;
    scheduledCount: number;
};

type ChartScales = {
    xScale: (index: number) => number;
    yScale: (value: number) => number;
};

// Variáveis de estado do módulo
let lastChartData: ChartDataPoint[] = [];

// Cache de metadados para escala (Performance)
let chartMetadata = { minVal: 0, maxVal: 100, valueRange: 100 };

// Cache de geometria do gráfico (Evita Reflow no hot-path)
let cachedChartRect: DOMRect | null = null;

// BUGFIX: Módulo-scoped para permitir reset externo quando os dados mudam
let lastRenderedPointIndex = -1;

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
    // Optimization: Start from beginning and iterate forward with mutable date
    const iteratorDate = addDays(endDate, -(CHART_DAYS - 1));
    const todayISO = getTodayUTCIso();

    let previousDayValue = INITIAL_SCORE;

    for (let i = 0; i < CHART_DAYS; i++) {
        // PERFORMANCE [2025-03-04]: Use shared mutable date object to avoid allocating 30 Dates per render.
        // getActiveHabitsForDate handles strings efficiently via cache.
        const currentDateISO = toUTCIsoDateString(iteratorDate);

        // REFACTOR [2025-03-05]: Use the new calculateDaySummary which returns raw counts.
        // This reuses the logic used for the calendar rings, ensuring consistency and
        // avoiding re-iterating all habits for overlapping days (which is the entire chart).
        const { total: scheduledCount, completed: completedCount, pending: pendingCount } = calculateDaySummary(currentDateISO);

        const hasPending = pendingCount > 0;
        const isToday = currentDateISO === todayISO;
        const isFuture = currentDateISO > todayISO;

        let currentValue: number;
        
        // LÓGICA DE PROJEÇÃO:
        if (isFuture || (isToday && hasPending)) {
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
        
        // Mutate in-place for next iteration
        iteratorDate.setUTCDate(iteratorDate.getUTCDate() + 1);
    }
    return data;
}

function _calculateChartScales(chartData: ChartDataPoint[]): ChartScales {
    const svgWidth = ui.chartContainer.clientWidth;
    const svgHeight = ui.chart.wrapper.clientHeight;
    const padding = { top: 10, right: 10, bottom: 10, left: 10 };
    const chartWidth = svgWidth - padding.left - padding.right;
    const chartHeight = svgHeight - padding.top - padding.bottom;

    ui.chart.svg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);

    const values = chartData.map(d => d.value);
    const minVal = Math.min(...values) * 0.98;
    const maxVal = Math.max(...values) * 1.02;
    const valueRange = maxVal - minVal;
    
    chartMetadata = { minVal, maxVal, valueRange: valueRange > 0 ? valueRange : 1 };

    const xScale = (index: number) => padding.left + (index / (chartData.length - 1)) * chartWidth;
    const yScale = (value: number) => padding.top + chartHeight - ((value - minVal) / chartMetadata.valueRange) * chartHeight;

    return { xScale, yScale };
}

function _generatePathData(chartData: ChartDataPoint[], { xScale, yScale }: ChartScales): { areaPathData: string, linePathData: string } {
    const linePathData = chartData.map((point, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(point.value)}`).join(' ');
    const areaPathData = `${linePathData} V ${yScale(chartMetadata.minVal)} L ${xScale(0)} ${yScale(chartMetadata.minVal)} Z`;
    return { areaPathData, linePathData };
}

function _updateAxisLabels(chartData: ChartDataPoint[]) {
    const { axisStart, axisEnd } = ui.chart;
    const firstDate = parseUTCIsoDate(chartData[0].date);
    const lastDate = parseUTCIsoDate(chartData[chartData.length - 1].date);

    const currentYear = new Date().getUTCFullYear();
    const showYear = firstDate.getUTCFullYear() !== lastDate.getUTCFullYear() || lastDate.getUTCFullYear() !== currentYear;
    
    const axisFormatter = getDateTimeFormat(state.activeLanguageCode, { 
        month: 'short', 
        day: 'numeric', 
        timeZone: 'UTC',
        year: showYear ? '2-digit' : undefined
    });

    axisStart.textContent = axisFormatter.format(firstDate);
    axisEnd.textContent = axisFormatter.format(lastDate);
}

function _updateEvolutionIndicator(chartData: ChartDataPoint[], { xScale, yScale }: ChartScales) {
    const { evolutionIndicator, wrapper } = ui.chart;
    const lastPoint = chartData[chartData.length - 1];
    const referencePoint = chartData.find(d => d.scheduledCount > 0) || chartData[0];
    const evolution = ((lastPoint.value - referencePoint.value) / referencePoint.value) * 100;
    
    evolutionIndicator.className = `chart-evolution-indicator ${evolution >= 0 ? 'positive' : 'negative'}`;
    evolutionIndicator.textContent = `${evolution > 0 ? '+' : ''}${evolution.toFixed(1)}%`;
    
    const lastPointX = xScale(chartData.length - 1);
    evolutionIndicator.style.top = `${yScale(lastPoint.value)}px`;
    
    let indicatorX = lastPointX + 10;
    if (indicatorX + evolutionIndicator.offsetWidth > wrapper.offsetWidth) {
        indicatorX = lastPointX - evolutionIndicator.offsetWidth - 10;
    }
    evolutionIndicator.style.left = `${indicatorX}px`;
}

function _updateChartDOM(chartData: ChartDataPoint[]) {
    const { areaPath, linePath } = ui.chart;
    if (!areaPath || !linePath) return;

    const scales = _calculateChartScales(chartData);
    const { areaPathData, linePathData } = _generatePathData(chartData, scales);
    
    areaPath.setAttribute('d', areaPathData);
    linePath.setAttribute('d', linePathData);
    
    _updateAxisLabels(chartData);
    _updateEvolutionIndicator(chartData, scales);

    cachedChartRect = null;
}

// CORE RENDER LOGIC [2025-02-02]: Extracted for re-use.
function updateTooltipPosition() {
    rafId = null; // Clear flag to allow next frame request
    const { wrapper, tooltip, indicator, tooltipDate, tooltipScoreLabel, tooltipScoreValue, tooltipHabits } = ui.chart;

    if (!wrapper || !tooltip || !indicator || !tooltipDate || !tooltipScoreLabel || !tooltipScoreValue || !tooltipHabits) return;
    if (lastChartData.length === 0 || !wrapper.isConnected) return;

    // LAZY LAYOUT: Only measure the DOM if cache is invalid/null.
    if (!cachedChartRect) {
        cachedChartRect = wrapper.getBoundingClientRect();
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
        const chartHeight = cachedChartRect.height - padding.top - padding.bottom;
    
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
    const { wrapper, tooltip, indicator } = ui.chart;
    if (!wrapper || !tooltip || !indicator) return;

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

    wrapper.addEventListener('pointermove', handlePointerMove);
    wrapper.addEventListener('pointerleave', handlePointerLeave);
    wrapper.addEventListener('pointercancel', handlePointerLeave);
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
            if (!isChartVisible) return;
            // Invalida cache de geometria no resize
            cachedChartRect = null;
            _updateChartDOM(lastChartData);
        });
        resizeObserver.observe(ui.chartContainer);
    }
}

export function initChartInteractions() {
    _setupChartListeners();
    _initObservers();
}

export function renderChart() {
    // FIX: Use isChartDataDirty() function to check if chart data needs recalculation. This function is designed to be called once per render cycle and consumes the dirty flag.
    if (isChartDataDirty() || lastChartData.length === 0) {
        lastChartData = calculateChartData();
        // BUGFIX: Reset rendered index to force tooltip update even if mouse didn't move
        lastRenderedPointIndex = -1; 
    }

    const isEmpty = lastChartData.length < 2 || lastChartData.every(d => d.scheduledCount === 0);
    
    ui.chartContainer.classList.toggle('is-empty', isEmpty);

    if (ui.chart.title) {
        const newTitle = t('appName');
        if (ui.chart.title.innerHTML !== newTitle) {
            ui.chart.title.innerHTML = newTitle;
        }
    }
    if (ui.chart.subtitle) {
        const newSubtitle = t('appSubtitle');
        if (ui.chart.subtitle.textContent !== newSubtitle) {
            ui.chart.subtitle.textContent = newSubtitle;
        }
    }
    
    if (isEmpty) {
        if (ui.chart.emptyState) {
            const newEmptyText = t('chartEmptyState');
            if (ui.chart.emptyState.textContent !== newEmptyText) {
                ui.chart.emptyState.textContent = newEmptyText;
            }
        }
        return;
    }

    if (isChartVisible) {
        _updateChartDOM(lastChartData);
        
        if (ui.chart.tooltip && ui.chart.tooltip.classList.contains('visible')) {
            updateTooltipPosition();
        }
        
        isChartDirty = false;
    } else {
        isChartDirty = true;
    }
}