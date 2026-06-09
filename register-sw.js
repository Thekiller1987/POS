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
}
