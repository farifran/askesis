/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { state, getScheduleForDate, shouldHabitAppearOnDate } from './state';
import { ui } from './ui';
import { t, getHabitDisplayInfo } from './i18n';
import { addDays, parseUTCIsoDate, toUTCIsoDateString } from './utils';

const CHART_DAYS = 30;
const INITIAL_SCORE = 100;
const GROWTH_FACTOR_PER_HABIT = 0.02; // 2% de crescimento por hábito
const DECAY_FACTOR = 0.995; // -0.5% de decaimento por dia perdido

type ChartDataPoint = {
    date: string;
    value: number;
    completedCount: number;
    scheduledCount: number;
};

function calculateChartData(): ChartDataPoint[] {
    const data: ChartDataPoint[] = [];
    const endDate = parseUTCIsoDate(state.selectedDate);
    const startDate = addDays(endDate, -(CHART_DAYS - 1));

    let previousDayScore = INITIAL_SCORE;

    for (let i = 0; i < CHART_DAYS; i++) {
        const currentDate = addDays(startDate, i);
        const currentDateISO = toUTCIsoDateString(currentDate);

        const activeHabitsOnDate = state.habits.filter(h => shouldHabitAppearOnDate(h, currentDate) && !h.graduatedOn);
        const dailyInfo = state.dailyData[currentDateISO] || {};

        let scheduledCount = 0;
        let completedCount = 0;

        activeHabitsOnDate.forEach(habit => {
            const habitDailyInfo = dailyInfo[habit.id];
            const activeSchedule = getScheduleForDate(habit, currentDate);
            if (!activeSchedule) return;

            const scheduleForDay = habitDailyInfo?.dailySchedule || activeSchedule.times;
            const instances = habitDailyInfo?.instances || {};

            scheduledCount += scheduleForDay.length;
            scheduleForDay.forEach(time => {
                if (instances[time]?.status === 'completed') {
                    completedCount++;
                }
            });
        });

        let currentScore = previousDayScore;
        if (scheduledCount > 0) {
            if (completedCount > 0) {
                const growthRate = (completedCount / scheduledCount) * GROWTH_FACTOR_PER_HABIT;
                currentScore *= (1 + growthRate);
            } else {
                currentScore *= DECAY_FACTOR;
            }
        }
        
        data.push({
            date: currentDateISO,
            value: currentScore,
            completedCount,
            scheduledCount,
        });

        previousDayScore = currentScore;
    }

    return data;
}


export function renderChart() {
    const chartData = calculateChartData();

    if (chartData.length < 2) {
        ui.chartContainer.innerHTML = `
            <div class="chart-header">
                <h3 class="chart-title">${t('chartTitle')}</h3>
            </div>
            <div class="chart-empty-state">${t('chartEmptyState')}</div>
        `;
        return;
    }
    
    const firstDate = parseUTCIsoDate(chartData[0].date);
    const lastDate = parseUTCIsoDate(chartData[chartData.length - 1].date);
    const formatDate = (date: Date) => date.toLocaleDateString(state.activeLanguageCode, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    
    const svgWidth = ui.chartContainer.clientWidth;
    const svgHeight = 100;
    const padding = { top: 10, right: 10, bottom: 10, left: 10 };
    const chartWidth = svgWidth - padding.left - padding.right;
    const chartHeight = svgHeight - padding.top - padding.bottom;
    
    const values = chartData.map(d => d.value);
    const minVal = Math.min(...values) * 0.98;
    const maxVal = Math.max(...values) * 1.02;

    const xScale = (index: number) => padding.left + (index / (chartData.length - 1)) * chartWidth;
    const yScale = (value: number) => padding.top + chartHeight - ((value - minVal) / (maxVal - minVal)) * chartHeight;

    const lastPoint = chartData[chartData.length - 1];
    let referencePoint = chartData[0];
    
    // FIX: Replace findLastIndex with a manual loop for wider browser compatibility.
    let lastDayWithoutHabitsIndex = -1;
    // Iterate backwards from the second to last element.
    for (let i = chartData.length - 2; i >= 0; i--) {
        if (chartData[i].scheduledCount === 0) {
            lastDayWithoutHabitsIndex = i;
            break;
        }
    }
    if (lastDayWithoutHabitsIndex > -1) {
        referencePoint = chartData[lastDayWithoutHabitsIndex];
    }
    const evolution = ((lastPoint.value - referencePoint.value) / referencePoint.value) * 100;
    const evolutionString = `${evolution > 0 ? '+' : ''}${evolution.toFixed(1)}%`;
    const evolutionClass = evolution >= 0 ? 'positive' : 'negative';
    const referenceDate = parseUTCIsoDate(referencePoint.date).toLocaleDateString(state.activeLanguageCode, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const evolutionTooltip = t('chartEvolutionSince', { date: referenceDate });

    const pathData = chartData.map((point, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(point.value)}`).join(' ');
    const areaPathData = `${pathData} V ${yScale(minVal)} L ${xScale(0)} ${yScale(minVal)} Z`;

    ui.chartContainer.innerHTML = `
        <div class="chart-header">
            <h3 class="chart-title">${t('chartTitle')}</h3>
        </div>
        <div class="chart-wrapper">
            <svg class="chart-svg" viewBox="0 0 ${svgWidth} ${svgHeight}" preserveAspectRatio="none">
                <defs>
                    <linearGradient id="chart-gradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="var(--accent-blue)" stop-opacity="0.3"/>
                        <stop offset="100%" stop-color="var(--accent-blue)" stop-opacity="0"/>
                    </linearGradient>
                </defs>
                <path class="chart-area" d="${areaPathData}"></path>
                <path class="chart-line" d="${pathData}"></path>
            </svg>
            <div class="chart-tooltip"></div>
            <div class="chart-indicator">
                <div class="chart-indicator-dot"></div>
            </div>
            <div class="chart-evolution-indicator ${evolutionClass}" title="${evolutionTooltip}">
                ${evolutionString}
            </div>
        </div>
        <div class="chart-axis-labels">
            <span>${formatDate(firstDate)}</span>
            <span>${formatDate(lastDate)}</span>
        </div>
    `;

    const chartWrapper = ui.chartContainer.querySelector<HTMLElement>('.chart-wrapper')!;
    const tooltip = ui.chartContainer.querySelector<HTMLElement>('.chart-tooltip')!;
    const indicator = ui.chartContainer.querySelector<HTMLElement>('.chart-indicator')!;
    const evolutionIndicator = ui.chartContainer.querySelector<HTMLElement>('.chart-evolution-indicator')!;

    const lastPointX = xScale(chartData.length - 1);
    const lastPointY = yScale(lastPoint.value);
    evolutionIndicator.style.top = `${lastPointY}px`;
    let indicatorX = lastPointX + 10;
    if (indicatorX + evolutionIndicator.offsetWidth > chartWrapper.offsetWidth) {
        indicatorX = lastPointX - evolutionIndicator.offsetWidth - 10;
    }
    evolutionIndicator.style.left = `${indicatorX}px`;

    const handlePointerMove = (e: PointerEvent) => {
        const rect = chartWrapper.getBoundingClientRect();
        const x = e.clientX - rect.left;
        
        const index = Math.round((x - padding.left) / chartWidth * (chartData.length - 1));
        const pointIndex = Math.max(0, Math.min(chartData.length - 1, index));

        const point = chartData[pointIndex];
        if (!point) return;

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
                <span class="tooltip-score-value">${point.value.toFixed(1)}</span>
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