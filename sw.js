self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(self.clients.claim());
});

// ✅ Real fetch handler (important for some Chromium builds)
self.addEventListener("fetch", function (event) {
  event.respondWith(fetch(event.request));
});

self.addEventListener("push", function (e) {
  var data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch (err) {
    data = {};
  }

  var title = data.title || "Maintenance Alert";
  var options = {
    body: data.body || "New maintenance request",
    tag: data.tag || ("maintenance-" + Date.now()),
    renotify: true,
    requireInteraction: true,
    silent: false,
    data: { url: data.url || "/odrzavanje/#maintenance" }
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();

  var url = (e.notification && e.notification.data && e.notification.data.url)
    ? e.notification.data.url
    : "/odrzavanje/#maintenance";

  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.url.indexOf("/odrzavanje/") !== -1 && c.focus) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
