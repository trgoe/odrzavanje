// ====== SERVICE WORKER — sw.js ======
// Place this file in the ROOT of your GitHub Pages repo (same folder as index.html)

self.addEventListener("install", (e) => {
  self.skipWaiting();
});


self.addEventListener("activate", (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener("push", (e) => {
  const data = e.data ? e.data.json() : {};
  const title = data.title || "Maintenance Alert";
  const options = {
    body: data.body || "New maintenance request",
    icon: data.icon || "/icon.png",
    badge: data.badge || "/icon.png",
    tag: data.tag || "maintenance",
    renotify: true,
    requireInteraction: true,
    data: { url: data.url || "/" },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/";
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(url) && "focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
