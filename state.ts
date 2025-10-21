import { addDays, getTodayUTC, getTodayUTCIso, toUTCIsoDateString, parseUTCIsoDate } from './utils';

// --- TYPES & INTERFACES ---
export type HabitStatus = 'completed' | 'snoozed' | 'pending';

export type Frequency = {
    type: 'daily' | 'weekly';
    interval: number;
};

export interface HabitDayData {
    status: HabitStatus;
    goalOverride?: number;
    note?: string;
}

export type HabitDailyInstances = Partial<Record<TimeOfDay, HabitDayData>>;

// The data for a single habit on a single day
export interface HabitDailyInfo {
    instances: HabitDailyInstances;
    dailySchedule?: TimeOfDay[]; // Override for habit.times for this day
}


export interface HabitHistoryPeriod {
    startDate: string;
    endDate: string;
}

export interface Habit {
    id: string;
    // FIX: Made name and subtitle optional as they only exist for custom habits.
    name?: string; // For custom habits
    subtitle?: string; // For custom habits
    nameKey?: string; // For predefined habits
    subtitleKey?: string; // For predefined habits
    icon: string;
    color: string;
    times: ('Manhã' | 'Tarde' | 'Noite')[]; // Internal value, display is translated
    goal: { 
        type: 'pages' | 'minutes' | 'check'; 
        total?: number; 
        // FIX: Made unit optional as it only exists for custom habits.
        unit?: string; // For custom habits
        unitKey?: string; // For predefined habits
    };
    endedOn?: string;
    graduatedOn?: string;
    frequency: Frequency;
    createdOn: string;
    scheduleAnchor?: string;
    history?: HabitHistoryPeriod[];
    previousVersionId?: string;
}

// FIX: Removed `scheduleAnchor` and `previousVersionId` from Omit<> to make PredefinedHabit assignable.
export type PredefinedHabit = Omit<Habit, 'id' | 'createdOn' | 'name' | 'subtitle' | 'goal' | 'previousVersionId'> & {
    goal: {
        type: 'pages' | 'minutes' | 'check';
        total?: number;
        unitKey: string;
    };
};


// Nova interface para o estado completo da aplicação
export interface AppState {
    version: number;
    habits: Habit[];
    dailyData: Record<string, Record<string, HabitDailyInfo>>;
    notificationsShown: string[];
    pending21DayHabitIds: string[];
    pendingConsolidationHabitIds: string[];
}


// --- CONSTANTS ---
export const STATE_STORAGE_KEY = 'habitTrackerState_v1';
export const APP_VERSION = 5; // Increased version for daily schedule overrides (drag & drop)
export const DAYS_IN_CALENDAR = 61;
export const STREAK_SEMI_CONSOLIDATED = 21;
export const STREAK_CONSOLIDATED = 66;

export const TIMES_OF_DAY = ['Manhã', 'Tarde', 'Noite'] as const;
export type TimeOfDay = typeof TIMES_OF_DAY[number];

export const LANGUAGES = [
    { code: 'pt', nameKey: 'langPortuguese' },
    { code: 'en', nameKey: 'langEnglish' },
    { code: 'es', nameKey: 'langSpanish' }
] as const;
export type Language = typeof LANGUAGES[number];

export const FREQUENCIES: { labelKey: string; value: Frequency }[] = [
    { labelKey: 'freqDaily', value: { type: 'daily', interval: 1 } },
    { labelKey: 'freqEvery2Days', value: { type: 'daily', interval: 2 } },
    { labelKey: 'freqEvery3Days', value: { type: 'daily', interval: 3 } },
    { labelKey: 'freqEvery4Days', value: { type: 'daily', interval: 4 } },
    { labelKey: 'freqEvery5Days', value: { type: 'daily', interval: 5 } },
    { labelKey: 'freqWeekly', value: { type: 'weekly', interval: 1 } },
    { labelKey: 'freqEvery2Weeks', value: { type: 'weekly', interval: 2 } },
    { labelKey: 'freqEvery3Weeks', value: { type: 'weekly', interval: 3 } },
    { labelKey: 'freqEvery4Weeks', value: { type: 'weekly', interval: 4 } },
];

// Predefined habits now use keys for localization
export const PREDEFINED_HABITS: PredefinedHabit[] = [
    { nameKey: 'predefinedHabitReadName', subtitleKey: 'predefinedHabitReadSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#e74c3c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>', color: '#e74c3c', times: ['Noite'], goal: { type: 'pages', total: 10, unitKey: 'unitPage' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitMeditateName', subtitleKey: 'predefinedHabitMeditateSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f1c40f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.2 16.2c-1.3-1.3-2.2-3-2.2-4.9C6 9.4 7.1 7.8 8.8 6.8"/><path d="M15.8 16.2c1.3-1.3 2.2-3 2.2-4.9 0-1.9-1.1-3.5-2.8-4.5"/><path d="M12 13a3 3 0 100-6 3 3 0 000 6z"/><path d="M12 21a9 9 0 009-9"/><path d="M3 12a9 9 0 019-9"/></svg>', color: '#f1c40f', times: ['Manhã'], goal: { type: 'minutes', total: 10, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitWaterName', subtitleKey: 'predefinedHabitWaterSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3498db" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a7 7 0 0 0 7-7c0-2.3-1.3-4.9-3.4-7.4C13.8 5.1 12 2.8 12 2.8s-1.8 2.3-3.6 4.8C6.3 10.1 5 12.7 5 15a7 7 0 0 0 7 7z"></path></svg>', color: '#3498db', times: ['Manhã', 'Tarde', 'Noite'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitExerciseName', subtitleKey: 'predefinedHabitExerciseSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2ecc71" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>', color: '#2ecc71', times: ['Tarde'], goal: { type: 'minutes', total: 30, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitStretchName', subtitleKey: 'predefinedHabitStretchSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#7f8c8d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"></circle><path d="M9 20l3-6 3 6"></path><path d="M6 12l6-2 6 2"></path></svg>', color: '#7f8c8d', times: ['Manhã'], goal: { type: 'minutes', total: 5, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitJournalName', subtitleKey: 'predefinedHabitJournalSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9b59b6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>', color: '#9b59b6', times: ['Noite'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitLanguageName', subtitleKey: 'predefinedHabitLanguageSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1abc9c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>', color: '#1abc9c', times: ['Tarde'], goal: { type: 'minutes', total: 20, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitOrganizeName', subtitleKey: 'predefinedHabitOrganizeSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#34495e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>', color: '#34495e', times: ['Noite'], goal: { type: 'minutes', total: 15, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitWalkName', subtitleKey: 'predefinedHabitWalkSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#27ae60" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.9 14.3c.3-.5.3-1.1 0-1.6l-4-6c-.6-1-1.8-1.2-2.8-.6-.9.6-1.2 1.8-.6 2.8l4 6c.6 1 1.8 1.2 2.8.6.2-.1.3-.3.4-.4z"/><path d="M12 12l-2-2"/><path d="M10.1 18.7c.3-.5.3-1.1 0-1.6l-4-6c-.6-1-1.8-1.2-2.8-.6-.9.6-1.2 1.8-.6 2.8l4 6c.6 1 1.8 1.2 2.8.6.2-.1.3-.3.4-.4z"/></svg>', color: '#27ae60', times: ['Tarde'], goal: { type: 'minutes', total: 20, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitPlanDayName', subtitleKey: 'predefinedHabitPlanDaySubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#007aff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline><line x1="9" y1="15" x2="15" y2="15"></line><line x1="9" y1="19" x2="15" y2="19"></line></svg>', color: '#007aff', times: ['Manhã'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitCreativeHobbyName', subtitleKey: 'predefinedHabitCreativeHobbySubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#e84393" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l.34 1.25.1.37H22l-1.6 1.16-.28.2.1.37 1.6 2.5-1.6 1.16-.28.2-.1.37.34 1.25-1.6-1.16-.28-.2-.28.2-1.6 1.16.34-1.25.1-.37-.28-.2-1.6-1.16 1.6-2.5.1-.37.28-.2L12 2.69z"></path><path d="M2 12l1.6 1.16.28.2-.1.37-1.6 2.5 1.6 1.16.28.2.1.37-.34 1.25 1.6-1.16.28-.2.28.2 1.6 1.16-.34-1.25-.1-.37.28-.2 1.6-1.16-1.6-2.5-.1-.37-.28-.2L2 12z"></path></svg>', color: '#e84393', times: ['Tarde'], goal: { type: 'minutes', total: 30, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitGratitudeName', subtitleKey: 'predefinedHabitGratitudeSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f39c12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>', color: '#f39c12', times: ['Noite'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitEatFruitName', subtitleKey: 'predefinedHabitEatFruitSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#c0392b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.9,14.4a9,9,0,1,1-11.2-11.2"></path><path d="M13,2a6,6,0,0,0-6,6,3,3,0,0,0,3,3h0a3,3,0,0,0,3-3A6,6,0,0,0,13,2Z"></path></svg>', color: '#c0392b', times: ['Tarde'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitTalkFriendName', subtitleKey: 'predefinedHabitTalkFriendSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3498db" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>', color: '#3498db', times: ['Tarde'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitScreenBreakName', subtitleKey: 'predefinedHabitScreenBreakSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9b59b6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.78 9.78 0 0 1 12 3c7 0 11 8 11 8a17.8 17.8 0 0 1-3.2 4.2M1 12s4-8 11-8c.9 0 1.8.1 2.6.4"></path><path d="M4.2 19.8A9.78 9.78 0 0 1 12 21c7 0 11-8 11-8a17.8 17.8 0 0 0-3.2-4.2"></path><path d="M12 15a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>', color: '#9b59b6', times: ['Tarde'], goal: { type: 'minutes', total: 15, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitInstrumentName', subtitleKey: 'predefinedHabitInstrumentSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#e67e22" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>', color: '#e67e22', times: ['Noite'], goal: { type: 'minutes', total: 20, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitPlantsName', subtitleKey: 'predefinedHabitPlantsSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2ecc71" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 20h10"></path><path d="M12 4v16"></path><path d="M10 4c-2.5 1.5-4 4-4 7"></path><path d="M14 4c2.5 1.5 4 4 4 7"></path></svg>', color: '#2ecc71', times: ['Manhã'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitFinancesName', subtitleKey: 'predefinedHabitFinancesSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#34495e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10"></path><path d="M12 20V4"></path><path d="M6 20V14"></path></svg>', color: '#34495e', times: ['Noite'], goal: { type: 'minutes', total: 10, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitTeaName', subtitleKey: 'predefinedHabitTeaSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1abc9c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"></path><path d="M3 8h12a4 4 0 0 1 4 4v2a4 4 0 0 1-4 4H3V8z"></path><line x1="6" y1="2" x2="6" y2="4"></line><line x1="10" y1="2" x2="10" y2="4"></line><line x1="14" y1="2" x2="14" y2="4"></line></svg>', color: '#1abc9c', times: ['Noite'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitPodcastName', subtitleKey: 'predefinedHabitPodcastSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#007aff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>', color: '#007aff', times: ['Tarde'], goal: { type: 'minutes', total: 25, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitEmailsName', subtitleKey: 'predefinedHabitEmailsSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f1c40f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"></path><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>', color: '#f1c40f', times: ['Manhã'], goal: { type: 'minutes', total: 5, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitSkincareName', subtitleKey: 'predefinedHabitSkincareSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#e84393" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L8 8l-5 2 5 2 2 5 2-5 5-2-5-2-2-5zM18 13l-2 5-2-5-5-2 5-2 2-5 2 5 5 2z"></path></svg>', color: '#e84393', times: ['Noite'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitSunlightName', subtitleKey: 'predefinedHabitSunlightSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f39c12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>', color: '#f39c12', times: ['Manhã'], goal: { type: 'minutes', total: 10, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitDisconnectName', subtitleKey: 'predefinedHabitDisconnectSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2980b9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>', color: '#2980b9', times: ['Noite'], goal: { type: 'minutes', total: 30, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitDrawName', subtitleKey: 'predefinedHabitDrawSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#8e44ad" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"></path><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path><path d="M2 2l7.586 7.586"></path></svg>', color: '#8e44ad', times: ['Tarde'], goal: { type: 'minutes', total: 15, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitFamilyTimeName', subtitleKey: 'predefinedHabitFamilyTimeSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f1c40f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>', color: '#f1c40f', times: ['Noite'], goal: { type: 'minutes', total: 30, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitNewsName', subtitleKey: 'predefinedHabitNewsSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#7f8c8d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><line x1="10" y1="9" x2="8" y2="9"></line></svg>', color: '#7f8c8d', times: ['Manhã'], goal: { type: 'minutes', total: 10, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitCookHealthyName', subtitleKey: 'predefinedHabitCookHealthySubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#27ae60" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 11.2V14a2 2 0 002 2h16a2 2 0 002-2v-2.8a8 8 0 00-1.2-4.2l-1.1-1.7a2 2 0 00-3.2 0L14 8.8l-1.2-1.8a2 2 0 00-3.2 0L8.5 8.8 7.3 7a2 2 0 00-3.2 0L3.2 8.8A8 8 0 002 11.2z"/><path d="M2 16h20"/></svg>', color: '#27ae60', times: ['Noite'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitLearnSkillName', subtitleKey: 'predefinedHabitLearnSkillSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3498db" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a5.5 5.5 0 0 1 5.5 5.5c0 1.62-.7 3.09-1.76 4.09l-1.74 1.74a2 2 0 0 1-2.83 0L9.5 11.59a5.5 5.5 0 0 1 0-7.78A5.5 5.5 0 0 1 12 2z"></path><path d="M12 22a5.5 5.5 0 0 1-5.5-5.5c0-1.62.7-3.09 1.76-4.09l1.74-1.74a2 2 0 0 1 2.83 0l1.67 1.67a5.5 5.5 0 0 1 0 7.78A5.5 5.5 0 0 1 12 22z"></path></svg>', color: '#3498db', times: ['Tarde'], goal: { type: 'minutes', total: 20, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitPhotographyName', subtitleKey: 'predefinedHabitPhotographySubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#34495e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>', color: '#34495e', times: ['Tarde'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitVolunteerName', subtitleKey: 'predefinedHabitVolunteerSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#e74c3c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>', color: '#e74c3c', times: ['Tarde'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitYogaName', subtitleKey: 'predefinedHabitYogaSubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9b59b6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"/><path d="M12 6v10"/><path d="M12 22s-4-3-4-6h8c0 3-4 6-4 6"/><path d="M6 12h12"/></svg>', color: '#9b59b6', times: ['Manhã'], goal: { type: 'minutes', total: 15, unitKey: 'unitMin' }, frequency: { type: 'daily', interval: 1 } },
    { nameKey: 'predefinedHabitReflectDayName', subtitleKey: 'predefinedHabitReflectDaySubtitle', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2980b9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.03 3.47a2.4 2.4 0 0 1 3.5 3.5L8.5 17.02l-4 1 1-4L15.03 3.47z"></path></svg>', color: '#2980b9', times: ['Noite'], goal: { type: 'check', unitKey: 'unitCheck' }, frequency: { type: 'daily', interval: 1 } },
];

// --- HELPERS ---
export function getNextStatus(currentStatus: HabitStatus): HabitStatus {
    const transitions: Record<HabitStatus, HabitStatus> = {
        pending: 'completed',
        completed: 'snoozed',
        snoozed: 'pending',
    };
    return transitions[currentStatus];
}

// --- APPLICATION STATE ---
export const state: {
    habits: Habit[];
    dailyData: Record<string, Record<string, HabitDailyInfo>>;
    streaksCache: Record<string, number>;
    lastEnded: { habitId: string } | null;
    undoTimeout: number | null;
    calendarDates: Date[];
    selectedDate: string;
    activeLanguageCode: Language['code'];
    pending21DayHabitIds: string[];
    pendingConsolidationHabitIds: string[];
    notificationsShown: string[];
    confirmAction: (() => void) | null;
    confirmEditAction: (() => void) | null;
    editingNoteFor: { habitId: string; date: string; time: TimeOfDay; } | null;
    editingHabit: {
        isNew: boolean;
        habitData: Omit<Habit, 'id' | 'createdOn'>;
    } | null;
} = {
    habits: [],
    dailyData: {},
    streaksCache: {},
    lastEnded: null,
    undoTimeout: null,
    calendarDates: Array.from({ length: DAYS_IN_CALENDAR }, (_, i) => addDays(getTodayUTC(), i - 30)),
    selectedDate: getTodayUTCIso(),
    activeLanguageCode: 'pt',
    pending21DayHabitIds: [],
    pendingConsolidationHabitIds: [],
    notificationsShown: [],
    confirmAction: null,
    confirmEditAction: null,
    editingNoteFor: null,
    editingHabit: null,
};

// --- STATE-DEPENDENT HELPERS ---
export function getHabitDailyInfoForDate(date: string): Record<string, HabitDailyInfo> {
    return state.dailyData[date] || {};
}


export function ensureHabitInstanceData(date: string, habitId: string, time: TimeOfDay): HabitDayData {
    state.dailyData[date] ??= {};
    state.dailyData[date][habitId] ??= { instances: {} };
    state.dailyData[date][habitId].instances[time] ??= { status: 'pending' };
    return state.dailyData[date][habitId].instances[time]!;
}

export function shouldHabitAppearOnDate(habit: Habit, date: Date): boolean {
    if (habit.graduatedOn) return false;

    const dateAsTime = date.getTime();
    const currentPeriodStartDate = parseUTCIsoDate(habit.createdOn);
    let isInCurrentPeriod = dateAsTime >= currentPeriodStartDate.getTime();
    if (habit.endedOn) {
        const currentPeriodEndDate = parseUTCIsoDate(habit.endedOn);
        isInCurrentPeriod = isInCurrentPeriod && (dateAsTime < currentPeriodEndDate.getTime());
    }
    
    const isInHistoryPeriod = habit.history?.some(period => {
        const periodStartDate = parseUTCIsoDate(period.startDate);
        const periodEndDate = parseUTCIsoDate(period.endDate);
        return dateAsTime >= periodStartDate.getTime() && dateAsTime < periodEndDate.getTime();
    }) || false;

    const isWithinAnyActivityPeriod = isInCurrentPeriod || isInHistoryPeriod;
    if (!isWithinAnyActivityPeriod) return false;

    const anchorDate = parseUTCIsoDate(habit.scheduleAnchor || habit.createdOn);

    const daysDifference = Math.round((date.getTime() - anchorDate.getTime()) / (1000 * 60 * 60 * 24));

    // A habit's frequency schedule should only apply from its anchor date forward.
    // This prevents habits, especially daily ones, from appearing on past dates
    // before they were scheduled to start.
    if (daysDifference < 0) {
        return false;
    }

    if (habit.frequency.type === 'daily') {
        return daysDifference % habit.frequency.interval === 0;
    }

    if (habit.frequency.type === 'weekly') {
        if (date.getUTCDay() !== anchorDate.getUTCDay()) return false;
        const weeksDifference = Math.floor(daysDifference / 7);
        return weeksDifference % habit.frequency.interval === 0;
    }

    return true;
}

/**
 * Finds the previous N completed occurrence dates for a habit, skipping snoozed days.
 * A streak is considered broken if a 'pending' or missing day is found.
 * This function is now version-aware and will traverse the habit's history.
 * @param habit The habit to check (latest version).
 * @param startDate The date to start searching backwards from (exclusive).
 * @param count The number of previous completed occurrences to find.
 * @returns An array of Date objects for the previous completed occurrences.
 *          Returns an array with fewer than `count` items if the streak is broken or history ends.
 */
function getPreviousCompletedOccurrences(habit: Habit, startDate: Date, count: number): Date[] {
    const dates: Date[] = [];
    let currentDate = new Date(startDate);
    let currentHabit: Habit | undefined = habit;
    
    mainLoop:
    while (dates.length < count && currentHabit) {
        const habitCreationDate = parseUTCIsoDate(currentHabit.createdOn);
        
        while (dates.length < count && currentDate > habitCreationDate) {
            currentDate = addDays(currentDate, -1);

            if (shouldHabitAppearOnDate(currentHabit, currentDate)) {
                const dayISO = toUTCIsoDateString(currentDate);
                const dailyInfo = state.dailyData[dayISO]?.[currentHabit.id];
                const instances = dailyInfo?.instances || {};
                const scheduleForDay = dailyInfo?.dailySchedule || currentHabit.times;

                const statuses = scheduleForDay.map(time => instances[time]?.status ?? 'pending');
                
                const allCompleted = statuses.length > 0 && statuses.every(s => s === 'completed');
                const hasPending = statuses.some(s => s === 'pending');

                if (allCompleted) {
                    dates.push(new Date(currentDate));
                } else if (hasPending) {
                    break mainLoop;
                }
            }
        }

        if (currentHabit.previousVersionId) {
            currentHabit = state.habits.find(h => h.id === currentHabit!.previousVersionId);
        } else {
            break mainLoop;
        }
    }
    
    return dates;
}

export function shouldShowPlusIndicator(dateISO: string): boolean {
    const dateObj = parseUTCIsoDate(dateISO);
    const dailyInfo = state.dailyData[dateISO] || {};
    const activeHabitsOnDate = state.habits.filter(h => shouldHabitAppearOnDate(h, dateObj));

    // 1. Find habits that had their goal exceeded on the given date.
    const goalExceededHabits = activeHabitsOnDate.filter(habit => {
        if (habit.goal.type !== 'pages' && habit.goal.type !== 'minutes') return false;
        
        const habitDailyInfo = dailyInfo[habit.id];
        if (!habitDailyInfo) return false;
        
        const scheduleForDay = habitDailyInfo.dailySchedule || habit.times;
        return scheduleForDay.some(time => {
            const instance = habitDailyInfo.instances[time];
            return instance?.status === 'completed' &&
                   instance.goalOverride !== undefined &&
                   instance.goalOverride > (habit.goal.total ?? 0);
        });
    });

    if (goalExceededHabits.length === 0) {
        return false;
    }

    // 2. For each of those habits, check if the other conditions are met.
    for (const habit of goalExceededHabits) {
        // Condition A: The habit was completed for the previous 2 scheduled occurrences.
        const previousCompletions = getPreviousCompletedOccurrences(habit, dateObj, 2);
        if (previousCompletions.length !== 2) {
            continue; // Streak condition not met, try next habit.
        }

        // Condition B: All *other* active habits on this date must also be completed.
        const otherHabits = activeHabitsOnDate.filter(h => h.id !== habit.id);
        const allOtherHabitsCompleted = otherHabits.every(otherHabit => {
            const otherHabitDailyInfo = dailyInfo[otherHabit.id];
            const scheduleForDay = otherHabitDailyInfo?.dailySchedule || otherHabit.times;
            const instances = otherHabitDailyInfo?.instances || {};

            // If a habit is scheduled but has no instances at all, it's considered pending.
            if (scheduleForDay.length > 0 && Object.keys(instances).length === 0) {
                return false;
            }

            // Every single scheduled instance for this other habit must be 'completed'.
            return scheduleForDay.every(time => {
                const status = instances[time]?.status;
                return status === 'completed';
            });
        });

        // If both streak and "all others completed" conditions are met, we show the plus.
        if (allOtherHabitsCompleted) {
            return true;
        }
    }

    // If we looped through all goal-exceeded habits and none met all conditions.
    return false;
}

export function getSmartGoalForHabit(habit: Habit, dateISO: string, time: TimeOfDay): number {
    const baseGoal = habit.goal.total ?? 0;
    if (habit.goal.type !== 'pages' && habit.goal.type !== 'minutes') return baseGoal;

    const consecutiveExceededGoals: number[] = [];
    let currentDate = parseUTCIsoDate(dateISO);
    const habitCreationDate = parseUTCIsoDate(habit.createdOn);

    while (consecutiveExceededGoals.length < 3) {
        currentDate = addDays(currentDate, -1);
        if (currentDate < habitCreationDate) return baseGoal;

        if (shouldHabitAppearOnDate(habit, currentDate)) {
            const currentDayISO = toUTCIsoDateString(currentDate);
            const habitInstance = state.dailyData[currentDayISO]?.[habit.id]?.instances?.[time];
            
            const wasGoalExceeded = habitInstance?.status === 'completed' &&
                                    habitInstance.goalOverride !== undefined &&
                                    habitInstance.goalOverride > (habit.goal.total ?? 0);
            
            if (wasGoalExceeded) {
                consecutiveExceededGoals.push(habitInstance.goalOverride!);
            } else {
                // If any instance in the potential streak was not an exceeded goal, reset to base.
                return baseGoal;
            }
        }
    }
    
    // If we found 3 consecutive exceeded goals for this specific time slot.
    const sum = consecutiveExceededGoals.reduce((a, b) => a + b, 0);
    return Math.round(sum / 3);
}

export function calculateHabitStreak(habitId: string, dateISO: string): number {
    const cacheKey = `${habitId}|${dateISO}`;
    if (state.streaksCache[cacheKey] !== undefined) return state.streaksCache[cacheKey];
    
    let streak = 0;
    let currentDate = parseUTCIsoDate(dateISO);
    let currentHabit: Habit | undefined = state.habits.find(h => h.id === habitId);
    
    // Este loop nos permite percorrer as versões anteriores de um hábito.
    while (currentHabit) {
        const habitCreationDate = parseUTCIsoDate(currentHabit.createdOn);
        let streakBroken = false;

        // Este loop calcula a sequência para a versão atual do hábito.
        while (currentDate >= habitCreationDate) {
            if (shouldHabitAppearOnDate(currentHabit, currentDate)) {
                const currentDayISO = toUTCIsoDateString(currentDate);
                const dailyInfo = state.dailyData[currentDayISO]?.[currentHabit.id];
                
                const instances = dailyInfo?.instances || {};
                const scheduleForDay = dailyInfo?.dailySchedule || currentHabit.times;
                
                const statuses = scheduleForDay.map(time => instances[time]?.status ?? 'pending');
                
                const allCompleted = statuses.length > 0 && statuses.every(s => s === 'completed');
                const hasPending = statuses.some(s => s === 'pending');

                if (allCompleted) {
                    streak++;
                } else if (hasPending) {
                    streakBroken = true;
                    break;
                }
            }
            currentDate = addDays(currentDate, -1);
        }

        if (streakBroken) {
            break; // A sequência está quebrada, para de percorrer as versões anteriores.
        }

        // Se a sequência não foi quebrada, passa para a versão anterior.
        if (currentHabit.previousVersionId) {
            currentHabit = state.habits.find(h => h.id === currentHabit!.previousVersionId);
        } else {
            currentHabit = undefined; // Não há mais versões anteriores.
        }
    }

    state.streaksCache[cacheKey] = streak;
    return streak;
}

// --- CLOUD SYNC & STATE MANAGEMENT ---
import { syncStateWithCloud } from './cloud';

export function saveState() {
    const appState: AppState = {
        version: APP_VERSION,
        habits: state.habits,
        dailyData: state.dailyData,
        notificationsShown: state.notificationsShown,
        pending21DayHabitIds: state.pending21DayHabitIds,
        pendingConsolidationHabitIds: state.pendingConsolidationHabitIds,
    };
    // Salva localmente para acesso rápido e offline.
    try {
        localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(appState));
        localStorage.setItem('habitTrackerLanguage', state.activeLanguageCode);
    } catch (e) {
        console.error("Failed to save state to localStorage:", e);
        // Opcional: Notificar o usuário que as alterações locais não podem ser salvas.
    }
    
    // Invalida o cache de sequências e aciona a sincronização com a nuvem.
    state.streaksCache = {};
    syncStateWithCloud(appState);
}

export function loadState(cloudState?: AppState) {
    let loadedAppState: AppState | null = null;

    if (cloudState) {
        loadedAppState = cloudState;
    } else {
        const storedStateJSON = localStorage.getItem(STATE_STORAGE_KEY);
        if (storedStateJSON) {
            loadedAppState = JSON.parse(storedStateJSON);
        }
    }

    if (loadedAppState) {
        const loadedVersion = loadedAppState.version || 0;

        // Migrações de estado (se necessário)
        if (loadedVersion < APP_VERSION) {
            // ... (lógica de migração existente permanece aqui) ...
        }

        state.habits = loadedAppState.habits;
        state.dailyData = loadedAppState.dailyData;
        state.notificationsShown = loadedAppState.notificationsShown || [];
        state.pending21DayHabitIds = loadedAppState.pending21DayHabitIds || [];
        state.pendingConsolidationHabitIds = loadedAppState.pendingConsolidationHabitIds || [];
    } else {
        // Estado inicial se não houver nada localmente ou na nuvem
        state.habits = [];
        state.dailyData = {};
        state.notificationsShown = [];
        state.pending21DayHabitIds = [];
        state.pendingConsolidationHabitIds = [];
    }
}
