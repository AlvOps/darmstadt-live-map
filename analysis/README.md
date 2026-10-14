# Untersuchungen zur Echtzeit-API

Diese Skripte haben das Datenmodell der Transitous-/MOTIS-Schnittstelle ermittelt, die
`docs/live.js` benutzt. Sie sind bewusst mitgeliefert, damit die Annahmen nachprüfbar bleiben.

| Skript | Frage | Ergebnis |
|--------|-------|----------|
| `where_is_vehicle.py` | Liegt im `polyline` eine Fahrzeugposition? | Nein — es ist die Abschnittsgeometrie `from`→`to` (Abweichung 0–3 m an beiden Enden) |
| `hop_structure.py` | Wie hängen Einträge und Fahrzeuge zusammen? | Ein Eintrag = ein Abschnitt; pro Fahrt bis zu 19 Abschnitte im Zeitfenster; ~55 fahrende Fahrzeuge im Stadtzentrum |
| `poll_shape.py` | Nutzlast gegen Zeitfenster und bbox | 1 Min ≈ 280 kB, 30 Min ≈ 1,2 MB; zu große bbox → HTTP 422 |
| `test_ui.js` | Popup, Zeitgeber, XSS, fehlerhafte Datensätze, Abruf-Stopp | ruft `test_i18n.js` und `test_static.js` mit auf |
| `test_i18n.js` | Fehlen EN/DE-Schlüssel oder gibt es fest verdrahtete Texte? | offline, schlägt bei Regression fehl |
| `test_static.js` | CSS fürs Telefon, Scrollbalken, Kontrast, Icons, Pfade | offline |
| `test_live.js` | Funktioniert das Modul mit echten Daten? | 62 Fahrzeuge, alle im Ausschnitt, Verspätungen −5…+7 min, keine ungültigen Koordinaten |

Alle Skripte brauchen nur Python 3 bzw. Node und keinen API-Schlüssel. `test_live.js` setzt einen
eigenen User-Agent, weil die API generische User-Agents mit HTTP 403 abweist.

```bash
node analysis/test_live.js
node analysis/test_ui.js
node analysis/test_i18n.js
node analysis/test_static.js
python3 analysis/where_is_vehicle.py
python3 analysis/hop_structure.py
python3 analysis/poll_shape.py
```
