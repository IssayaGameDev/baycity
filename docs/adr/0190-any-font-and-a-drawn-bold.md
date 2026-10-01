# ADR 0190 — Any font, and a drawn bold

Status: accepted. Amends ADR 0189 (text). Kodjo's calls: a Text takes any font; bold is one way, drawn, for every
font — Roboto included.

## Context

ADR 0189 shipped Roboto regular and bold and nothing else: a Text component that could only write in Roboto. A font
file holds one weight, so an uploaded font's bold would need a second file — or a bold box that did nothing.

## Decision

- **A `font` field** on `Text`: any uploaded font asset; none is Roboto. The game and the editor hand its file's
  address to the text library, which fetches it — the level's needs list already carries any asset a level names.
- **Bold is drawn, always**: each letter's edge widened in the text's own colour by 0.017 of the font size — measured
  to ink Roboto as its own Bold file does. One file per font; the Roboto Bold file is gone.
- **A woff2 is refused**: the text library reads TTF, OTF and WOFF. Upload takes those three as fonts and not a
  woff2; the field's picker leaves a woff2 out and a drop says to convert it; one that slips through draws in Roboto.

## Rejected

- **Real bold when a bold file exists, drawn otherwise.** Kodjo's call: one way, not two.
- **A second "bold font" field.** Two files a font for one look.
- **Converting woff2 on upload.** Its own job.
