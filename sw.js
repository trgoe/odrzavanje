// ====== SERVICE WORKER — sw.js ======
// Must be served at: https://trgoe.github.io/odrzavanje/sw.js

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

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
    // If you don't have icon.png, you can remove icon/badge lines safely
    icon: data.icon || "/odrzavanje/icon.png",
    badge: data.badge || "/odrzavanje/icon.png",

    // IMPORTANT: unique tag so Chrome shows a NEW popup each time
    tag: data.tag || ("maintenance-" + Date.now()),

    renotify: true,
    requireInteraction: true,
    silent: false,

    data: {
      url: data.url || "/odrzavanje/#maintenance",
    },
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();

  const url = (e.notification && e.notification.data && e.notification.data.url)
    ? e.notification.data.url
    : "/odrzavanje/#maintenance";

  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Focus an existing tab if your app is already open
      for (const client of clientList) {
        if (client.url.includes("/odrzavanje/") && "focus" in client) {
          return client.focus();
        }
      }
      // Otherwise open a new tab
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});
