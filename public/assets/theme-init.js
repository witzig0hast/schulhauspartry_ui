// Laeuft vor dem Rendern (kein Flackern): Systemeinstellung, optional manuell ueberschrieben; Animationen laut Admin-Schalter.
(function () {
  var root = document.documentElement;
  try {
    var t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') root.dataset.theme = t;
  } catch (e) { /* ohne Speicher: Systemeinstellung */ }
  var f = (root.dataset.features || '').split(',');
  if (f.indexOf('animations') < 0) root.classList.add('no-anim');
  if (f.indexOf('confetti') < 0) root.classList.add('no-confetti');
})();
