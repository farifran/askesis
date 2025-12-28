
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * @file render/chart.ts
 * @description Motor de Renderização de Gráficos SVG (Evolução de Hábitos).
 * 
 * [MAIN THREAD CONTEXT]:
 * Este módulo roda na thread principal e manipula o DOM (SVG) diretamente.
 * Deve manter 60fps durante interações (tooltip) e minimizar o tempo de bloqueio durante atualizações de dados.
 * 
 * ARQUITETURA (SVG & Geometry Caching):
 * - **Responsabilidade Única:** Visualizar a consistência dos hábitos nos últimos 30 dias (Pontuação Composta).
 * - **Zero Allocations (Render Loop):** Utiliza Object Pooling para os pontos de dados e Memoization 
 *   para evitar recálculos matemáticos se os dados não mudaram.
 * - **Lazy Layout:** Medições de geometria (getBoundingClientRect) são cacheadas e invalidadas apenas no resize,
 *   evitando "Layout Thrashing" durante a interação do mouse.
 * 
 * DECISÕES TÉCNICAS:
 * 1. **SVG vs Canvas:** Optou-se por SVG para garantir nitidez em qualquer resolução (Retina) e acessibilidade.
 * 2. **Smi Optimization:** Loops de cálculo usam inteiros e lógica flat para evitar alocação de objetos temporários.
 */

import { state, isChartDataDirty } from '../state';
import { calculateDaySummary } from '../services/selectors';
import { ui } from './ui';
import { t, formatDate, formatDecimal, formatEvolution } from '../i18n';
import { addDays, getTodayUTCIso, parseUTCIsoDate, toUTCIsoDateString } from '../utils';

const CHART_DAYS = 30;
const INITIAL_SCORE = 100;
const MAX_DAILY_CHANGE_RATE = 0.025; 
const PLUS_BONUS_MULTIPLIER = 1.5; 

// VISUAL CONSTANTS
const SVG_HEIGHT = 45; 
const CHART_PADDING = { top: 5, right: 0, bottom: 5, left: 3 };

// PERFORMANCE [2025-04-13]: Hoisted Intl Options.
const OPTS_AXIS_LABEL_SHORT: Intl.DateTimeFormatOptions = { 
    month: 'short', 
    day: 'numeric', 
    timeZone: 'UTC',
    year: undefined // Default
};

const OPTS_AXIS_LABEL_WITH_YEAR: Intl.DateTimeFormatOptions = { 
    month: 'short', 
    day: 'numeric', 
    timeZone: 'UTC',
    year: '2-digit'
};

const OPTS_TOOLTIP_DATE: Intl.DateTimeFormatOptions = { 
    weekday: 'long', 
    day: 'numeric', 
    month: 'long', 
    timeZone: 'UTC' 
};

type ChartDataPoint = {
    date: string;
    timestamp: number;
    value: number;
    completedCount: number;
    scheduledCount: number;
};

type ChartScales = {
    xScale: (index: number) => number;
    yScale: (value: number) => number;
};

// --- OBJECT POOL (PERFORMANCE) ---
const chartDataPool: ChartDataPoint[] = Array.from({ length: CHART_DAYS }, () => ({
    date: '',
    timestamp: 0,
    value: 0,
    completedCount: 0,
    scheduledCount: 0,
}));
let lastChartData: ChartDataPoint[] = [];

// Cache de metadados para escala (Performance)
let chartMetadata = { minVal: 0, maxVal: 100, valueRange: 100 };

// Cache de geometria do gráfico (Evita Reflow no hot-path)
let cachedChartRect: DOMRect | null = null;
let currentChartWidth = 0;

// MEMOIZATION STATE
let renderedDataRef: ChartDataPoint[] | null = null;
let renderedWidth = 0;

let lastRenderedPointIndex = -1;

// Controle de visibilidade e observadores
let isChartVisible = true;
let isChartDirty = false;
let chartObserver: IntersectionObserver | null = null;
let resizeObserver: ResizeObserver | null = null;

let rafId: number | null = null;
let inputClientX = 0;


function calculateChartData(): ChartDataPoint[] {
    const endDate = parseUTCIsoDate(state.selectedDate);
    // OPTIMIZATION: Start date is (EndDate - 29 days).
    const iteratorDate = addDays(endDate, -(CHART_DAYS - 1));
    const todayISO = getTodayUTCIso();

    let previousDayValue = INITIAL_SCORE;

    // PERFORMANCE: Raw Loop over pool.
    // BCE: i < CHART_DAYS (constante 30).
    for (let i = 0; i < CHART_DAYS; i = (i + 1) | 0) {
        const currentDateISO = toUTCIsoDateString(iteratorDate);
        
        // Pass iteratorDate object to avoid re-parsing inside selectors.
        // calculateDaySummary uses caches efficiently internally.
        const summary = calculateDaySummary(currentDateISO, iteratorDate);
        const scheduledCount = summary.total;
        const completedCount = summary.completed;
        const pendingCount = summary.pending;
        const showPlusIndicator = summary.showPlusIndicator;

        const isToday = currentDateISO === todayISO;
        const isFuture = currentDateISO > todayISO;

        let currentValue: number;
        
        if (isFuture || (isToday && pendingCount > 0)) {
            // Se futuro ou hoje ainda pendente, mantém o score estável (plateau)
            currentValue = previousDayValue;
        } else if (scheduledCount > 0) {
            const completionRatio = completedCount / scheduledCount;
            // Base performance factor: -1.0 (0%) to 1.0 (100%)
            let performanceFactor = (completionRatio - 0.5) * 2;
            
            // Bonus logic
            if (showPlusIndicator) {
                performanceFactor = 1.0 * PLUS_BONUS_MULTIPLIER;
            }

            const dailyChange = performanceFactor * MAX_DAILY_CHANGE_RATE;
            currentValue = previousDayValue * (1 + dailyChange);
        } else {
            // Dias sem hábitos agendados mantêm o score (plateau)
            currentValue = previousDayValue;
        }
        
        // Update POOL directly
        const point = chartDataPool[i];
        point.date = currentDateISO;
        point.timestamp = iteratorDate.getTime();
        point.value = currentValue;
        point.completedCount = completedCount;
        point.scheduledCount = scheduledCount;

        previousDayValue = currentValue;
        
        // Increment Date (Mutable)
        iteratorDate.setUTCDate(iteratorDate.getUTCDate() + 1);
    }
    
    return chartDataPool;
}

function _calculateChartScales(chartData: ChartDataPoint[], chartWidthPx: number): ChartScales {
    const padding = CHART_PADDING;
    const chartWidth = chartWidthPx - padding.left - padding.right;
    const chartHeight = SVG_HEIGHT - padding.top - padding.bottom;

    const newViewBox = `0 0 ${chartWidthPx} ${SVG_HEIGHT}`;
    if (ui.chart.svg.getAttribute('viewBox') !== newViewBox) {
        ui.chart.svg.setAttribute('viewBox', newViewBox);
    }

    // SOPA: Raw Loop for Min/Max
    let dataMin = Infinity;
    let dataMax = -Infinity;
    const len = chartData.length;
    
    for (let i = 0; i < len; i = (i + 1) | 0) {
        const val = chartData[i].value;
        if (val < dataMin) dataMin = val;
        if (val > dataMax) dataMax = val;
    }

    const MIN_VISUAL_AMPLITUDE = 2.0; 
    let spread = dataMax - dataMin;

    if (spread < MIN_VISUAL_AMPLITUDE) {
        const center = (dataMin + dataMax) / 2;
        dataMin = center - (MIN_VISUAL_AMPLITUDE / 2);
        dataMax = center + (MIN_VISUAL_AMPLITUDE / 2);
        spread = MIN_VISUAL_AMPLITUDE;
    }

    const safetyPadding = spread * 0.25;
    
    const minVal = dataMin - safetyPadding;
    const maxVal = dataMax + safetyPadding;

    const valueRange = maxVal - minVal;
    
    chartMetadata = { minVal, maxVal, valueRange: valueRange > 0 ? valueRange : 1 };

    const xScale = (index: number) => padding.left + (index / (len - 1)) * chartWidth;
    const yScale = (value: number) => padding.top + chartHeight - ((value - minVal) / chartMetadata.valueRange) * chartHeight;

    return { xScale, yScale };
}

function _generatePathData(chartData: ChartDataPoint[], { xScale, yScale }: ChartScales): { areaPathData: string, linePathData: string } {
    // PERFORMANCE: Use string concatenation or efficient mapping.
    // Given 30 points, map().join() is optimized enough.
    const linePathData = chartData.map((point, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(point.value)}`).join(' ');
    const areaPathData = `${linePathData} V ${yScale(chartMetadata.minVal)} L ${xScale(0)} ${yScale(chartMetadata.minVal)} Z`;
    return { areaPathData, linePathData };
}

function _updateAxisLabels(chartData: ChartDataPoint[]) {
    const { axisStart, axisEnd } = ui.chart;
    const firstDateMs = chartData[0].timestamp;
    const lastDateMs = chartData[chartData.length - 1].timestamp;

    const currentYear = new Date().getUTCFullYear();
    const firstYear = new Date(firstDateMs).getUTCFullYear();
    const lastYear = new Date(lastDateMs).getUTCFullYear();
    
    const firstLabel = formatDate(firstDateMs, (firstYear !== currentYear) ? OPTS_AXIS_LABEL_WITH_YEAR : OPTS_AXIS_LABEL_SHORT);
    const lastLabel = formatDate(lastDateMs, (lastYear !== currentYear) ? OPTS_AXIS_LABEL_WITH_YEAR : OPTS_AXIS_LABEL_SHORT);

    setTextContent(axisStart, firstLabel);
    setTextContent(axisEnd, lastLabel);
}

function setTextContent(element: HTMLElement, text: string) {
    if (element.textContent !== text) {
        element.textContent = text;
    }
}

function _updateEvolutionIndicator(chartData: ChartDataPoint[]) {
    const { evolutionIndicator } = ui.chart;
    const lastPoint = chartData[chartData.length - 1];
    
    // Logic: Find first point with scheduled habits to compare against, or default to start.
    // Raw Loop search
    let referencePoint = chartData[0];
    const len = chartData.length;
    for (let i = 0; i < len; i = (i + 1) | 0) {
        if (chartData[i].scheduledCount > 0) {
            referencePoint = chartData[i];
            break;
        }
    }

    const evolution = ((lastPoint.value - referencePoint.value) / referencePoint.value) * 100;
    
    const newClass = `chart-evolution-indicator ${evolution >= 0 ? 'positive' : 'negative'}`;
    if (evolutionIndicator.className !== newClass) {
        evolutionIndicator.className = newClass;
    }
    setTextContent(evolutionIndicator, `${evolution > 0 ? '+' : ''}${formatEvolution(evolution)}%`);
    
    evolutionIndicator.style.cssText = ''; // Reset inline styles
}

function _updateChartDOM(chartData: ChartDataPoint[]) {
    const { areaPath, linePath } = ui.chart;
    if (!areaPath || !linePath) return;

    let svgWidth = currentChartWidth;
    
    if (!svgWidth) {
        svgWidth = ui.chart.wrapper.getBoundingClientRect().width;
        if (svgWidth > 0) currentChartWidth = svgWidth;
    }
    
    if (!svgWidth && ui.chartContainer.clientWidth > 0) {
        svgWidth = ui.chartContainer.clientWidth - 32;
    }
    if (!svgWidth) svgWidth = 300;

    // MEMOIZATION CHECK
    if (chartData === renderedDataRef && svgWidth === renderedWidth) {
        return;
    }

    const scales = _calculateChartScales(chartData, svgWidth);
    const { areaPathData, linePathData } = _generatePathData(chartData, scales);
    
    areaPath.setAttribute('d', areaPathData);
    linePath.setAttribute('d', linePathData);
    
    _updateAxisLabels(chartData);
    _updateEvolutionIndicator(chartData);

    renderedDataRef = chartData;
    renderedWidth = svgWidth;
    cachedChartRect = null;
}

function updateTooltipPosition() {
    rafId = null; 
    const { wrapper, tooltip, indicator, tooltipDate, tooltipScoreLabel, tooltipScoreValue, tooltipHabits } = ui.chart;

    if (!wrapper || !tooltip || !indicator || !tooltipDate || !tooltipScoreLabel || !tooltipScoreValue || !tooltipHabits) return;
    if (lastChartData.length === 0 || !wrapper.isConnected) return;

    if (!cachedChartRect) {
        cachedChartRect = wrapper.getBoundingClientRect();
    }

    const svgWidth = cachedChartRect.width;
    if (svgWidth === 0) return;

    const padding = CHART_PADDING;
    const chartWidth = svgWidth - padding.left - padding.right;
    
    const x = inputClientX - cachedChartRect.left;
    const index = Math.round((x - padding.left) / chartWidth * (lastChartData.length - 1));
    const pointIndex = Math.max(0, Math.min(lastChartData.length - 1, index));

    if (pointIndex !== lastRenderedPointIndex) {
        lastRenderedPointIndex = pointIndex;
        
        const point = lastChartData[pointIndex];
        const { minVal, valueRange } = chartMetadata;
        const chartHeight = SVG_HEIGHT - padding.top - padding.bottom;
    
        const pointX = padding.left + (pointIndex / (lastChartData.length - 1)) * chartWidth;
        const pointY = padding.top + chartHeight - ((point.value - minVal) / valueRange) * chartHeight;

        indicator.style.opacity = '1';
        indicator.style.transform = `translateX(${pointX}px)`;
        const dot = indicator.querySelector<HTMLElement>('.chart-indicator-dot');
        if (dot) dot.style.top = `${pointY}px`;
        
        const formattedDate = formatDate(point.timestamp, OPTS_TOOLTIP_DATE);
        
        setTextContent(tooltipDate, formattedDate);
        setTextContent(tooltipScoreLabel, t('chartTooltipScore') + ': ');
        setTextContent(tooltipScoreValue, formatDecimal(point.value));
        setTextContent(tooltipHabits, t('chartTooltipCompleted', { completed: point.completedCount, total: point.scheduledCount }));

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
            currentChartWidth = ui.chart.wrapper.getBoundingClientRect().width;
            
            if (!isChartVisible) return;
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
    if (isChartDataDirty() || lastChartData.some(d => d.date === '')) {
        lastChartData = calculateChartData();
        lastRenderedPointIndex = -1; 
        renderedDataRef = null;
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
        const summary = calculateDaySummary(state.selectedDate);
        const hasCompletedHabits = summary.completed > 0;
        const newSubtitleKey = hasCompletedHabits ? 'chartSubtitleProgress' : 'appSubtitle';
        const newSubtitle = t(newSubtitleKey);

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
