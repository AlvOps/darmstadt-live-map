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
      highlightLine: 'Highlight line',
      clear: 'Clear highlight',
      clock: 'Now',
      hint: 'Tap a vehicle for line, delay and next stops',
      attributionLive: 'Realtime: DELFI e.V. (CC BY-SA 4.0) via Transitous/MOTIS',
      attributionMap: 'Base map: © OpenStreetMap contributors (ODbL) · CARTO',
      attribLabel: 'Data sources',
      langGroup: 'Language',
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
        statusUnknown: 'Delay unknown',
        noTrip: 'No stop list was returned for this trip.',
        dialog: 'Vehicle details',
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
      station: {
        title: 'Station',
        departures: 'Next departures',
        loading: 'loading departures …',
        failed: 'Departures unavailable',
        none: 'no departures reported',
        note: 'Departures are the operator\'s realtime predictions at this stop.',
        mapNote: 'Stop positions come straight from the feed (not from our timetable data).',
      },
      routingNote: 'Only vehicles with realtime data are shown — no timetable-only positions.',
      grpTram: 'Trams',
      grpS: 'S-Bahn',
      grpRegional: 'Regional trains',
      grpBusHeag: 'HEAG city buses',
      grpBusDadina: 'DADINA buses',
      grpBusRmv: 'RMV regional buses',
      grpBusOther: 'Other buses',
      legendTitle: 'Lines',
      presentation: 'Status & filters',
      openPanel: 'Lines',
      closePanel: 'Close panel',
      favTitle: 'Favourites',
      favStations: 'Saved stops',
      favLines: 'Saved lines',
      favEmpty: 'Nothing saved yet — tap the star on a stop card or on a line.',
      favAdd: 'Save as favourite',
      favRemove: 'Remove from favourites',
      searchPlaceholder: 'Search a stop …',
      searchLabel: 'Search a stop',
      searchNoHit: 'No stop found',
    },
    de: {
      appTitle: 'Darmstadt Live Map',
      subtitle: 'Straßenbahn, Bus und Regionalbahn – aus dem offenen Echtzeitstrom',
      dataSource: 'Daten',
      modeLive: 'Echtzeit',
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
      highlightLine: 'Linie hervorheben',
      clear: 'Hervorhebung aufheben',
      clock: 'Jetzt',
      hint: 'Fahrzeug antippen für Linie, Verspätung und nächste Halte',
      attributionLive: 'Echtzeit: DELFI e.V. (CC BY-SA 4.0) über Transitous/MOTIS',
      attributionMap: 'Grundkarte: © OpenStreetMap-Mitwirkende (ODbL) · CARTO',
      attribLabel: 'Datenquellen',
      langGroup: 'Sprache',
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
        statusUnknown: 'Verspätung unbekannt',
        noTrip: 'Für diese Fahrt wurde keine Haltestellenliste geliefert.',
        dialog: 'Fahrzeugdetails',
        realtime: 'Echtzeit',
        scheduled: 'Soll',
        agency: 'Betreiber',
        destination: 'Ziel',
        close: 'Schließen',
        loading: 'lade Fahrt …',
        failed: 'Fahrtdetails nicht verfügbar',
        positionNote: 'Position aus Echtzeit-Prognosen abgeleitet (der offene Datenstrom enthält kein GPS).',
        stopNow: 'jetzt',
        inMin: 'in {n} Min.',
      },
      station: {
        title: 'Haltestelle',
        departures: 'Nächste Abfahrten',
        loading: 'lade Abfahrten …',
        failed: 'Abfahrten nicht verfügbar',
        none: 'keine Abfahrten gemeldet',
        note: 'Die Abfahrten sind die Echtzeit-Prognosen des Betreibers an dieser Haltestelle.',
        mapNote: 'Die Positionen der Halte kommen direkt aus dem Feed (nicht aus unseren Fahrplandaten).',
      },
      routingNote: 'Es werden nur Fahrzeuge mit Echtzeitdaten gezeigt – keine reinen Fahrplanpositionen.',
      grpTram: 'Straßenbahn',
      grpS: 'S-Bahn',
      grpRegional: 'Regionalzüge',
      grpBusHeag: 'Stadtbusse HEAG',
      grpBusDadina: 'Busse DADINA',
      grpBusRmv: 'Regionalbusse RMV',
      grpBusOther: 'Sonstige Busse',
      legendTitle: 'Linien',
      presentation: 'Status & Filter',
      openPanel: 'Linien',
      closePanel: 'Panel schließen',
      favTitle: 'Favoriten',
      favStations: 'Gemerkte Halte',
      favLines: 'Gemerkte Linien',
      favEmpty: 'Noch nichts gemerkt – tippe den Stern auf einer Haltestellenkarte oder bei einer Linie.',
      favAdd: 'Als Favorit merken',
      favRemove: 'Favorit entfernen',
      searchPlaceholder: 'Haltestelle suchen …',
      searchLabel: 'Haltestelle suchen',
      searchNoHit: 'Keine Haltestelle gefunden',
    },
  };

  const KEY = 'darmstadt-live-lang';
  let lang = 'en';

  function detect() {
    let stored = null;
    try { stored = localStorage.getItem(KEY); } catch (e) { /* Privatmodus */ }
    if (stored === 'en' || stored === 'de') return stored;
    // Vorgabe ist immer Englisch (Vorgabe des Betreibers); Deutsch nur nach ausdrücklicher Wahl.
    return 'en';
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
    const filled = val.replace(/\{(-?)(\w+)\}/g, (m, sign, name) => {
      const raw = vars && vars[name] !== undefined ? vars[name] : m;
      if (typeof raw !== 'number') return raw;
      return String(sign ? -raw : raw);
    });
    // Sicherheitsnetz: ein Platzhalter ohne Wert darf nie sichtbar werden (z. B. "{n} lines").
    // Lieber den Rest der Zeile zeigen als eine kaputte Vorlage.
    return filled.replace(/\s*\{-?\w+\}/g, '').trim();
  }

  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    scope.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
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
    detect,
    strings: STRINGS,               // für die Schlüsselprüfung in analysis/test_i18n.js
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
