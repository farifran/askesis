/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { ui } from './ui';
import { t } from './i18n';
import { getSyncKeyHash } from './sync';
import { state, saveState, TimeOfDay } from './state';
import { showInlineNotice } from './render';

// Esta chave pública VAPID deve ser armazenada como uma variável de ambiente em um aplicativo do mundo real.
// É usada pelo serviço de push para autenticar o servidor de aplicativos.
// Corresponde a uma chave privada que o servidor usaria para assinar as mensagens de push.
const VAPID_PUBLIC_KEY = 'BE6i9mJ-s2c51iZJSCd1rUp0waFIG2ih3t1fS4I-sZNe6TPm16KCHzSj0-fX95Jk02-gaaU7wz6e42Kta_pG1-A';

let isSubscribed = false;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/-/g, '+')
        .replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

const getApiUrl = (endpoint: string): string => {
    return new URL(endpoint, window.location.origin).toString();
};

async function sendSubscriptionToBackend(subscription: PushSubscription) {
    const keyHash = await getSyncKeyHash();
    if (!keyHash) {
        console.error("Não é possível salvar a inscrição de push sem uma chave de sincronização.");
        return;
    }
    try {
        const payload = {
            subscription,
            lang: state.activeLanguageCode,
        };
        await fetch(getApiUrl('/api/subscribe'), {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: {
                'Content-Type': 'application/json',
                'X-Sync-Key-Hash': keyHash,
            },
        });
    } catch (error) {
        console.error('Erro ao enviar inscrição para o backend:', error);
    }
}

async function removeSubscriptionFromBackend(subscription: PushSubscription) {
    const keyHash = await getSyncKeyHash();
    if (!keyHash) {
        console.error("Não é possível remover a inscrição de push sem uma chave de sincronização.");
        return;
    }
    try {
        await fetch(getApiUrl('/api/unsubscribe'), {
            method: 'POST',
            body: JSON.stringify({ endpoint: subscription.endpoint }),
            headers: {
                'Content-Type': 'application/json',
                'X-Sync-Key-Hash': keyHash,
            },
        });
    } catch (error) {
        console.error('Erro ao remover inscrição do backend:', error);
    }
}

async function sendSchedulesToBackend() {
    const keyHash = await getSyncKeyHash();
    if (!keyHash) {
        console.warn("Não há chave de sincronização. Agendamentos de notificação não serão salvos no backend.");
        return;
    }
    
    try {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const payload = {
            schedules: state.notificationSchedules,
            timezone: timezone,
        };
        
        // Esta API será criada na próxima etapa. Por enquanto, estamos preparando o cliente.
        const response = await fetch(getApiUrl('/api/schedules'), {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: {
                'Content-Type': 'application/json',
                'X-Sync-Key-Hash': keyHash,
            },
        });
        
        if (!response.ok) {
            console.error('Falha ao enviar agendamentos para o backend:', response.statusText);
        }
    } catch (error) {
        console.error('Erro ao enviar agendamentos para o backend:', error);
    }
}


async function subscribeUser() {
    try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
        await sendSubscriptionToBackend(subscription);
        isSubscribed = true;
        updateUI();
        // Sincroniza os agendamentos atuais (mesmo que vazios) quando o usuário se inscreve.
        await sendSchedulesToBackend();
    } catch (err) {
        console.error('Falha ao inscrever o usuário: ', err);
        showInlineNotice(ui.notificationsFeedback, t('notificationSubscribeError'));
        // Reverte o estado do toggle se a inscrição falhar
        isSubscribed = false;
        updateUI();
    }
}

async function unsubscribeUser() {
    try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
            await removeSubscriptionFromBackend(subscription);
            await subscription.unsubscribe();
        }
        isSubscribed = false;
        updateUI();
        // Limpa os agendamentos no backend quando o usuário cancela a inscrição.
        state.notificationSchedules = [];
        saveState();
        await sendSchedulesToBackend();
    } catch (err) {
        console.error('Erro ao cancelar a inscrição do usuário: ', err);
        showInlineNotice(ui.notificationsFeedback, t('notificationUnsubscribeError'));
    }
}

function updateUI() {
    // 1. Determina o estado geral das notificações
    let statusKey: 'unsupported_insecure' | 'unsupported_api' | 'blocked' | 'granted' | 'default' = 'default';
    let isEnabled = false;

    if (!window.isSecureContext) {
        statusKey = 'unsupported_insecure';
    } else if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        statusKey = 'unsupported_api';
    } else if (window.Notification.permission === 'denied') {
        statusKey = 'blocked';
    } else {
        isEnabled = true;
        if (isSubscribed) {
            statusKey = 'granted';
        }
    }

    // 2. Mapeia o estado para as chaves de tradução
    const statusTextMap = {
        unsupported_insecure: t('notificationsStatusInsecureContext'),
        unsupported_api: t('notificationsStatusUnsupported'),
        blocked: t('notificationsStatusBlocked'),
        granted: t('notificationsStatusGranted'),
        default: t('notificationsStatusDefault'),
    };

    // 3. Atualiza a UI com base no estado
    ui.notificationsStatus.textContent = statusTextMap[statusKey];
    ui.notificationsToggle.disabled = !isEnabled;
    ui.notificationsToggle.checked = isSubscribed;
    ui.notificationScheduleOptions.classList.toggle('visible', isSubscribed && isEnabled);

    // 4. Sincroniza os checkboxes (sempre, para refletir o estado)
    ui.notificationScheduleMorning.checked = state.notificationSchedules.includes('Manhã');
    ui.notificationScheduleAfternoon.checked = state.notificationSchedules.includes('Tarde');
    ui.notificationScheduleEvening.checked = state.notificationSchedules.includes('Noite');

    // 5. Mostra ou esconde a mensagem de detalhes para o estado de "não suportado"
    const detailsEl = document.getElementById('notifications-unsupported-details');
    const detailsTextEl = document.getElementById('notifications-unsupported-text');

    if (isEnabled || !detailsEl || !detailsTextEl) {
        if (detailsEl) detailsEl.style.display = 'none';
    } else {
        let detailsKey = '';
        if (statusKey === 'unsupported_insecure') {
            detailsKey = 'notificationsUnsupportedInsecureBody';
        } else if (statusKey === 'unsupported_api') {
            detailsKey = 'notificationsUnsupportedApiBody';
        } else if (statusKey === 'blocked') {
            detailsKey = 'notificationsUnsupportedBlockedBody';
        }

        if (detailsKey) {
            detailsTextEl.innerHTML = t(detailsKey); // Usa innerHTML porque as traduções podem conter links/tags
            detailsEl.style.display = 'block';
        } else {
            detailsEl.style.display = 'none';
        }
    }
}

async function handleScheduleChange() {
    const schedules: TimeOfDay[] = [];
    if (ui.notificationScheduleMorning.checked) schedules.push('Manhã');
    if (ui.notificationScheduleAfternoon.checked) schedules.push('Tarde');
    if (ui.notificationScheduleEvening.checked) schedules.push('Noite');
    
    state.notificationSchedules = schedules;
    saveState();
    await sendSchedulesToBackend();
}


export async function handleNotificationToggle() {
    // A lógica de verificação agora está centralizada em updateUI, então aqui apenas lidamos com a ação.
    if (ui.notificationsToggle.disabled) {
        return;
    }

    if (isSubscribed) {
        await unsubscribeUser();
    } else {
        const permission = await window.Notification.requestPermission();
        if (permission === 'granted') {
            await subscribeUser();
        } else {
            // Se a permissão não foi concedida, garante que a UI reflita isso.
            isSubscribed = false;
            updateUI();
        }
    }
}

export async function initNotifications() {
    // A lógica de detecção de recursos e registro agora vive aqui,
    // e o resultado (isSubscribed) é usado por updateUI.
    if (window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window) {
        try {
            // Usar um caminho absoluto para o service worker é mais robusto.
            const registration = await navigator.serviceWorker.register('/service-worker.js');
            const subscription = await registration.pushManager.getSubscription();
            isSubscribed = (subscription !== null);
        } catch (error) {
            console.error('Falha ao registrar o Service Worker:', error);
            isSubscribed = false; // Garante que o estado esteja correto em caso de falha
        }
    } else {
        isSubscribed = false; // Não pode estar inscrito se os recursos não estiverem disponíveis
    }
    
    // Adiciona listeners para os checkboxes de agendamento
    ui.notificationScheduleMorning.addEventListener('change', handleScheduleChange);
    ui.notificationScheduleAfternoon.addEventListener('change', handleScheduleChange);
    ui.notificationScheduleEvening.addEventListener('change', handleScheduleChange);

    updateUI(); // Chama updateUI, que agora contém toda a lógica de exibição.
}