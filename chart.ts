/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { state, getScheduleForDate, shouldHabitAppearOnDate } from './state';
import { ui } from './ui';
import { t, getHabitDisplayInfo } from './i18n';
import { addDays, parseUTCIsoDate, toUTCIsoDateString } from './utils';

const CHART_DAYS = 30;
const INITIAL_SCORE = 100; // Pontuação inicial para o crescimento composto
const MAX_DAILY_CHANGE_RATE = 0.015; // Mudança máxima de 1.5% por dia

type ChartDataPoint = {
    date: string;
    value: number; // Agora representa a pontuação composta
    completedCount: number;
    scheduledCount: number;
};

function calculateChartData(): ChartDataPoint[] {
    const data: ChartDataPoint[] = [];
    const endDate = parseUTCIsoDate(state.selectedDate);
    const startDate = addDays(endDate, -(CHART_DAYS - 1));

    let previousDayValue = INITIAL_SCORE;

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

        let currentValue: number;
        if (scheduledCount > 0) {
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


export function renderChart() {
    const chartData = calculateChartData();

    if (chartData.length < 2 || chartData.every(d => d.scheduledCount === 0)) {
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
    const minVal = Math.min(...values) * 0.98; // Buffer de 2%
    const maxVal = Math.max(...values) * 1.02; // Buffer de 2%
    const valueRange = maxVal - minVal;

    const xScale = (index: number) => padding.left + (index / (chartData.length - 1)) * chartWidth;
    const yScale = (value: number) => padding.top + chartHeight - ((value - minVal) / (valueRange > 0 ? valueRange : 1)) * chartHeight;

    const lastPoint = chartData[chartData.length - 1];
    let referencePoint = chartData.find(d => d.scheduledCount > 0) || chartData[0];
    
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