/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { t } from './i18n';
import { getSyncKeyHash } from './sync';
import { ui } from './ui';

declare global {
    interface Window {
        OneSignal: any;
    }
}

async function syncNotificationUI() {
    const OneSignal = window.OneSignal;
    const permission = await OneSignal.getNotificationPermission();
    const isSubscribed = await OneSignal.isPushNotificationsEnabled();

    if (permission === 'denied') {
        ui.notificationToggle.checked = false;
        ui.notificationToggle.disabled = true;
        ui.notificationStatus.textContent = t('notificationStatusBlocked');
        ui.notificationDetails.innerHTML = t('notificationDetailsBlocked');
        ui.notificationDetails.style.display = 'block';
    } else {
        ui.notificationToggle.disabled = false;
        ui.notificationToggle.checked = isSubscribed;
        ui.notificationStatus.textContent = isSubscribed ? t('notificationStatusActive') : t('notificationStatusInactive');
        ui.notificationDetails.style.display = 'none';
    }
}


export function initNotifications() {
    window.OneSignal = window.OneSignal || [];
    const OneSignal = window.OneSignal;

    OneSignal.push(async () => {
        await OneSignal.init({
            appId: "d4f3b7f1-c22c-42b7-8a4a-5f0e1a1b1c3d",
            promptOptions: {
                slidedown: {
                    enabled: true,
                    actionMessage: t('oneSignalPromptActionMessage'),
                    acceptButtonText: t('oneSignalPromptAcceptButton'),
                    cancelButtonText: t('oneSignalPromptCancelButton'),
                }
            },
            welcomeNotification: {
                "title": t('oneSignalWelcomeTitle'),
                "message": t('oneSignalWelcomeMessage'),
            }
        });

        // Sincroniza a UI com o estado atual assim que o SDK estiver pronto.
        await syncNotificationUI();
        
        // Mantém a UI sincronizada se o estado da assinatura mudar.
        OneSignal.on('subscriptionChange', syncNotificationUI);

        // Adiciona o listener para o interruptor (toggle).
        ui.notificationToggle.addEventListener('change', async () => {
            if (ui.notificationToggle.checked) {
                // Solicita permissão se necessário, ou reativa as notificações.
                await OneSignal.slidedown.promptPush();
            } else {
                // Desativa as notificações sem que o usuário precise revogar a permissão.
                await OneSignal.disablePush(true);
            }
        });
        
        const keyHash = await getSyncKeyHash();
        if (keyHash) {
            OneSignal.login(keyHash);
        }

        document.addEventListener('sync-key-changed', async (event: Event) => {
            const customEvent = event as CustomEvent<{ keyHash: string | null }>;
            const newKeyHash = customEvent.detail.keyHash;
            if (newKeyHash) {
                await OneSignal.login(newKeyHash);
            } else {
                if (await OneSignal.isPushNotificationsEnabled()) {
                    await OneSignal.logout();
                }
            }
        });
    });
}