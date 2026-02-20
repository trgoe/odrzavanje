// ====== SERVICE WORKER — sw.js ======
// This file must be at: https://trgoe.github.io/odrzavanje/sw.js

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

// Handle incoming push messages
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch (err) {
    data = {};
  }

  const title = data.title || "Maintenance Alert";

  const options = {
    body: data.body || "New maintenance request",
    // Use paths that match your GitHub Pages subfolder
    icon: data.icon || "/odrzavanje/icon.png",
    badge: data.badge || "/odrzavanje/icon.png",
 tag: data.tag || ("maintenance-" + Date.now()),
renotify: true,
requireInteraction: true,
silent: false,,
    data: {
      url: data.url || "/odrzavanje/#maintenance",
    },
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// Handle notification click
self.addEventListener("notificationclick", (e) => {
  e.notification.close();

  const url = e.notification.data?.url || "/odrzavanje/#maintenance";

  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes("/odrzavanje") && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});
