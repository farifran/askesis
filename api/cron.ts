/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { kv } from '@vercel/kv';
import webpush, { PushSubscription } from 'web-push';
import { TimeOfDay } from '../state';

export const config = {
  runtime: 'edge',
};

interface ScheduleData {
    schedules: TimeOfDay[];
    timezone: string;
}

interface StoredSubscription {
    subscription: PushSubscription;
    lang: 'pt' | 'en' | 'es';
}

// Configura o web-push com as chaves VAPID (devem ser variáveis de ambiente)
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        'mailto:your-email@example.com', // Substitua pelo seu e-mail
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
}

const timeOfDayRanges: Record<TimeOfDay, { start: number, end: number }> = {
    'Manhã': { start: 7, end: 11 },
    'Tarde': { start: 12, end: 17 },
    'Noite': { start: 18, end: 22 },
};

function shouldSendNotification(schedules: TimeOfDay[], timezone: string): boolean {
    try {
        const now = new Date();
        const localTimeString = now.toLocaleString('en-US', { timeZone: timezone, hour: '2-digit', hour12: false });
        const localHour = parseInt(localTimeString, 10);

        return schedules.some(schedule => {
            const range = timeOfDayRanges[schedule];
            return localHour >= range.start && localHour <= range.end;
        });
    } catch (error) {
        console.error(`Invalid timezone format: ${timezone}`, error);
        return false;
    }
}

const NOTIFICATION_PAYLOADS = {
    'pt': {
        title: 'Seus hábitos esperam por você!',
        body: 'Continue sua jornada de consistência. Pequenos passos, grandes resultados.'
    },
    'en': {
        title: 'Your habits are waiting for you!',
        body: 'Continue your journey of consistency. Small steps, great results.'
    },
    'es': {
        title: '¡Tus hábitos te esperan!',
        body: 'Continúa tu viaje de consistencia. Pequeños pasos, grandes resultados.'
    }
};

async function sendNotification(subscription: PushSubscription, lang: 'pt'|'en'|'es' = 'pt') {
    const payload = JSON.stringify(NOTIFICATION_PAYLOADS[lang] || NOTIFICATION_PAYLOADS['pt']);
    try {
        await webpush.sendNotification(subscription, payload);
    } catch (error: any) {
        if (error.statusCode === 410) {
            // Código 410 (Gone) indica que a inscrição não é mais válida
            console.log(`Subscription gone for endpoint: ${subscription.endpoint}. It should be deleted.`);
            return 'gone';
        } else {
            console.error('Failed to send push notification:', error.body);
            return 'error';
        }
    }
    return 'sent';
}


export default async function handler(req: Request) {
    if (req.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    // Protege o endpoint de cron para que não seja executado por qualquer pessoa
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return new Response('Unauthorized', { status: 401 });
    }
    
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
        console.error("VAPID keys are not configured. Cannot send notifications.");
        return new Response("VAPID keys not configured", { status: 500 });
    }

    console.log("Cron job started: checking for notifications to send.");
    let sentCount = 0;
    let deletedCount = 0;

    try {
        const scheduleKeysIterator = kv.scanIterator({ match: 'schedule:*' });

        for await (const scheduleKey of scheduleKeysIterator) {
            const scheduleData: ScheduleData | null = await kv.get(scheduleKey);
            if (!scheduleData || scheduleData.schedules.length === 0) continue;

            if (shouldSendNotification(scheduleData.schedules, scheduleData.timezone)) {
                const keyHash = scheduleKey.split(':')[1];
                const pushSubKey = `push_sub:${keyHash}`;
                
                const storedSubscriptionData = await kv.get<StoredSubscription>(pushSubKey);
                
                if (storedSubscriptionData && storedSubscriptionData.subscription) {
                    const { subscription, lang } = storedSubscriptionData;
                    const result = await sendNotification(subscription, lang);
                    
                    if (result === 'sent') {
                        sentCount++;
                    } else if (result === 'gone') {
                        // A inscrição é inválida, então a removemos do KV
                        await kv.del(pushSubKey);
                        deletedCount++;
                    }
                }
            }
        }

        const summary = `Cron job finished. Sent: ${sentCount}, Deleted expired: ${deletedCount}.`;
        console.log(summary);
        return new Response(summary, { status: 200 });

    } catch (error) {
        console.error('Error during cron job execution:', error);
        return new Response('Internal Server Error', { status: 500 });
    }
}