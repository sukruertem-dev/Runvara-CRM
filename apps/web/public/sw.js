// Web push (MEN-07, docs/p8-plan.md §18). Shows what the push says and opens the notice; caches nothing.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    (async () => {
      // Someone looking at the app already sees the notice there.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (windows.some((c) => c.focused)) return;
      await self.registration.showNotification(typeof data.title === 'string' ? data.title : 'Flexa', {
        body: typeof data.body === 'string' ? data.body : '',
        tag: typeof data.tag === 'string' ? data.tag : undefined,
        icon: '/flexa-symbol.svg',
        data: { url: typeof data.url === 'string' && /^\/n\/[0-9a-f-]{36}$/.test(data.url) ? data.url : '/' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).toString();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows[0];
      if (open) {
        await open.focus();
        if ('navigate' in open) {
          try {
            await open.navigate(url);
            return;
          } catch {
            // A page this worker does not control cannot be navigated: open a new one.
          }
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
