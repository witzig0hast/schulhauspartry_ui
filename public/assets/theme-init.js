// Laeuft vor dem Rendern (kein Flackern): Systemeinstellung, optional manuell ueberschrieben.
(function () {
  try {
    var t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* ohne Speicher: Systemeinstellung */ }
})();
