import { AI_THEMES } from '../data/aiThemes';
const SCORE_FIELDS = [
    'locus_of_control_score',
    'cognitive_distancing_score',
    'habit_integration_score',
    'philosophical_granularity_score',
    'resilience_syntax_score'
] as const;

export const QUOTE_ANALYSIS_SCHEMA = {
    type: 'object',
    properties: {
        analysis: {
            type: 'object',
            properties: {
                ...Object.fromEntries(SCORE_FIELDS.map(f => [f, { type: 'integer' }])),
                determined_level: { type: 'integer' }
            },
            required: [...SCORE_FIELDS, 'determined_level'],
            propertyOrdering: [...SCORE_FIELDS, 'determined_level']
        },
        relevant_themes: {
            type: 'array',
            maxItems: 3,
            items: { type: 'string', enum: [...AI_THEMES] }
        }
    },
    required: ['analysis', 'relevant_themes'],
    propertyOrdering: ['analysis', 'relevant_themes']
} as const;
