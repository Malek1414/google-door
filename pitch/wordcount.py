#!/usr/bin/env python3
"""Count spoken words per beat in pitch/script.md and estimate seconds at 130 wpm.

Spoken text = plain paragraphs between a "## <n>." heading and the next heading.
Skipped: headings, "**Folie n**" markers, [stage directions], tables, lists.
Run: python3 pitch/wordcount.py
"""
import re
from pathlib import Path

WPM = 130
WINDOWS = {1: 25, 2: 35, 3: 75, 4: 25, 5: 20}  # seconds, from BRIEF-PITCH.md
OPTIONAL_CODE = "Für unsere eigene Uni gab es keine Daten. Wir haben sie in zwanzig Minuten vermessen."

text = (Path(__file__).parent / "script.md").read_text(encoding="utf-8")
beats, cur = {}, None
for line in text.splitlines():
    m = re.match(r"^## (\d)\. ", line)
    if m:
        cur = int(m.group(1)); beats[cur] = []; continue
    if line.startswith("## ") or line.startswith("---"):
        cur = None; continue
    if cur is None:
        continue
    s = line.strip()
    if not s or s.startswith(("[", "**Folie", "|", "#", "-", "1.", ">")):
        continue
    beats[cur].append(s)

total_w = total_s = 0
for n in sorted(beats):
    words = len(" ".join(beats[n]).split())
    sec = words / WPM * 60
    total_w += words; total_s += sec
    print(f"beat {n}: {words:3d} words  {sec:5.1f} s  of {WINDOWS[n]} s  rest {WINDOWS[n]-sec:5.1f} s")
opt = len(OPTIONAL_CODE.split())
print(f"total : {total_w} words  {total_s:5.1f} s of 180 s")
print(f"optional CODE line: +{opt} words, +{opt / WPM * 60:.1f} s")
