# Pitch-Checkliste bis Freeze (Do 10:00)

Definition of Done aus `docs/briefs/BRIEF-PITCH.md`, aufgeteilt in erledigt (Agent) und offen (Team).

| # | Definition of Done | Stand | Wer |
|---|---|---|---|
| 1 | Deck in `pitch/`, 10 Folien, Deutsch, Kontrast geprüft | erledigt, mit Platzhaltern (siehe unten) | Agent |
| 2 | 3-Minuten-Text, zweimal laut gestoppt | Text fertig und gerechnet (143,5 s), **laut stoppen offen** | Team |
| 3 | Backup-Video 1080p mit eingebrannten Untertiteln, läuft ohne Netz | Untertitel-Gerüst und Befehl fertig, **Dreh, Schnitt, Export offen** | Team |
| 4 | Jede Zahl auf `pipeline/fixtures/` oder den Brief zurückgeführt | erledigt, Nachweis in der PR-Beschreibung | Agent |
| 5 | Einwilligung von Erdin aufgenommen | Vorlage fertig (`consent.md`), **prüfen und aufnehmen offen** | Team |
| 6 | Zweimal vor Ort geprobt, vor 10:00 | **offen** | Team |

## Offen für das Team, in dieser Reihenfolge

1. **Heute 19:30:** `consent.md` lesen, Platzhalter füllen (Kontakt für Widerruf, wo gezeigt wird).
2. **20:00 bis 21:00:** Drehen nach `shotlist.md`. Einwilligung zuerst. Shot 5 mit sauberem Ton.
3. **Heute Nacht, falls vermessen wird:** Eingänge der CODE University live zählen. Der Brief nennt „rund 37, fast keiner mit Rollstuhl-Angabe“, das ist **nicht geprüft**. Zahl in Folie 10 und Skript eintragen oder beide CODE-Kästen löschen.
4. **Schnitt:** Reihenfolge Shot 1 bis 9 wie in der Drehliste. Dann `captions/backup-video.de.vtt` an die echten Zeiten anpassen, Platzhalter durch den Wortlaut ersetzen, SRT neu erzeugen (Befehl unten).
5. **Echtes Zitat für Folie 8** aus `/api/lived` holen, wörtlich, mit Quelle. Gibt es keins: Kasten löschen. Nie den Beispielsatz aus `docs/CONTRACT.md` nehmen, der ist erfunden.
6. **Export:** Backup-Video mit eingebrannten Untertiteln (Befehl unten), auf den Präsentationsrechner und einen USB-Stick.
7. **Skript zweimal laut stoppen,** Zeiten in `script.md` eintragen.
8. **Do vor 10:00 vor Ort:** zweimal komplett proben, mit Beamer und Saalton. Tonsignal über die Anlage testen.
9. **PDF neu exportieren,** sobald Platzhalter gefüllt sind (Befehl unten).

## Deck starten

Im Ordner `pitch/`:

    python3 -m http.server 8000

Dann `http://localhost:8000/deck/` öffnen, `F` für Vollbild.
Über `file://` läuft das Deck auch, nur die Untertitel-Spur lädt Chrome dort nicht.

Tasten: Pfeil rechts, Leertaste, Bild runter, Enter = weiter. Pfeil links, Umschalt+Leertaste, Bild hoch = zurück.
Pos1 / Ende = erste / letzte Folie. `C` = Untertitel-Spur ein/aus. `F` = Vollbild.
Filme starten beim Betreten der Folie (braucht vorher einen Tastendruck, der Presenter-Klick zählt).

Das Deck erwartet das fertige Video unter `pitch/media/backup-video.mp4`.
`pitch/media/` ist per `.gitignore` ausgeschlossen: Aufnahmen von Erdin gehören nicht ins Repo.

## Backup-Video exportieren (1080p, Untertitel eingebrannt)

ffmpeg ist auf dem Mac nicht installiert: `brew install ffmpeg` (bringt libass für Untertitel mit).

SRT aus der VTT neu erzeugen, nachdem die VTT fertig ist:

    ffmpeg -y -i pitch/captions/backup-video.de.vtt pitch/captions/backup-video.de.srt

Einbrennen, weiße Schrift auf schwarzem Kasten, gut lesbar im Saal:

    ffmpeg -y -i pitch/media/backup-video-clean.mp4 \
      -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,subtitles=pitch/captions/backup-video.de.srt:charenc=UTF-8:force_style='FontName=Helvetica,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=6,Shadow=0,MarginV=40'" \
      -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p \
      -c:a aac -b:a 192k -movflags +faststart \
      pitch/media/backup-video.mp4

Prüfen: Video ohne WLAN abspielen, Untertitel ganz sichtbar, Tonsignal in Shot 5 klar.

Weil die Untertitel eingebrannt sind, ist die Spur im Deck standardmäßig aus. Sonst stehen sie doppelt da.

## PDF neu exportieren

    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
      --no-pdf-header-footer --virtual-time-budget=3000 \
      --print-to-pdf=pitch/deck/Doorway-Pitch.pdf "file://$PWD/pitch/deck/index.html"

Chrome hängt danach manchmal: nach ein paar Sekunden mit `pkill -f "Google Chrome --headless"` beenden.
Im PDF erscheinen die Filmfenster als Hinweistext, nicht als Bild.

## Kontrast neu prüfen

    python3 pitch/deck/contrast.py

## Timing neu rechnen

    python3 pitch/wordcount.py
