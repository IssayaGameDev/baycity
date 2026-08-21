## Design, closed

**Platform.** Three.js, HTML5 web, Poki and CrazyGames. Desktop and mobile web both first-class. Audience 7 to 15, minimal text, visual teaching. Small rooms, server-side save, no offline progression.

**Shape.** Two areas. A base at ground level, one shared tower per room above it. Players are visible to each other on the tower, so vertical position is the leaderboard with no UI. Blocks are solid only for their owner and render as ghosts to everyone else.

**Loop.** Climb the trunk. Gaps stop you. Place blocks from your bag to cross them. Collect gems on contact from the tower walls. Descend, bank, buy, go back up. Controlled descent banks the full bag, uncontrolled falling costs a fraction of it.

**Blocks.** Consumables that change the world. Bought at the base every run, so they're rent. Placement is permanent. Blocks stack, with a chain cap of 5 to 10, and every chain must start from an authored anchor surface. Anchor placement is the difficulty language: sparsity plus the block types a given anchor suits is how each gap is tuned. Anchors read identically everywhere and are the only vocabulary the player must learn.

Progression is vocabulary, never magnitude. New kinds of gap need new kinds of block. Access to every block type is deterministic at a known price. No randomness anywhere in the game.

Vocabulary: plank, long plank, bouncy, sticky, ice, fan, spring, rope anchor, and the elevator as a very expensive type that connects points already reached rather than opening new ones.

**Bag.** One capacity shared by blocks and gems. Every run is a loadout decision: altitude, income, or branch exploration. Bag size is the only stat upgrade, and stats are a sink, never a gate.

**Gems.** Embedded in walls, collected on contact, positions randomised within a section, respawning. Value scales with altitude steeper than block costs, so cleared sections go economically worthless and grinding low is never optimal.

**Base.** Deposit, buy blocks, unlock block types, buy bag size. The unlock tree is spatial rather than a menu, walked rather than clicked. Visits last seconds.

**Branches.** Three, total. Sprint early, glider mid, jetpack last. Entry is unlocked by spending. Each is a short bonus route with a permanent body ability at the end. Abilities change your body, blocks change the world, and that line never blurs. The jetpack is fuel-limited.

**Monetisation.** Rewarded video only, since Poki bans IAP. Ads may substitute for economy progress by design. No progress is ever gated on an ad being available, since fill rates fail.

**Cut for good.** Gacha, idle and offline accrual, automated workers, PvP and physical theft, stats as gates, blocks scaling by strength, chat, dropping the base, shared blocks between friends.

**Open, all tuning rather than structure.** The rent ratio of block cost to gem income, which is the single most load-bearing number in the game. Chain cap value. Gem respawn timer. Ghost block visibility mode. Free-aim or grid snap placement. Whether placed blocks can be recovered. Persistence path, Poki username and password versus the CrazyGames token. Exact room size.

**Accepted risks, acknowledged and set aside.** No pressure mechanic anywhere. Nothing measures time, so re-optimising solved sections has no economic reward. Difficulty is largely a function of owning the right block. Multiplayer contributes atmosphere only and carries server cost with no mechanical return. Theme undecided.                                                                                                                                                                                                                  