// RMV-Meldungsleiste (HAFAS) fuer die Hauptkarte.
// Laedt einmal beim Seitenaufbau ueber den eigenen Proxy (zwei Abrufe), kein Polling.
// Ohne erreichbaren Proxy bleibt die Leiste aus - die Karte verhaelt sich dann wie vorher.
  // RMV-Meldungsleiste (HAFAS): laedt einmal beim Seitenaufbau, zwei Abrufe ueber den eigenen Proxy.
  // Ohne erreichbaren Proxy bleibt alles aus - die Karte verhaelt sich dann genau wie vorher.
  (function () {
    var BASE = 'https://talos.taild11d3b.ts.net';
    var RMV_URL = 'https://www.rmv.de/c/de/fahrplan/verkehrsmeldungen';
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

    head.onclick = function () {
      expanded = !expanded;
      list.hidden = !expanded;
      head.setAttribute('aria-expanded', String(expanded));
      caret.textContent = expanded ? '\u2304' : '\u2303';
    };

    function get(path) {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 6000) : null;
      return fetch(BASE + path, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .finally(function () { if (timer) clearTimeout(timer); });
    }

    get('/board?stop=3004734&duration=60').then(function (board) {
      var rows = (board && (board.departures || board.rows)) || [];
      var ids = [];
      rows.forEach(function (r) { if (r.lineId && ids.indexOf(r.lineId) < 0) ids.push(r.lineId); });
      if (!ids.length) throw new Error('no lines');
      return get('/notices?lineIds=' + encodeURIComponent(ids.slice(0, 50).join('|')));
    }).then(function (data) {
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
    }).catch(function () { /* Proxy nicht erreichbar: Leiste bleibt aus */ });

    // Sprache folgt dem EN/DE-Knopf der Karte.
    setInterval(function () {
      var next = pageLang();
      if (lang === null) { lang = next; return; }
      if (next !== lang) { lang = next; render(); }
    }, 1200);
  })();
  
