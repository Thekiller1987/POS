if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => {
        console.log('[Service Worker] Registrado con éxito:', reg.scope);
      })
      .catch((err) => {
        console.error('[Service Worker] Error al registrar:', err);
      });
  });

  // Recargar la página automáticamente cuando se activa un nuevo Service Worker
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });
}

