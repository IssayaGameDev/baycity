# ADR 0198 — The assistant writes sequences, and adds only the game's components

Status: accepted. Kodjo's calls: the instructions do not say objects have no physics — they do, through their
colliders, and a Rigidbody is coming — but that only the components the game lists exist.

## Context

Asked for a ball that bounces, the assistant reached for Unity's Rigidbody, then Animator, put a Bumper on the ball
and said it would bounce, then found a Sequence's steps were not something an action could set (ADR 0194 left them
out), set a loop on an empty sequence, and told the person to add keyframes — which this editor does not have.

## Decision

- **`set_sequence_stages`** writes a Sequence's stages whole, through the Inspector's own `setSequenceStages`. Its
  tool input spells out every step kind, timing and ease; ids are minted where none is given, a target is a child's
  object id; the content's `stagesProblem` checks it all. `get_object` reads a target back as the object id.
- **An action's tool input can follow the open document** (`inputFor`): `add_component` offers the game's own
  component types as the only ones there are, so a name from another engine is not one to choose.
- **`ASSISTANT-EDIT.md`**: only listed components exist; motion is a Sequence; ask when unclear; say so before
  changing anything when the tools cannot do it; claim nothing about the game the docs do not say.

## Rejected

- **"Objects have no physics" in the instructions**: false, and the Rigidbody to come would make it falser.
- **Stages through `set_component_fields`**: a placement's copy of a sequence is an override worked out by diffing,
  which only `setSequenceStages` does.
