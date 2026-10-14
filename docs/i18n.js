/* Zweisprachige Oberfläche (EN/DE) für die Darmstadt-Live-Karte.
 *
 * Alle Texte liegen hier zentral; index.html/live.js holen sie über data-i18n-Attribute
 * bzw. window.I18N.t('key'). Die Wahl wird in localStorage gemerkt, Vorgabe ist EN.
 */
(function () {
  'use strict';

  const STRINGS = {
    en: {
      appTitle: 'Darmstadt Live Map',
      subtitle: 'Tram, bus and regional rail — from the open realtime feed',
      dataSource: 'Data',
      modeLive: 'Realtime',
      modeSchedule: 'Timetable (simulation)',
      waiting: 'waiting for first data …',
      updatedAgo: 'updated {s} s ago',
      stale: 'stale',
      failedAttempts: '{n} failed attempts',
      heading: 'On the road now',
      trams: 'Trams',
      buses: 'Buses',
      trains: 'Trains',
      showOnMap: 'Show on map',
      togTram: 'Tram',
      togBus: 'Bus',
      togRail: 'Regional rail',
      playPause: 'Play/pause (space)',
      scheduleFor: 'Timetable for',
      weekday: 'Weekday',
      saturday: 'Saturday',
      sunday: 'Sunday',
      tempo: 'Playback speed',
      speedLive: 'Live',
      speedSlow: 'Slow',
      speedMedium: 'Medium',
      speedFast: 'Fast',
      highlightLine: 'Highlight line',
      clear: 'Clear highlight',
      clock: 'Now',
      hint: 'Tap a vehicle for line, delay and next stops',
      attributionLive: 'Realtime: DELFI e.V. (CC BY-SA 4.0) via Transitous/MOTIS',
      attributionSchedule: 'Timetable: DELFI via gtfs.de (CC BY 4.0)',
      loading: 'Loading …',
      bannerUnreachable: 'Realtime data unreachable ({err}) — showing last known positions, retrying.',
      bannerBlip: 'Realtime data: brief interruption, retrying …',
      delayHistogram: 'Delay in minutes (share of vehicles)',
      noData: 'no realtime vehicles in the current map view',
      onTime: 'on time',
      delayed: 'delayed',
      early: 'early',
      vehicles: 'vehicles en route',
      popup: {
        nextStops: 'Next stops',
        noStops: 'no further stops reported',
        delayNone: 'on schedule',
        delayPlus: '+{n} min',
        delayMinus: '−{n} min',
        statusLate: 'Delayed',
        statusEarly: 'Early',
        statusOntime: 'On time',
        realtime: 'realtime',
        scheduled: 'scheduled',
        agency: 'Operator',
        destination: 'Destination',
        close: 'Close',
        loading: 'loading trip …',
        failed: 'Trip details unavailable',
        positionNote: 'Position derived from realtime stop prognoses (the open feed carries no GPS).',
        stopNow: 'now',
        inMin: 'in {n} min',
      },
      routingNote: 'Only vehicles with realtime data are shown — no timetable-only positions.',
      grpTram: 'Trams',
      grpS: 'S-Bahn',
      grpRegional: 'Regional trains',
      grpBusHeag: 'HEAG city buses',
      grpBusDadina: 'DADINA buses',
      grpBusRmv: 'RMV regional buses',
      grpBusOther: 'Other buses',
      lineOne: '1 line',
      lineMany: '{n} lines',
      legendTitle: 'Lines',
      tempoReal: 'as in real time',
      tempoHour: '1 h in {n} {u}',
      minUnit: 'min',
      secUnit: 's',
    },
    de: {
      appTitle: 'Darmstadt Live Map',
      subtitle: 'Straßenbahn, Bus und Regionalbahn – aus dem offenen Echtzeitstrom',
      dataSource: 'Daten',
      modeLive: 'Echtzeit',
      modeSchedule: 'Fahrplan (Simulation)',
      waiting: 'warte auf erste Daten …',
      updatedAgo: 'aktualisiert vor {s} s',
      stale: 'veraltet',
      failedAttempts: '{n} Fehlversuche',
      heading: 'Gerade unterwegs',
      trams: 'Straßenbahnen',
      buses: 'Busse',
      trains: 'Züge',
      showOnMap: 'Auf der Karte zeigen',
      togTram: 'Straßenbahn',
      togBus: 'Bus',
      togRail: 'Regionalbahn',
      playPause: 'Abspielen/Pause (Leertaste)',
      scheduleFor: 'Fahrplan für',
      weekday: 'Werktag',
      saturday: 'Samstag',
      sunday: 'Sonntag',
      tempo: 'Abspieltempo',
      speedLive: 'Live',
      speedSlow: 'Langsam',
      speedMedium: 'Mittel',
      speedFast: 'Schnell',
      highlightLine: 'Linie hervorheben',
      clear: 'Hervorhebung aufheben',
      clock: 'Jetzt',
      hint: 'Fahrzeug antippen für Linie, Verspätung und nächste Halte',
      attributionLive: 'Echtzeit: DELFI e.V. (CC BY-SA 4.0) über Transitous/MOTIS',
      attributionSchedule: 'Fahrplan: DELFI via gtfs.de (CC BY 4.0)',
      loading: 'Lade …',
      bannerUnreachable: 'Echtzeitdaten nicht erreichbar ({err}) – letzte bekannte Positionen, neuer Versuch läuft.',
      bannerBlip: 'Echtzeitdaten: kurzer Aussetzer, neuer Versuch läuft …',
      delayHistogram: 'Verspätung in Minuten (Anteil der Fahrzeuge)',
      noData: 'keine Echtzeitfahrzeuge im Kartenausschnitt',
      onTime: 'pünktlich',
      delayed: 'verspätet',
      early: 'verfrüht',
      vehicles: 'Fahrzeuge unterwegs',
      popup: {
        nextStops: 'Nächste Halte',
        noStops: 'keine weiteren Halte gemeldet',
        delayNone: 'fahrplanmäßig',
        delayPlus: '+{n} Min.',
        delayMinus: '−{n} Min.',
        statusLate: 'Verspätet',
        statusEarly: 'Zu früh',
        statusOntime: 'Pünktlich',
        realtime: 'Echtzeit',
        scheduled: 'Soll',
        agency: 'Betreiber',
        destination: 'Ziel',
        close: 'Schließen',
        loading: 'lade Fahrt …',
        failed: 'Fahrtdetails nicht verfügbar',
        positionNote: 'Position aus Echtzeit-Prognosen abgeleitet (der offene Datenstrom enthält kein GPS).',
        stopNow: 'jetzt',
        inMin: 'in {n} min',
      },
      routingNote: 'Es werden nur Fahrzeuge mit Echtzeitdaten gezeigt – keine reinen Fahrplanpositionen.',
      grpTram: 'Straßenbahn',
      grpS: 'S-Bahn',
      grpRegional: 'Regionalzüge',
      grpBusHeag: 'Stadtbusse HEAG',
      grpBusDadina: 'Busse DADINA',
      grpBusRmv: 'Regionalbusse RMV',
      grpBusOther: 'Sonstige Busse',
      lineOne: '1 Linie',
      lineMany: '{n} Linien',
      legendTitle: 'Linien',
      tempoReal: 'wie in echt',
      tempoHour: '1 Std. in {n} {u}',
      minUnit: 'Min.',
      secUnit: 'Sek.',
    },
  };

  const KEY = 'darmstadt-live-lang';
  let lang = 'en';

  function detect() {
    let stored = null;
    try { stored = localStorage.getItem(KEY); } catch (e) { /* Privatmodus */ }
    if (stored === 'en' || stored === 'de') return stored;
    // Vorgabe ist Englisch; nur bei eindeutig deutscher Browsersprache wird Deutsch gewählt
    const nav = (navigator.language || 'en').toLowerCase();
    return nav.startsWith('de') ? 'de' : 'en';
  }

  function t(key, vars) {
    const parts = key.split('.');
    let val = STRINGS[lang];
    for (const p of parts) val = val && val[p];
    if (typeof val !== 'string') {
      // Rückfall auf Englisch
      val = STRINGS.en;
      for (const p of parts) val = val && val[p];
    }
    if (typeof val !== 'string') return key;
    return val.replace(/\{(-?)(\w+)\}/g, (m, sign, name) => {
      const raw = vars && vars[name] !== undefined ? vars[name] : m;
      if (typeof raw !== 'number') return raw;
      return String(sign ? -raw : raw);
    });
  }

  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    scope.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
    scope.querySelectorAll('[data-i18n-aria]').forEach(el => {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
    document.documentElement.lang = lang;
    document.title = t('appTitle');
    document.querySelectorAll('#lang button').forEach(b => {
      b.classList.toggle('on', b.dataset.lang === lang);
      b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    });
  }

  function set(next) {
    lang = next === 'de' ? 'de' : 'en';
    try { localStorage.setItem(KEY, lang); } catch (e) { /* egal */ }
    apply();
    window.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
  }

  window.I18N = {
    get lang() { return lang; },
    t,
    apply,
    set,
    init() {
      lang = detect();
      apply();
      return lang;
    },
  };
})();
