# ADR 0063 — Animation is the game's

Status: accepted. `ModeDescriptor.gait` and `ModeDescriptor.animator` are the seam; nothing was added to
`AnimationInput`.

## Context

ADR 0061 made locomotion a component a game attaches. The question that followed was Kodjo's, and it is the
one that matters: a game wants the humanoid rig and the shared movement, plus a dash *with its own dash
animation*. The dash itself was already buildable — an action binding, a player component, `character.push`.
The animation was not, for three reasons:

- `AnimationInput` is six fields — `yaw`, `speed`, `vy`, `grounded`, `rising`, `carry` — all derived from
  `stepCharacter`. Nothing could say "I am dashing".
- `bipedGait.ts` has walk, run, idle, rise and fall and no way to add a sixth without editing a file every
  humanoid game shares. Exactly where locomotion was.
- `createCharacterViews` called `createAnimator` directly, so a game could not supply its own animator at all.

And `gait` was one object for every game on the platform — live on the debug pane, reachable by nobody else.
That hole has been open since ADR 0056 and was quoted at twenty minutes each time it came up.

## Decision

**A game supplies its gait and, if it wants, its whole animator.**

`ModeDescriptor.gait?: GaitTuning` retunes the shared cycle. Absent keeps the shipped numbers. The host copies
it, because that copy is what the debug pane binds and what every animator reads fresh each frame — the
descriptor's own object must not be mutated out from under a second session.

`ModeDescriptor.animator?: AnimatorFactory` replaces the cycle. `AnimatorFactory` is
`(gait, seed) => Animator`, which is `createAnimator`'s own signature, so **the default is the function
itself** rather than a second implementation of it. Called per character, because the seed is what stops two
players rolling the same sequence of steps.

`Animator` was already a one-method interface (`step(input, dt) => Pose`), so a game implements or wraps it
with no change to the humanoid package.

### Nothing was added to `AnimationInput`

This is the decision worth recording, and it is ADR 0061's trick applied a second time. The obvious move is to
widen `AnimationInput` with a state name or a flag bag so a game can say "dashing". It is unnecessary: the
factory is the **game's own code**, so it closes over the game's own state directly — the dash component's
flag is right there.

So the platform never carries a value it cannot interpret, and the shared cycle's input stays exactly the six
things the shared controller produces. The expected shape, which the template documents:

```ts
animator: (gait, seed) => {
  const shared = createAnimator(gait, seed)
  return { step: (input, dt) => (dashing ? dashPose() : shared.step(input, dt)) }
}
```

**The cost is that such a state is local only.** Component state is not serialized (ADR 0059), so a peer's
dash reads as an ordinary run until whatever it does goes on the wire. That is the same limit ADR 0061 records
for abilities, and it is the honest price of not inventing a protocol field for a state the platform does not
understand.

## Consequences

- A game can retune the biped's feel, or animate it entirely differently, without touching a shared file.
- Six tests on the seam: the supplied factory being used, built once per character with distinct seeds, handed
  the host's live gait object, wrapping-and-overriding, and the default still being the shared cycle.
- `modes/_template` documents the wrapping shape beside `playerDefs`, since it is the seam a new game is least
  likely to find on its own.
- No behaviour changed. Every shipped game omits both fields, so all three animate exactly as before.

## Rejected

**Widening `AnimationInput`.** See above — the closure makes it unnecessary, and a `Record<string, boolean>`
on a platform type would be a bag the platform cannot reason about.

**Adding dash states to the shared gait.** It would put one game's move in every game's animator, which is the
thing this ADR exists to stop.

**A pose *post-processor* rather than a whole animator** — `(pose, input) => pose` layered over the shared
cycle. Tempting, and it covers overriding but not replacing: a game whose avatar is not a biped needs the
whole thing, and two seams for one subject is worse than one that can do both. Wrapping already gives the
post-processor shape for free.

**Making the gait a component's params.** Same reason locomotion's tuning is not (ADR 0061): the pane binds
the live object, so params would be a second source and they would drift.

## Known open

- **The editor's play-test does not animate at all.** It draws a plain capsule mesh, not the rig — so a
  game's animation cannot be judged there even now that its camera and locomotion can be. That is its own
  piece of work and this ADR does not touch it.
- **A peer's game-specific state is invisible**, as above.
- **`render-three/characterRig.ts`** still realizes this one rig under a general name (ADR 0062's last note).
- **The rig itself is still not a game's choice.** A game can animate the biped differently; it cannot supply
  a different skeleton. That is the next layer down, and it needs the client to stop creating the body
  (ADR 0061).
