# Agent Clarification Loop

The clarification agent sits between raw world drawings and game patches. Its job is to help a draft become a valid Doodle Smash-style world, not to silently mutate the game.

## Inputs

- World ID.
- Room ID.
- Capture version.
- Canonical drawing snapshot.
- Derived projection data.
- Current world name/status.
- Current map/mode context, if selected.
- Natural-language user brief.
- Current capability contract.

## Outputs

- Candidate objects.
- Accept/reject/ask classification.
- Clarifying questions.
- User answers.
- Validation status.
- Scene plan.
- Later, an approved patch proposal.

Initial world validity requires:

- at least one platform;
- two spawn points;
- required characters.

## Candidate Types

Initial candidate types:

- platform;
- pass-through platform;
- spawn;
- cannon;
- trampoline;
- portal pair;
- breakable platform;
- decor/background note;
- character sketch;
- gameplay rule/mode note;
- unsupported/unknown.

## Accept / Reject / Ask

**Accept** when the drawing/request maps clearly to existing game data.

Example: a horizontal rectangle labeled "platform" can become a platform candidate.

**Reject** when the request is unsupported and cannot be approximated cleanly.

Example: "make water physics" is not currently supported.

**Ask** when the answer materially changes the build.

Good questions:

- "Should this platform be solid, pass-through, or bouncy?"
- "Should this circle be a spawn point?"
- "Should this curved bridge be approximated with rectangles?"
- "Is this drawing Player 1, Player 2, decoration, or a hazard?"
- "Should this object hurt players or just sit in the background?"

Bad questions:

- "Tell me more."
- "What do you want?"
- "Should I make it fun?"

## Scene Plan

Before patching, the agent should produce a scene plan:

- title/name;
- validation status;
- missing requirements;
- selected mode, if known;
- map target;
- platforms and gimmicks;
- spawns;
- character definitions;
- settings;
- unsupported requests;
- approximations;
- unresolved questions.

The user must approve the scene plan before Phase 3 patching.

Questions should appear on the iPad/draw-client creation surface because that is the authoring surface. Voice may be added later if latency is acceptable, but quick tap choices should remain available.

## Version Safety

Questions and answers must reference the capture/projection version they came from. If the drawing changes after questions are generated, answers should not silently apply to stale candidates.
