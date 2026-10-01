# ADR 0191 — Copy and paste a component

Status: accepted. Kodjo's calls: Unity's component menu on a right-click; the copy kept in this tab only; a paste
carrying another game's asset refused, with why.

## Context

A component's menu was its ⋯ button, with Reset, Move and Remove. There was no way to take one component's values
to another object, or to give an object a copy of a component, short of setting every field by hand.

## Decision

- **A right-click on a card's header opens its menu**, where the pointer is — Unity's.
- **Copy Component, Paste Component As New, Paste Component Values**, on every component card and the Transform.
  Values go onto the same type only, onto each selected object's matching component; As New adds the copy to each
  selected object that may take it, greyed with the reason when none can. One edit either way.
- **The copy lives in the Inspector**: this tab, across selections, levels and prefabs, and nowhere else.
- **Another game's asset in a copy refuses the paste**, naming the field — the rule a dropped asset already meets.
  References to objects go as they are, as Unity's do.

## Rejected

- **A copy shared across tabs.** Kodjo's call: this tab only, for now.
- **Pasting with the refused asset left empty.** Kodjo's call: refuse, and say why.
