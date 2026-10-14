# Darmstadt in Bewegung — Echtzeit

Interaktive Karte des Darmstädter Nahverkehrs: Straßenbahn, Stadt-/Regionalbus und S-/Regionalbahn.
Diese Abspaltung des ursprünglichen Projekts (`agent-mili/darmstadt_nahverkehr`) ergänzt eine
**Echtzeit-Ebene** — echte Verspätungen und Fahrzeugpositionen statt reiner Fahrplansimulation.

## Zwei Betriebsarten

| Modus | Inhalt | Datenquelle |
|-------|--------|-------------|
| **Echtzeit** (Standard) | Fahrzeuge an ihrer aktuellen Position, echte Verspätung je Fahrzeug, Verteilung der Verspätungen | DELFI-Echtzeitstrom über Transitous/MOTIS |
| **Fahrplan** | Replay des Soll-Fahrplans für Werktag/Samstag/Sonntag, Abspielgeschwindigkeit, Tagesprofil | statische GTFS-Daten (DELFI via gtfs.de) |

Im Echtzeit-Modus werden die Fahrzeugpositionen zwischen den Abrufen **lokal interpoliert**, deshalb
genügt ein Abruf alle 30 Sekunden (die Bewegung wirkt trotzdem flüssig).

## Dateien

```
docs/index.html      Oberfläche, Karte (MapLibre + deck.gl), Fahrplan-Simulation
docs/live.js         Echtzeit-Modul (Abruf, Fahrzeugbildung, Positionen, Ebenen, Statistik)
docs/data/meta.json  Linien, Farben, Haltestellen, Tram-Gleise (für beide Modi)
docs/data/*.json     statische Fahrplandaten für die Simulation
analysis/            Skripte, mit denen das Datenmodell der API ermittelt und geprüft wurde
```

Der Echtzeit-Modus benötigt aus `docs/data/` nur **`meta.json`** (Liniennamen und Farben). Die
Fahrplandaten werden erst nachgeladen, wenn auf „Fahrplan" umgeschaltet wird.

## Datenquellen und Lizenzen

| Daten | Herkunft | Lizenz |
|-------|----------|--------|
| Echtzeit (Prognose/Positionen) | DELFI e.V., bezogen über `api.transitous.org` (MOTIS) | **CC BY-SA 4.0** |
| Soll-Fahrplan (Simulation) | DELFI via gtfs.de | **CC BY 4.0** |
| Streckengeometrien | mit pfaedle erzeugt | — |
| Grundkarte | CARTO dark-matter, © OpenStreetMap-Mitwirkende | ODbL |

**Namensnennung ist Pflicht** (CC BY / CC BY-SA); die Oberfläche nennt die Quellen in der
Karten-Attribution und im Kopf-Panel. Wer Daten weiterverbreitet, muss sie unter gleichen
Bedingungen (Share-alike) weitergeben.

## Wie die Echtzeit-API funktioniert (und was sie nicht liefert)

Ermittelt durch eigene Messungen, dokumentiert in `analysis/`:

* **Kein GPS-Feld.** Jeder Eintrag von `GET /api/v1/map/trips` ist ein **Halt-zu-Halt-Abschnitt**
  („hop") einer Fahrt, nicht ein Fahrzeugpunkt:
  `from`/`to` (Haltestellen inkl. `lat`/`lon`), `departure`/`arrival` (Ist-Zeiten),
  `scheduledDeparture`/`scheduledArrival` (Soll-Zeiten), `realTime`, `polyline` (Geometrie des
  Abschnitts), `trips[0].tripId` und `routeShortName`.
  Die Geometrie beginnt exakt an `from` und endet exakt an `to` (Abweichung 0–3 m — gemessen,
  siehe `analysis/where_is_vehicle.py`), enthält also **keine** Positionsinformation.
* **Position wird interpoliert:** Fortschritt `u = (jetzt − departure) / (arrival − departure)`,
  Punkt bei `u` entlang der Abschnittslänge. Da `departure`/`arrival` bei `realTime: true` die
  Ist-Zeiten sind, bewegt sich das Fahrzeug im echten (verspäteten) Tempo.
* **Parameter:** `min`/`max` in der Reihenfolge **`lat,lon`** (umgekehrt liefert eine leere Liste),
  `zoom`, `startTime` und `endTime` sind Pflicht. Zeitfenster klein halten: 1 Minute ≈ 280 kB,
  30 Minuten ≈ 1,2 MB — längere Fenster liefern nur zusätzliche künftige Abschnitte.
* **Zu große Ausschnitte** können HTTP 422 liefern; das Modul begrenzt daher die bbox-Kantenlänge
  (`MAX_SPAN`) und den Zoom.
* **User-Agent:** Die API weist generische/fehlende User-Agents mit HTTP 403 ab
  („Generic user-agent headers are not allowed, please set your own"). Browser senden ihren eigenen;
  eigene Skripte müssen einen setzen.
* **Fernverkehr ausgeschlossen:** ICE/IC (`HIGHSPEED_RAIL`, `LONG_DISTANCE`), Fernbusse (`COACH`)
  und Flugzeuge haben Abschnitte mit mehreren tausend Geometriepunkten und reichen bis Stuttgart
  oder Nürnberg — bewusst nicht dargestellt, passend zum Umfang der Fahrplan-Simulation.
* Zusätzlich werden Fahrzeuge verworfen, die außerhalb des sichtbaren Kartenausschnitts liegen.

## Lokal starten

```bash
cd docs && python3 -m http.server 8080
# http://localhost:8080/
```

Es gibt keinen Build-Schritt; die Seite lädt MapLibre und deck.gl von jsDelivr.

## Prüfen

```bash
node analysis/test_live.js      # lädt docs/live.js, holt echte Echtzeitdaten, prüft
                                # Fahrzeuge, Positionen, Ebenen und UI-Ausgaben
python3 analysis/where_is_vehicle.py   # belegt: polyline == Abschnittsgeometrie, keine Position
python3 analysis/hop_structure.py      # Abschnitts-/Fahrzeugstruktur, Nutzlast je Zeitfenster
python3 analysis/poll_shape.py         # Nutzlast gegen Zeitfenster und bbox-Grenzen
```

`analysis/test_live.js` stubbed DOM/deck.gl und läuft daher ohne Browser. Ein Render-Check im
Browser ist separat möglich (headless Chromium mit `--enable-unsafe-swiftshader`).
