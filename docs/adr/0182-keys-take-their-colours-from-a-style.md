# ADR 0182 — Keys take their colours from a style, and letters can face four ways

Status: accepted. Continues ADR 0181 (data assets): Keyboard Style's real fields, and the backend they needed.

## Context

A board was a grid of identical keys. Kodjo wants variation between them, from a look shared by many boards, and to
choose which way the letters face, forward by default.

## Decision

- **A `list` field kind**: rows, each with its own fields — Unity's serialized array of a struct — read and defaulted
  row by row; and **optional colours**, `''` meaning auto. The Inspector draws a list as rows with add, remove and
  drag to reorder, on components and data assets alike.
- **Keyboard Style** holds **key colours** — rows of a cap colour, a letter colour and a weight (Kodjo: a key's letter
  complements its cap, so they come as a pair, like a keycap set) — and a **shade jitter**. A letter left on auto
  takes whichever of a dark and a light ink contrasts more with the cap. Each key picks a row by weight; a hash of the
  board's letter seed and the cell decides, so every player sees the same board and it never reshuffles (no cost
  beyond a hash per key, kept for that).
- **Drawn as a stencil**: the letter texture is a mask and each cap carries its two colours as instance attributes,
  mixed in the shader — no extra draw call for any palette.
- **Letters face** forward, right, back or left, on the Keyboard surface (Kodjo: per board, four ways): the cap turns
  a quarter at a time about its board's up; a cap is square, so only the letter shows it. Right is the node's red +X.

## Rejected

- **A plain colour list with one letter colour.** A letter that reads on one cap vanishes on another.
- **Facing in the style.** Which way letters face depends on how a board sits in its level; a style is shared.
- **A free angle.** On a grid of square keys, anything but a quarter turn reads as crooked.
