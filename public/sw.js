// Service worker: menampilkan push notification dan membuka halaman terkait saat diketuk
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let n = {};
  try { n = e.data.json(); } catch { n = { title: 'Kentang Brokoli', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(n.title || 'Kentang Brokoli', {
    body: n.body || '', icon: '/icon-192.png', badge: '/icon-192.png', data: { url: '/' + (n.url || '') }, tag: n.title,
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data && e.notification.data.url || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
