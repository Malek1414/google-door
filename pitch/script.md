# Doorway: Bühnentext, 3 Minuten

Sprache auf der Bühne: Deutsch. Tempo: rund 130 Wörter pro Minute.
Wortzahl und Sekunden pro Abschnitt unten sind gerechnet (Wörter / 130 × 60), nicht gestoppt.
Vor dem Freeze zweimal laut stoppen und die gemessenen Zeiten in die Tabelle am Ende eintragen.

Erdin ist der rote Faden, kein Testimonial am Ende. Wir sprechen über ihn, nie für ihn.
Seine eigenen Worte kommen nur aus der Aufnahme (Shot 8), nie aus diesem Text.

Regieanweisungen stehen in eckigen Klammern und werden nicht gesprochen.

---

## 1. Das Problem, durch eine Person (0:00 bis 0:25)

**Folie 1** [Film startet mit der Folie: Shot 1 und 2, ohne Ton oder leise]

Das ist Erdin. Erdin ist teilweise blind. Mit Live View findet er den Weg bis zum Pin. Und dann steht er vor dem Gebäude und weiß nicht, welche Tür er benutzen kann. Das ist kein Sonderfall. Das ist seine Woche.

[OPTIONAL, O-TON ERDIN: bis zu 8 Sekunden aus Shot 8, wörtlich aus der Aufnahme, nicht nachsprechen. Wenn eingesetzt, entfallen die beiden Sätze „Das ist kein Sonderfall. Das ist seine Woche.“ Vorher mit Erdin klären, dass „seine Woche“ stimmt.]

**Folie 2** [weiter, Pause vor dem zweiten Satz]

Google Maps weiß, dass das Gebäude barrierefrei ist. Es weiß nicht, welche Tür.

## 2. Die Lücke, in Zahlen (0:25 bis 1:00)

**Folie 3**

Berlin Hauptbahnhof. 109 Eingänge in OpenStreetMap. Acht sind als stufenlos eingetragen. Elf als nicht stufenlos. Bei 90 steht nichts. Google Maps zeigt einen Pin.

**Folie 4**

Zwei dieser Türen liegen 9,1 Meter auseinander. Die eine ist stufenlos, die andere nicht. Die Adresse, Invalidenstraße 52, gehört zur Tür, die nicht stufenlos ist. Dorthin führt die Navigation.

**Folie 5**

Und das ist nicht nur der Bahnhof. In Berlin Mitte gibt es 3.061 Eingänge. Nur 296 sagen überhaupt etwas. Neunzig Prozent: unbekannt.

## 3. Doorway (1:00 bis 2:15)

**Folie 6** [Film startet: Shot 3 bis 6, mit Ton. Nur in die Lücken sprechen, das Tonsignal muss hörbar bleiben. Bei Live-Demo: gleicher Text, gleiche Pausen.]

Das ist Doorway. Erdin öffnet die App und sieht jeden Eingang. Der stufenlose ist deutlich markiert. Er wählt ihn aus.

[Pause, Kameraansicht, Pfeil erscheint]

Die Kameraansicht zeigt ihm den Pfeil zur Tür, nicht zum Gebäude.

[Pause, Tonsignal hörbar lassen]

Hören Sie das Signal? Es wird schneller, je genauer er auf die Tür zuläuft. Das funktioniert auch ohne hinzusehen.

[Pause bis zur Ankunft]

Ein langer Vibrationsimpuls. Angekommen. An der richtigen Tür.

**Folie 7** [Film: Shot 7]

Und jetzt der Moment, auf den es ankommt. Am Hauptbahnhof sind zwei Haupteingänge als stufenlos eingetragen, 155 Meter auseinander. Einer davon, Eingang Europaplatz, ist eine Drehtür. Doorway warnt ihn. Ein Ja oder Nein kann das nicht sagen.

## 4. Der Agent (2:15 bis 2:40)

**Folie 8**

Und hier arbeitet der Agent. Menschen mit Behinderung haben längst aufgeschrieben, wo die Rampe ist. In Rezensionen. Gemini liest sie und liest sie Erdin vor. Wörtlich und mit Quelle. Das Wissen war da. Niemand hat es erschlossen.

[Wenn das echte Zitat auf der Folie steht: nicht vorlesen, eine Sekunde stehen lassen.]

**Folie 9**

Und der Agent zeichnet nie einen Pfeil. Einen Pfeil gibt es nur zu Türen, die vermessen sind.

## 5. Warum Google das bauen sollte (2:40 bis 3:00)

**Folie 10**

Google Places speichert schon, ob ein Gebäude einen barrierefreien Eingang hat. Was fehlt, ist die Koordinate der Tür.

[NUR WENN HEUTE NACHT VERMESSEN: „Für unsere eigene Uni gab es keine Daten. Wir haben sie in zwanzig Minuten vermessen.“ Sonst weglassen.]

Mit Local Guides wächst das überall mit. Google Maps kennt das Gebäude. Doorway kennt die Tür.

---

## Zeitplan

| Abschnitt | Folien | Fenster laut Brief | Wörter | gerechnet | Rest für Film, Pausen, Ton |
|---|---|---|---|---|---|
| 1 Problem | 1, 2 | 25 s | 53 | 24,5 s | 0,5 s |
| 2 Lücke | 3, 4, 5 | 35 s | 75 | 34,6 s | 0,4 s |
| 3 Doorway | 6, 7 | 75 s | 95 | 43,8 s | 31,2 s |
| 4 Agent | 8, 9 | 25 s | 54 | 24,9 s | 0,1 s |
| 5 Google | 10 | 20 s | 34 | 15,7 s | 4,3 s |
| **Summe** | 10 | **180 s** | **311** | **143,5 s** | **36,5 s** |

Mit dem optionalen CODE-Satz und ohne den Local-Guides-Satz (Hinweis 2): Abschnitt 5 hat 43 Wörter, 19,8 s.

Die Zahlen in dieser Tabelle erzeugt `python3 pitch/wordcount.py`. Wer den Text ändert, lässt es neu laufen.

Hinweise zum Timing:

1. Abschnitt 2 und 4 sind auf die Sekunde voll. Wenn es beim lauten Stoppen eng wird, zuerst in Abschnitt 2 kürzen („Und das ist nicht nur der Bahnhof.“ streichen), nie in Abschnitt 4. Das Thema ist AI Agents.
2. Der optionale CODE-Satz in Abschnitt 5 passt nur, wenn „Mit Local Guides wächst das überall mit.“ dafür entfällt.
3. Abschnitt 3 lebt vom Film. Die 31 Sekunden Rest sind Absicht: Tonsignal und Ankunft brauchen Stille.
4. Optionaler O-Ton Erdin in Abschnitt 1 ersetzt 2 Sätze (7 Wörter, rund 3 s) durch bis zu 8 s Film, also bis zu 5 s mehr. Die holt ihr in Abschnitt 3 aus einer Pause.
5. „Live View“ sagen wir bewusst nur für Google Maps (Abschnitt 1). Doorway hat eine eigene Kameraansicht; wer sie „Live View“ nennt, behauptet eine Integration, die es nicht gibt.

## Gestoppte Zeiten (vom Team auszufüllen)

| Durchlauf | Abschnitt 1 | 2 | 3 | 4 | 5 | Gesamt |
|---|---|---|---|---|---|---|
| laut, 1 | | | | | | |
| laut, 2 | | | | | | |
| vor Ort, 1 | | | | | | |
| vor Ort, 2 | | | | | | |
