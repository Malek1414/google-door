#!/usr/bin/env python3
"""WCAG 2.x contrast ratios for every colour pair used in pitch/deck/index.html.

Run: python3 pitch/deck/contrast.py
Text needs 4.5:1 for AA and 7:1 for AAA. Non-text graphics (chart marks, borders)
need 3:1 (WCAG 1.4.11). Colour never carries meaning alone in the deck: every
coloured mark also has a text label and a distinct fill (solid, hatched, outline).
"""

PAIRS = [
    # (what, foreground, background, kind)
    ("Text: ink on paper",                  "#111111", "#FFFFFF", "text"),
    ("Text: muted (source lines) on paper", "#444444", "#FFFFFF", "text"),
    ("Text: white on film placeholder",     "#FFFFFF", "#1A1A1A", "text"),
    ("Text: ink on facade band (slide 4)",  "#111111", "#E6E6E6", "text"),
    ("Mark: step-free fill on paper",       "#0A4A9E", "#FFFFFF", "graphic"),
    ("Mark: not step-free hatch on paper",  "#9B1C1C", "#FFFFFF", "graphic"),
    ("Mark: unknown outline on paper",      "#595959", "#FFFFFF", "graphic"),
]


def lum(hex_colour):
    h = hex_colour.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    r, g, b = out
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


if __name__ == "__main__":
    ok = True
    for what, fg, bg, kind in PAIRS:
        r = ratio(fg, bg)
        if kind == "text":
            verdict = "AAA" if r >= 7 else "AA" if r >= 4.5 else "FAIL"
        else:
            verdict = "pass (>=3:1)" if r >= 3 else "FAIL"
        ok &= "FAIL" not in verdict
        print(f"{r:5.2f}:1  {verdict:13s} {what}  ({fg} on {bg})")
    raise SystemExit(0 if ok else 1)
