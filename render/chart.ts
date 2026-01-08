
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
 * - **SNIPER OPTIMIZATION (Typed OM):** Posicionamento do Tooltip via `attributeStyleMap` para evitar serialização de strings.
 * 
 * DECISÕES TÉCNICAS:
 * 1. **Raw Math vs Abstractions:** Funções de escala (d3-scale style) foram removidas em favor de matemática in-line.
 * 2. **Smi Optimization:** Loops de cálculo usam inteiros e lógica flat.
 * 3. **Curve Smoothing:** Algoritmo Catmull-Rom to Cubic Bezier para renderização orgânica sem custo de CPU.
 */

import { state, isChartDataDirty } from '../state';
import { calculateDaySummary } from '../services/selectors';
import { ui } from './ui';
import { t, formatDate, formatDecimal, formatEvolution } from '../i18n';
import { getTodayUTCIso, parseUTCIsoDate, toUTCIsoDateString, MS_PER_DAY } from '../utils';
import { setTextContent } from './dom';

const CHART_DAYS = 30;
const INITIAL_SCORE = 100;
const MAX_DAILY_CHANGE_RATE = 0.025; 
const PLUS_BONUS_MULTIPLIER = 1.5; 

// VISUAL CONSTANTS
const SVG_HEIGHT = 75; 
const CHART_PADDING = { top: 5, right: 0, bottom: 5, left: 3 }; // Increased top padding for curve overshoot safety

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
// Flat object structure is faster for V8
let chartMinVal = 0;
let chartValueRange = 100;

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

// SNIPER OPTIMIZATION: Feature detection
const hasTypedOM = typeof window !== 'undefined' && !!(window.CSS && window.CSSTranslate && CSS.px);


function calculateChartData(): ChartDataPoint[] {
    try {
        // SOPA OPTIMIZATION [2025-04-22]: Single Mutable Date & Integer Math
        // Instead of creating 30 Date objects, we use one and shift it.
        
        const endDate = parseUTCIsoDate(state.selectedDate);
        // SAFETY GUARD: Check for Invalid Date
        if (isNaN(endDate.getTime())) {
            throw new Error("Invalid selectedDate for chart calculation");
        }

        // OPTIMIZATION: Start date is (EndDate - 29 days).
        let currentTimestamp = endDate.getTime() - ((CHART_DAYS - 1) * MS_PER_DAY);
        
        // Iterator object (reused)
        const iteratorDate = new Date(currentTimestamp);
        
        const todayISO = getTodayUTCIso();
        let previousDayValue = INITIAL_SCORE;

        // PERFORMANCE: Raw Loop over pool.
        // BCE: i < CHART_DAYS (constante 30).
        for (let i = 0; i < CHART_DAYS; i = (i + 1) | 0) {
            iteratorDate.setTime(currentTimestamp);
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
            point.timestamp = currentTimestamp; // Integer timestamp
            point.value = currentValue;
            point.completedCount = completedCount;
            point.scheduledCount = scheduledCount;

            previousDayValue = currentValue;
            
            // Integer Increment
            currentTimestamp += MS_PER_DAY;
        }
        
        return chartDataPool;
    } catch (e) {
        console.error("Critical error in calculateChartData:", e);
        // Fallback: return empty array to trigger empty state in renderChart
        return [];
    }
}

/**
 * Optimized Path Generation with Catmull-Rom Smoothing.
 * Calculates cubic bezier control points on the fly without object allocation.
 */
function _generateChartPaths(chartData: ChartDataPoint[], chartWidthPx: number): { areaPathData: string, linePathData: string } {
    const len = chartData.length;
    if (len === 0) return { areaPathData: '', linePathData: '' };

    // 1. Calculate Bounds (Min/Max) - Raw Loop
    let dataMin = Infinity;
    let dataMax = -Infinity;
    
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
    
    // Update global scale cache for tooltip
    chartMinVal = minVal;
    chartValueRange = valueRange > 0 ? valueRange : 1;

    // 2. Setup ViewBox
    const newViewBox = `0 0 ${chartWidthPx} ${SVG_HEIGHT}`;
    if (ui.chart.svg.getAttribute('viewBox') !== newViewBox) {
        ui.chart.svg.setAttribute('viewBox', newViewBox);
    }

    // 3. Pre-calculate Scale Constants
    const paddingLeft = CHART_PADDING.left;
    const paddingTop = CHART_PADDING.top;
    const chartW = chartWidthPx - paddingLeft - CHART_PADDING.right;
    const chartH = SVG_HEIGHT - paddingTop - CHART_PADDING.bottom;
    
    const xStep = chartW / (len - 1);
    const yFactor = chartH / chartValueRange; 
    const yBase = paddingTop + chartH;

    // Helper macro for coordinate transformation (inlined manually below for speed)
    // getX = (i) => paddingLeft + i * xStep
    // getY = (val) => yBase - ((val - minVal) * yFactor)

    // 4. Generate Smooth Path
    
    const firstVal = chartData[0].value;
    const firstX = paddingLeft;
    const firstY = yBase - ((firstVal - minVal) * yFactor);
    
    let linePathData = 'M ' + firstX + ' ' + firstY;

    // Curve Smoothing Constant (0 = sharp, 1 = very round)
    const k = 0.25; 

    for (let i = 0; i < len - 1; i = (i + 1) | 0) {
        // Point P0 (Previous)
        const p0Val = chartData[i > 0 ? i - 1 : i].value;
        const p0x = paddingLeft + (i > 0 ? i - 1 : i) * xStep;
        const p0y = yBase - ((p0Val - minVal) * yFactor);

        // Point P1 (Current)
        const p1Val = chartData[i].value;
        const p1x = paddingLeft + i * xStep;
        const p1y = yBase - ((p1Val - minVal) * yFactor);

        // Point P2 (Next)
        const p2Val = chartData[i + 1].value;
        const p2x = paddingLeft + (i + 1) * xStep;
        const p2y = yBase - ((p2Val - minVal) * yFactor);

        // Point P3 (Next Next)
        const p3Val = chartData[i + 2 < len ? i + 2 : i + 1].value;
        const p3x = paddingLeft + (i + 2 < len ? i + 2 : i + 1) * xStep;
        const p3y = yBase - ((p3Val - minVal) * yFactor);

        // Catmull-Rom to Cubic Bezier conversion logic
        // CP1 = P1 + (P2 - P0) * k
        const cp1x = p1x + (p2x - p0x) * k;
        const cp1y = p1y + (p2y - p0y) * k;

        // CP2 = P2 - (P3 - P1) * k
        const cp2x = p2x - (p3x - p1x) * k;
        const cp2y = p2y - (p3y - p1y) * k;

        // Append Cubic Bezier command (C cp1x cp1y, cp2x cp2y, x y)
        // Using string concatenation is significantly faster than template literals in loop hot paths
        linePathData += ' C ' + cp1x + ' ' + cp1y + ', ' + cp2x + ' ' + cp2y + ', ' + p2x + ' ' + p2y;
    }

    // Area Path: Close the loop down to the base
    const areaBaseY = yBase - ((minVal - minVal) * yFactor); // Essentially yBase
    // Ensure we close the path correctly relative to the view
    const lastX = paddingLeft + (len - 1) * xStep;
    const areaPathData = linePathData + ' V ' + areaBaseY + ' L ' + firstX + ' ' + areaBaseY + ' Z';
    
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
}

function _updateChartDOM(chartData: ChartDataPoint[]) {
    const { areaPath, linePath } = ui.chart;
    if (!areaPath || !linePath) return;

    // RACE CONDITION GUARD: Se `scheduler.postTask` atrasar o cálculo inicial do gráfico,
    // o ResizeObserver pode disparar este método com o array vazio inicial.
    // Retornamos cedo para evitar crash em chartData[0].timestamp.
    if (!chartData || chartData.length === 0) return;

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

    // Inlined math call
    const { areaPathData, linePathData } = _generateChartPaths(chartData, svgWidth);
    
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

    const paddingLeft = CHART_PADDING.left;
    const chartWidth = svgWidth - paddingLeft - CHART_PADDING.right;
    const len = lastChartData.length;
    
    // PERF: Smi Math & Clamping
    // Uses integer truncation (| 0) instead of Math.round/floor where appropriate
    const x = inputClientX - cachedChartRect.left;
    
    // Normalized position 0..1
    const pos = (x - paddingLeft) / chartWidth;
    
    // Map to index (0..29) with rounding logic (add 0.5 and truncate)
    const rawIndex = (pos * (len - 1) + 0.5) | 0;
    
    // Clamp index
    const pointIndex = rawIndex < 0 ? 0 : (rawIndex >= len ? len - 1 : rawIndex);

    if (pointIndex !== lastRenderedPointIndex) {
        lastRenderedPointIndex = pointIndex;
        
        const point = lastChartData[pointIndex];
        const chartHeight = SVG_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
    
        const pointX = paddingLeft + (pointIndex / (len - 1)) * chartWidth;
        const pointY = CHART_PADDING.top + chartHeight - ((point.value - chartMinVal) / chartValueRange) * chartHeight;

        // SNIPER OPTIMIZATION: Typed OM for Indicator (Fast Path)
        if (hasTypedOM && indicator.attributeStyleMap) {
            indicator.style.opacity = '1';
            // TranslateX only
            indicator.attributeStyleMap.set('transform', new CSSTranslate(CSS.px(pointX), CSS.px(0)));
        } else {
            indicator.style.opacity = '1';
            indicator.style.transform = `translateX(${pointX}px)`;
        }

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

        // SNIPER OPTIMIZATION: Tooltip positioning
        // We use standard style.transform for the tooltip because Typed OM doesn't support complex 'calc()' strings 
        // natively without verbose object construction, which outweighs the performance benefit here.
        tooltip.style.transform = `translate3d(calc(${pointX}px + ${translateX}), calc(${SVG_HEIGHT / 2}px - 50%), 0)`;
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
    // SHIELD: Wrap critical render logic in Try-Catch to prevent main thread crash.
    try {
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
    } catch (e) {
        console.error("Failed to render chart:", e);
        // Fallback safely to empty state
        ui.chartContainer.classList.add('is-empty');
    }
}
