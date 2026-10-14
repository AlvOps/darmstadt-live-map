# Untersuchungen zur Echtzeit-API

Diese Skripte haben das Datenmodell der Transitous-/MOTIS-Schnittstelle ermittelt, die
`docs/live.js` benutzt. Sie sind bewusst mitgeliefert, damit die Annahmen nachprüfbar bleiben.

| Skript | Frage | Ergebnis |
|--------|-------|----------|
| `where_is_vehicle.py` | Liegt im `polyline` eine Fahrzeugposition? | Nein — es ist die Abschnittsgeometrie `from`→`to` (Abweichung 0–3 m an beiden Enden) |
| `hop_structure.py` | Wie hängen Einträge und Fahrzeuge zusammen? | Ein Eintrag = ein Abschnitt; pro Fahrt bis zu 19 Abschnitte im Zeitfenster; ~55 fahrende Fahrzeuge im Stadtzentrum |
| `poll_shape.py` | Nutzlast gegen Zeitfenster und bbox | 1 Min ≈ 280 kB, 30 Min ≈ 1,2 MB; zu große bbox → HTTP 422 |
| `test_ui.js` | Popup, Zeitgeber, XSS, fehlerhafte Datensätze, Abruf-Stopp | ruft `test_i18n.js` und `test_static.js` mit auf |
| `test_behaviour.js` | Je ein Ende-zu-Ende-Check pro behobenem Befund (M1–M12, Tok) | offline, fährt live.js **und** das Inline-Skript der Seite (Linienwahl/Stern/Sprachwechsel) |
| `smoke_browser.js` | Läuft die Seite in echtem Chromium über CDP ohne uncaught exception? | opt-in, braucht Netz + statischen Server (`node analysis/smoke_browser.js <url>`) |
| `test_i18n.js` | Fehlen EN/DE-Schlüssel oder gibt es fest verdrahtete Texte? | offline, schlägt bei Regression fehl |
| `test_static.js` | CSS fürs Telefon, Scrollbalken, Kontrast, Icons, Pfade | offline |
| `test_live.js` | Funktioniert das Modul mit echten Daten? | ~50 Fahrzeuge, alle im Ausschnitt, alle `realTime === true`, keine ungültigen Koordinaten |
| `scan_vehiclepositions.py` | Enthält der nationale GTFS-RT-Feed Fahrzeugpositionen? | 237.062 Entities, alle vom Typ `vehicle`, **0** mit Koordinaten (Messung 2026-10-14, 53,9 MB) |
| `brute_coords.py` | Grobe Suche nach Koordinaten unabhängig vom Protobuf-Schema | **0** plausible float32/double-Paare im gesamten Feed |
| `diag_feed.py` | Welche Felder stecken in den Entities? | Entity-ID, Zeit, `de:08…`-Haltestellen-IDs — keine Position |

Alle Skripte brauchen nur Python 3 bzw. Node und keinen API-Schlüssel. `test_live.js` setzt einen
eigenen User-Agent, weil die API generische User-Agents mit HTTP 403 abweist.

Die drei Feed-Scanner arbeiten auf der nationalen Rohdatei (kein Schlüssel nötig):

```bash
curl -A 'darmstadt-live-map/1.0' -o /tmp/gtfsrt.pb https://germany.motis-project.org/gtfsrt
python3 analysis/scan_vehiclepositions.py /tmp/gtfsrt.pb
python3 analysis/brute_coords.py          /tmp/gtfsrt.pb
python3 analysis/diag_feed.py             /tmp/gtfsrt.pb
```

```bash
node analysis/test_live.js
node analysis/test_ui.js
node analysis/test_i18n.js
node analysis/test_static.js
python3 analysis/where_is_vehicle.py
python3 analysis/hop_structure.py
python3 analysis/poll_shape.py
```
