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
      subtitleOperator: 'Tram, bus and regional rail — operator GPS where available, otherwise the open realtime feed',
      dataSource: 'Data',
      modeLive: 'Realtime prognoses',
      modeLiveOperator: 'Realtime',
      waiting: 'waiting for first data …',
      // Es ist die Abrufzeit, nicht das Alter der Daten beim Betreiber — deshalb "fetched".
      fetchedAgo: 'fetched {s} s ago',
      stale: 'stale',
      expired: 'out of date',
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
      attributionOperator: 'Live vehicle positions (GPS): HEAG mobilo vehicle data via IVANTO, for the lines it reports',
      // Gilt je Quelle: Linien des Betreibers = GPS, alles andere = abgeleitet. Nie pauschal "kein GPS".
      attributionPosition: 'Positions are derived from realtime stop prognoses — the open feed carries no GPS. Data older than 45 s is marked stale, older than 2 min is dropped.',
      attributionPositionOperator: 'Two kinds of dots. On the lines the operator reports live, a dot is the operator’s own GPS position (the card shows how old the report is; the operator reports no delay). Every other dot is derived from realtime stop prognoses — the open feed carries no GPS. Open-feed data older than 45 s is marked stale, older than 2 min is dropped; operator reports older than 2 min are dropped too.',
      attribLabel: 'Data sources',
      langGroup: 'Language',
      stopMark: 'H',                       // Beschriftung der Haltestelle — bewusst in beiden Sprachen "H",
                                           // damit ein englisches "S" nicht als S-Bahn gelesen wird
      loading: 'Loading …',
      bannerUnreachable: 'Realtime data unreachable ({err}) — showing extrapolated positions from the last successful fetch, retrying.',
      bannerBlip: 'Realtime data: brief interruption, retrying …',
      bannerOperatorDown: 'Operator live positions unavailable — every dot is now derived from realtime stop prognoses (no GPS). Retrying.',
      statOperator: '{n} with operator GPS',
      statOperatorDown: 'operator GPS unavailable',
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
        positionNote: 'Position derived from realtime stop prognoses — not GPS (open feed).',
        positionNoteOperator: 'Position: the operator’s own live report (GPS) — not a prediction.',
        sourceOperator: 'operator live position',
        reportAge: 'report {s} s old',
        vehicleNo: 'vehicle {id}',
        delayNotReported: 'Delay not reported by the operator',
        noStopsOperator: 'The operator’s live report carries no stop list for this vehicle.',
        stopNow: 'now',
        inMin: 'in {n} min',
      },
      station: {
        title: 'Station',
        departures: 'Next departures',
        loading: 'loading departures …',
        failed: 'Departures unavailable',
        none: 'no departures reported',
        note: 'Departures are the operator\'s realtime predictions at this stop; rows marked "scheduled" carry no realtime update.',
        mapNote: 'Stop positions come straight from the feed (not from our timetable data).',
        cancelled: 'cancelled',
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
      tilt3d: 'Tilt the map (3D view)',
      geoTitle: 'Where am I?',
      geoSearching: 'Locating …',
      geoDenied: 'Location is not available — access denied or no signal.',
      geoUnsupported: 'This device cannot report its location.',
      welcomeDialog: 'Welcome',
      welcomeTitle: 'Work in progress',
      welcomeBody: 'Vehicle positions here are not GPS. They are predictions from the operators’ realtime feed, tied to the timetable, so a dot can sit at a stop or drift a little. Times, delays and this map itself can be wrong. A personal project, not an official app.',
      welcomeBodyOperator: 'Two kinds of dots. On the lines the operator reports live (most HEAG trams and buses and many regional buses) a dot is the operator’s own GPS position. Every other dot is not GPS: it is predicted from the realtime stop prognoses, tied to the timetable, so it can sit at a stop or drift a little. Each vehicle card says which kind it is. Times, delays and this map itself can be wrong. A personal project, not an official app.',
      welcomeOk: 'Got it',
      welcomeSkip: 'Skip the tour',
      welcomeNext: 'Next',
      welcomeDone: 'Start exploring',
      tutStep: 'Step {n} of {total}',
      tut1Title: '1 · Pick your line',
      tut1Body: 'Tap a line in the panel on the left. The map then shows only that line, and the camera jumps to its vehicles.',
      tut2Title: '2 · Tap a vehicle',
      tut2Body: 'Its card shows the next stops, the delay and where it is heading. The card follows the vehicle, the dashed line shows which dot it belongs to, and you can drag it aside.',
      tut3Title: '3 · Tap a stop inside the card',
      tut3Body: 'You jump to that stop and see its next departures. While a line is selected the stops stay hidden; after ten seconds of quiet they come back by themselves.',
      tut4Title: '4 · Language, 3D and the drawer',
      tut4Body: 'EN/DE sits top right, the cube button beside the compass tilts the map, and on a phone the panel slides away when you tap the map — the ☰ button brings it back.',
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
      subtitleOperator: 'Straßenbahn, Bus und Regionalbahn – GPS des Betreibers, wo vorhanden, sonst der offene Echtzeitstrom',
      dataSource: 'Daten',
      modeLive: 'Echtzeit-Prognosen',
      modeLiveOperator: 'Echtzeit',
      waiting: 'warte auf erste Daten …',
      fetchedAgo: 'abgerufen vor {s} s',
      stale: 'veraltet',
      expired: 'überholt',
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
      attributionOperator: 'Live-Fahrzeugpositionen (GPS): Fahrzeugdaten der HEAG mobilo über IVANTO, für die dort gemeldeten Linien',
      attributionPosition: 'Die Positionen sind aus Echtzeit-Prognosen abgeleitet – der offene Datenstrom enthält kein GPS. Daten, die älter als 45 s sind, gelten als veraltet, ab 2 Min. werden sie verworfen.',
      attributionPositionOperator: 'Zwei Arten von Punkten. Auf den Linien, die der Betreiber live meldet, ist ein Punkt dessen eigene GPS-Position (die Karte zeigt, wie alt die Meldung ist; eine Verspätung meldet der Betreiber nicht). Alle anderen Punkte sind aus Echtzeit-Prognosen der Haltestellen abgeleitet – der offene Datenstrom enthält kein GPS. Daten des offenen Stroms, die älter als 45 s sind, gelten als veraltet, ab 2 Min. werden sie verworfen; Betreibermeldungen älter als 2 Min. ebenfalls.',
      attribLabel: 'Datenquellen',
      langGroup: 'Sprache',
      stopMark: 'H',                       // deutsche Beschriftung der Haltestelle
      loading: 'Lade …',
      bannerUnreachable: 'Echtzeitdaten nicht erreichbar ({err}) – gezeigt werden fortgeschriebene Positionen des letzten erfolgreichen Abrufs, neuer Versuch läuft.',
      bannerBlip: 'Echtzeitdaten: kurzer Aussetzer, neuer Versuch läuft …',
      bannerOperatorDown: 'Live-Positionen des Betreibers nicht verfügbar – alle Punkte sind jetzt aus Echtzeit-Prognosen abgeleitet (kein GPS). Neuer Versuch läuft.',
      statOperator: '{n} mit GPS des Betreibers',
      statOperatorDown: 'GPS des Betreibers nicht verfügbar',
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
        positionNote: 'Position aus Echtzeit-Prognosen abgeleitet – kein GPS (offener Datenstrom).',
        positionNoteOperator: 'Position: eigene Live-Meldung des Betreibers (GPS) – keine Prognose.',
        sourceOperator: 'Live-Position des Betreibers',
        reportAge: 'Meldung {s} s alt',
        vehicleNo: 'Fahrzeug {id}',
        delayNotReported: 'Verspätung vom Betreiber nicht gemeldet',
        noStopsOperator: 'Die Live-Meldung des Betreibers enthält für dieses Fahrzeug keine Halteliste.',
        stopNow: 'jetzt',
        inMin: 'in {n} Min.',
      },
      station: {
        title: 'Haltestelle',
        departures: 'Nächste Abfahrten',
        loading: 'lade Abfahrten …',
        failed: 'Abfahrten nicht verfügbar',
        none: 'keine Abfahrten gemeldet',
        note: 'Die Abfahrten sind die Echtzeit-Prognosen des Betreibers an dieser Haltestelle; mit "Soll" gekennzeichnete Zeilen haben keine Echtzeitmeldung.',
        mapNote: 'Die Positionen der Halte kommen direkt aus dem Feed (nicht aus unseren Fahrplandaten).',
        cancelled: 'fällt aus',
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
      tilt3d: 'Karte kippen (3D-Ansicht)',
      geoTitle: 'Wo bin ich?',
      geoSearching: 'Ortung läuft …',
      geoDenied: 'Standort nicht verfügbar — Zugriff abgelehnt oder kein Signal.',
      geoUnsupported: 'Dieses Gerät kann seinen Standort nicht melden.',
      welcomeDialog: 'Willkommen',
      welcomeTitle: 'Baustelle',
      welcomeBody: 'Die Fahrzeugpositionen sind kein GPS. Sie sind Prognosen aus dem Echtzeitstrom der Betreiber und hängen am Fahrplan, ein Punkt kann also am Halt stehen oder leicht daneben liegen. Zeiten, Verspätungen und diese Karte selbst können falsch sein. Privates Projekt, keine offizielle App.',
      welcomeBodyOperator: 'Zwei Arten von Punkten. Auf den Linien, die der Betreiber live meldet (die meisten HEAG-Straßenbahnen und -Busse und viele Regionalbusse), ist ein Punkt dessen eigene GPS-Position. Alle anderen Punkte sind kein GPS: Sie sind aus den Echtzeit-Prognosen der Haltestellen vorhergesagt und hängen am Fahrplan, ein Punkt kann also am Halt stehen oder leicht daneben liegen. Jede Fahrzeugkarte sagt, welche Art es ist. Zeiten, Verspätungen und diese Karte selbst können falsch sein. Privates Projekt, keine offizielle App.',
      welcomeOk: 'Verstanden',
      welcomeSkip: 'Einführung überspringen',
      welcomeNext: 'Weiter',
      welcomeDone: 'Los geht’s',
      tutStep: 'Schritt {n} von {total}',
      tut1Title: '1 · Linie wählen',
      tut1Body: 'Tippe links im Panel eine Linie an. Die Karte zeigt dann nur diese Linie und schwenkt zu ihren Fahrzeugen.',
      tut2Title: '2 · Fahrzeug antippen',
      tut2Body: 'Die Karte zeigt die nächsten Halte, die Verspätung und das Ziel. Sie folgt dem Fahrzeug, die gestrichelte Linie zeigt, zu welchem Punkt sie gehört, und du kannst sie zur Seite ziehen.',
      tut3Title: '3 · Halt in der Karte antippen',
      tut3Body: 'Du springst zu diesem Halt und siehst die nächsten Abfahrten. Bei gewählter Linie sind die Halte ausgeblendet — nach zehn Sekunden Ruhe kommen sie von selbst zurück.',
      tut4Title: '4 · Sprache, 3D und die Schublade',
      tut4Body: 'EN/DE oben rechts, der Würfel neben dem Kompass kippt die Karte, und auf dem Telefon schiebt ein Tipp auf die Karte das Panel weg — der ☰-Knopf holt es zurück.',
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
