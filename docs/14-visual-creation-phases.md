# Visual Creation Phases

Magic Board adds a required creation phase in front of the existing Doodle Smash game. The desktop entry point is a Game Library; if no worlds exist, the user starts by creating a first game world on the iPad/draw-client before play is available.

For now, a "level" and a "game world" mean the same thing: one Smash-style playable Doodle Smash level. Later, a world can own richer rules, pickup behavior, projectile behavior, hazards, asset polish, and custom mechanics.

## Phase 1: Drawing Bridge

Goal: drawings from an iPad or browser appear on the laptop game canvas while the drawing surface shows a static, platform-only reference of the level.

The user journey:

1. Laptop opens the Doodle Smash game scene.
2. iPad or laptop opens a drawing surface in the same room.
3. Drawing surface displays only gameplay-relevant platforms in a fixed 1920 x 1080 frame.
4. User draws rough platforms, character ideas, arrows, labels, or gameplay notes over that static reference.
5. Backend stores the canonical drawing and a derived projection.
6. Laptop game renders the projection in the scene's world layer, so it moves with camera pan/zoom.
7. No game data is mutated.

Phase 1 proves spatial communication. It is successful when the user can draw on top of a stable platform reference and see the drawing aligned with the laptop game scene, attached to the same world coordinates as the platforms.

The iPad reference should not be a second live match. It should not show timers, fighters, effects, projectiles, countdown, HUD, or dynamic camera movement.

## Phase 1.5: World Library And Required Creation Entry

Goal: creation becomes the required front door before play.

The desktop user journey:

1. Desktop opens to the Game Library, not straight into a match.
2. If no worlds exist, the only primary path is "Create your first game".
3. Creating a world assigns a default name such as `Untitled 1`.
4. The iPad/draw-client is the authoring surface for doodling platforms, spawn points, and characters.
5. The library shows saved draft/ready worlds as drawn thumbnails.
6. `Play` is blocked until the world is valid.
7. `Edit Level` reopens the iPad open-canvas creation surface.
8. `Live Edit` is future-facing and should remain inert or disabled until implemented.

Initial validity is intentionally small:

- at least one platform;
- two spawn points;
- required characters.

Game rules are not part of Phase 1.5. They should be added later as world-owned behavior once the library and basic creation lifecycle are stable.

## Phase 2: Contextual Clarification Agent

Goal: an agent turns messy drawing intent into a valid world draft and clear scene plan.

The agent reads:

- latest drawing capture;
- derived projection;
- current game capability contract;
- current world context;
- user natural-language brief.

The agent outputs:

- accepted supported candidates;
- rejected unsupported requests;
- concrete clarification questions;
- validation state;
- a scene plan once enough information exists.

The agent should ask bounded, contextual questions. It should not ask vague "what do you want?" questions when it can ask "solid, pass-through, or bouncy?", "is this Player 1, Player 2, or decoration?", or "should this circle be a spawn point?".

Agent questions should appear on the iPad/draw-client creation surface. Voice may be added later if latency is acceptable; quick tap choices should remain available as a fallback.

## Phase 3: Build Playable World

Goal: approved, valid world drafts become playable game data.

The agent emits typed domain patches. The vanilla game validates and applies them through a small facade. Patches target existing seams:

- `DS.Maps.stageFor(...)`;
- `stage.platforms`;
- `stage.spawns`;
- `stage.portals`;
- `stage.decor`;
- `stage.bg`;
- `DS.Store.data.settings`;
- character skin/stats/pose data where supported.

The user can preview, accept, reject, and playtest.

## Phase 4: World Rules

Goal: worlds define game behavior beyond the first basic Smash-style level structure.

World-owned rules may include:

- mode selection;
- projectile availability;
- pickupable items;
- hazards;
- score/win conditions;
- roster constraints;
- supported gimmick toggles.

Rules should stay constrained to existing game capabilities first. Arbitrary new mechanics should wait until typed rule patches and validation are reliable.

## Phase 5: Asset Enhancement

Goal: rough doodles become polished in-game assets without breaking the visual identity.

Enhancement output should stay compatible with the current game model:

- procedural `DS.draw` code;
- skin stroke JSON;
- decor/background records;
- stage/platform style metadata;
- WebAudio recipes;
- pose/action tuning.

Asset enhancement is proposal-first. Generated assets are previewed before being applied.

## What This Is Not

This is not a generic game engine builder. The first target is making levels for the current Smash-style platform fighter. New mechanics can be added later, but the initial creation system should be excellent at building what the current game can already play.
