/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { kv } from '@vercel/kv';
import webpush, { PushSubscription } from 'web-push';

export const config = {
  runtime: 'edge',
};

// This type must be kept in sync with the frontend's state.ts
type TimeOfDay = 'Manhã' | 'Tarde' | 'Noite';

interface ScheduleData {
    schedules: TimeOfDay[];
    timezone: string;
}

interface StoredSubscription {
    subscription: PushSubscription;
    lang: 'pt' | 'en' | 'es';
}

// Configure web-push with VAPID keys (should be environment variables)
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        'mailto:your-email@example.com', // Replace with your email
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
}

const timeOfDayTargetHours: Record<TimeOfDay, number> = {
    'Manhã': 8,  // 8 AM
    'Tarde': 13, // 1 PM
    'Noite': 20, // 8 PM
};

function shouldSendNotification(schedules: TimeOfDay[], timezone: string): boolean {
    try {
        const now = new Date();
        const localTimeString = now.toLocaleString('en-US', { timeZone: timezone, hour: '2-digit', hour12: false });
        const localHour = parseInt(localTimeString, 10);

        // Check if the current local hour matches a scheduled target hour
        return schedules.some(schedule => {
            const targetHour = timeOfDayTargetHours[schedule];
            return localHour === targetHour;
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
            // Code 410 (Gone) means the subscription is no longer valid
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

    // Protect the cron endpoint from being run by anyone
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
                        // The subscription is invalid, so we remove it from KV
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