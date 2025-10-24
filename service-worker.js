/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

// Service worker para notificações push

self.addEventListener('push', event => {
    try {
        const data = event.data.json();
        const options = {
            body: data.body,
        };
        event.waitUntil(
            self.registration.showNotification(data.title, options)
        );
    } catch (e) {
        console.error('Error handling push event:', e);
        // Exibe uma notificação padrão se os dados estiverem malformados
        event.waitUntil(
            self.registration.showNotification('Nova notificação', {
                body: 'Você tem uma nova atualização do seu rastreador de hábitos.'
            })
        );
    }
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
            if (clientList.length > 0) {
                let client = clientList[0];
                for (let i = 0; i < clientList.length; i++) {
                    if (clientList[i].focused) {
                        client = clientList[i];
                    }
                }
                return client.focus();
            }
            return clients.openWindow('/');
        })
    );
});

// Ignora a espera e ativa novos service workers imediatamente.
self.addEventListener('install', event => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});
