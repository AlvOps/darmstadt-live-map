// RMV-Meldungsleiste (HAFAS) fuer die Hauptkarte.
// Ein Abruf beim Seitenaufbau ueber den eigenen Proxy, kein Polling. Antwortet die Quelle nicht,
// bleibt die Leiste nicht einfach weg, sondern sagt sichtbar, dass die Live-Daten fehlen.
  (function () {
    var BASE = 'https://talos.taild11d3b.ts.net';
    // Ein Abruf genuegt: der Proxy haelt die Linien-IDs des Gebiets und fragt die Meldungen.
    var RMV_URL = 'https://www.rmv.de/c/de/fahrplan/verbindungssuche-hinweise/verkehrsmeldungen';
    var items = [], expanded = false, lang = null;

    var GLOSSARY = [
      ['Haltestellenänderung', 'stop change'], ['Haltestellenverlegung', 'stop relocation'],
      ['Haltestellen entfallen', 'stops cancelled'], ['Haltestellen', 'stops'], ['Haltestelle', 'stop'],
      ['Fahrplanänderungen', 'schedule changes'], ['Fahrplanänderung', 'schedule change'],
      ['Teilausfälle', 'partial cancellations'], ['Teilausfall', 'partial cancellation'],
      ['Zugausfälle', 'train cancellations'], ['Ausfälle', 'cancellations'], ['Ausfall', 'cancellation'],
      ['Streckensperrung', 'line closure'], ['Umleitungen', 'diversions'], ['Umleitung', 'diversion'],
      ['Bauarbeiten', 'construction works'], ['Baustelle', 'roadworks'], ['Fahrplan', 'timetable'],
      ['Verspätungen', 'delays'], ['Verspätung', 'delay'], ['entfällt', 'cancelled'], ['entfallen', 'cancelled'],
      ['verlegt', 'relocated'], ['einzelnen', 'individual'], ['einzelne', 'individual'],
      ['Nächten', 'nights'], ['nachts', 'at night'], ['Wegen', 'Due to'], ['wegen', 'due to'],
      ['Störung', 'disruption'], ['Gleis', 'track'], ['Meldung', 'notice'], ['Busse', 'buses'],
      ['Ersatzverkehr', 'replacement service'], ['SEV', 'rail replacement service'],
      ['Rathaus', 'town hall'], ['Hauptbahnhof', 'main station'], ['Bahnhof', 'station']
    ];

    // Wenn die Quelle nicht antwortet: Klartext statt stiller leerer Karte.
    // Nur die Meldungen fehlen - nicht die Karte. Das muss dastehen, sonst wirkt die Karte unzuverlaessig.
    var OFFLINE = {
      // short = die eine Zeile in der zugeklappten Leiste, head = ausgeschrieben in der geoeffneten Zeile.
      de: { short: 'Verspätungs-/Störungsmeldungen nicht verfügbar',
            head: 'Verspätungs- und Störungsmeldungen sind derzeit nicht verfügbar.',
            sub: 'Die Fahrzeugpositionen auf der Karte sind davon nicht betroffen.',
            link: 'Meldungen auf rmv.de ansehen', meta: 'RMV HAFAS antwortet nicht' },
      en: { short: 'Delay/disruption notices unavailable',
            head: 'Delay and disruption notices are currently unavailable.',
            sub: 'Vehicle positions on the map are unaffected.',
            link: 'View notices on rmv.de', meta: 'RMV HAFAS not responding' }
    };

    function pageLang() {
      var l = String((document.documentElement.getAttribute('lang') || 'de')).slice(0, 2).toLowerCase();
      return l === 'en' ? 'en' : 'de';
    }
    function tr(text) {
      var out = String(text || '');
      if (pageLang() !== 'en') return out;
      GLOSSARY.forEach(function (p) { out = out.split(p[0]).join(p[1]); });
      return out;
    }
    function rel(iso) {
      var t = Date.parse(iso || '');
      if (!isFinite(t)) return '';
      var en = pageLang() === 'en', m = Math.round((Date.now() - t) / 60000);
      if (m < 2) return en ? 'just now' : 'gerade eben';
      if (m < 60) return en ? m + ' min ago' : 'vor ' + m + ' Min';
      var h = Math.round(m / 60);
      if (h < 36) return en ? h + ' hr ago' : 'vor ' + h + ' Std';
      return en ? Math.round(h / 24) + ' days ago' : 'vor ' + Math.round(h / 24) + ' Tagen';
    }
    function colour(line) {
      var l = String(line || '').trim();
      if (/^\d/.test(l)) return '#ff6b6b';
      if (/^(S\d|SEV|RE|RB|IC|ICE|HLB)/i.test(l)) return '#c77dff';
      return '#2ec4b6';
    }

    // Die Leiste darf nie eine feste Hoehe annehmen: gemessene Hoehe in --rmvbar-h schreiben,
    // damit Karte, Uhr und Panel genau um diesen Betrag nachruecken.
    function syncHeight() {
      var h = bar.offsetHeight;
      if (h > 0) document.body.style.setProperty('--rmvbar-h', h + 'px');   // body, sonst gewinnt die CSS-Regel auf body
    }
    window.addEventListener('resize', function () { setTimeout(syncHeight, 60); });

    var bar = document.createElement('div');
    bar.id = 'rmvbar';
    bar.innerHTML = '<button id="rmvbar-head" type="button" aria-expanded="false">' +
      '<span class="badge">RMV</span><span id="rmvbar-count"></span><span class="spacer"></span>' +
      '<span id="rmvbar-meta">RMV HAFAS</span><span id="rmvbar-caret">\u2303</span></button>' +
      '<ul id="rmvbar-list" hidden></ul>';
    document.body.appendChild(bar);
    var head = bar.querySelector('#rmvbar-head');
    var list = bar.querySelector('#rmvbar-list');
    var countEl = bar.querySelector('#rmvbar-count');
    var caret = bar.querySelector('#rmvbar-caret');

    function render() {
      var en = pageLang() === 'en';
      list.textContent = '';
      items.forEach(function (n) {
        var li = document.createElement('li');
        var chip = document.createElement('span');
        chip.className = 'rmv-line'; chip.textContent = n.line || '?';
        chip.style.background = colour(n.line);
        var body = document.createElement('div'); body.className = 'body';
        var a = document.createElement('a');
        a.className = 'rmv-text'; a.href = RMV_URL; a.target = '_blank'; a.rel = 'noopener noreferrer';
        var original = n.headline || n.text || '';
        a.textContent = tr(original) + ' \u2197';
        a.title = original + ' \u2014 ' + (en ? 'open RMV notices' : 'RMV-Meldungen oeffnen');
        var when = document.createElement('div'); when.className = 'when'; when.textContent = rel(n.validFrom);
        body.appendChild(a); body.appendChild(when);
        li.appendChild(chip); li.appendChild(body);
        list.appendChild(li);
      });
      countEl.textContent = items.length + ' ' + (en ? (items.length === 1 ? 'notice' : 'notices')
                                                      : (items.length === 1 ? 'Meldung' : 'Meldungen'));
      caret.textContent = expanded ? '\u2304' : '\u2303';
    }

    // Ausfallzustand: Leiste sichtbar, eine Zeile mit Hinweis + Link, standardmaessig aufgeklappt.
    function showUnavailable(reason) {
      var m = OFFLINE[pageLang()] || OFFLINE.de;
      items = [];
      list.textContent = '';
      var li = document.createElement('li');
      var body = document.createElement('div'); body.className = 'body';
      var strong = document.createElement('div');
      strong.className = 'rmv-text';
      strong.style.webkitLineClamp = 'none';
      strong.textContent = m.head;
      var sub = document.createElement('div');
      sub.className = 'when';
      sub.style.webkitLineClamp = 'none';
      sub.textContent = m.sub;
      var a = document.createElement('a');
      a.className = 'rmv-text'; a.href = RMV_URL; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.style.marginTop = '3px'; a.style.display = 'inline-block';
      a.textContent = m.link + ' \u2197';
      body.appendChild(strong); body.appendChild(sub); body.appendChild(a);
      li.appendChild(body);
      list.appendChild(li);
      countEl.textContent = m.short;
      bar.querySelector('#rmvbar-meta').textContent = m.meta;
      head.title = m.head + ' ' + m.sub + ' (' + String(reason || '') + ')';
      expanded = false; list.hidden = true;
      head.setAttribute('aria-expanded', 'false');
      caret.textContent = '\u2303';
      document.body.classList.add('rmv-on');
      syncHeight();
    }

    head.onclick = function () {
      expanded = !expanded;
      list.hidden = !expanded;
      head.setAttribute('aria-expanded', String(expanded));
      caret.textContent = expanded ? '\u2304' : '\u2303';
      if (!expanded) syncHeight();     // aufgeklappt darf die Liste darueber liegen
    };

    function get(path) {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 6000) : null;
      return fetch(BASE + path, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .finally(function () { if (timer) clearTimeout(timer); });
    }

    get('/notices/area').then(function (data) {
      var cutoff = Date.now() - 30 * 86400000;
      items = ((data && data.notices) || []).filter(function (n) {
        var t = Date.parse(n.validFrom || '');
        return !isFinite(t) || t >= cutoff;
      }).sort(function (a, b) {
        return (Date.parse(b.validFrom) || 0) - (Date.parse(a.validFrom) || 0);
      });
      if (!items.length) return;
      document.body.classList.add('rmv-on');
      render();
      syncHeight();
    }).catch(function (e) { showUnavailable((e && e.message) || 'unreachable'); });

    // Sprache folgt dem EN/DE-Knopf der Karte.
    setInterval(function () {
      var next = pageLang();
      if (lang === null) { lang = next; return; }
      if (next !== lang) {
        lang = next;
        if (!items.length && list.children.length && head.title) {
          showUnavailable(head.title);
        } else { render(); }
      }
    }, 1200);
  })();
  
