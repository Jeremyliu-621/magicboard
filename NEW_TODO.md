# NEW TODO: Phase 1 VLM-Guided Stage Object Creation

Phase 1 goal: from the desktop Game Library, the user opens a level editor, draws over the active stage on the iPad, and the system turns each doodle into a playable game object. Supported objects for this phase are:

- platform;
- cannon;
- spikes;
- portal pair.

The VLM classifies intent. Deterministic code owns geometry and creates the final game data.

## Phase 1 End State

At the end of Phase 1, this should work:

- [x] Open the desktop game/library.
- [x] Click `Edit Level` on a world.
- [x] The desktop enters the MagicBoard/iPad editing flow for that world.
- [x] The iPad connects automatically to the active world room.
- [x] The iPad shows the current stage as the drawing reference.
- [x] User draws a doodle over the stage.
- [x] The backend groups the recent drawing into a candidate.
- [x] A background VLM worker classifies that candidate as platform, cannon, spikes, portal endpoint/pair, or unknown.
- [x] Deterministic constructors convert accepted classifications into real stage objects.
- [x] The desktop editor previews those proposed objects.
- [ ] User accepts/corrects/ignores them through first-class desktop controls.
- [x] Accepted/high-confidence objects are saved into the world stage.
- [x] Clicking `Play` starts a match using the updated stage.

## Current Repo Reality

### Desktop/Game/Editor

- `Edit Level` currently opens the legacy Stage editor, not the iPad/MagicBoard flow:
  - `js/worldLibrary.js` card button calls `options.onEdit`.
  - `js/main.js` wires that to `enterWorldStageEditor(world)`.
  - `enterWorldStageEditor` calls `editor.editWorldStage(world)`.
- The older iPad bridge still exists as `DS.LevelPreview`, but it is no longer reachable from the library `Edit Level` flow.
- `DS.LevelPreview.enter(world, ...)` publishes the active backend room selection, which is why the iPad waiting screen only works when LevelPreview is active.
- World records live in `magicboard:worlds:v1`.
- Playable stage data lives in `DS.Store.data.stages` under `doodle-smash:data:v3`.
- `DS.Maps.ensureCustomStage(data, world)` creates a custom world stage, but it is mostly one-way. Later `world.draft` changes do not automatically overwrite an existing stage.
- `Play` already uses `DS.Maps.stageFor(data, mapId)` through `Game.rebuild()`, so once objects are saved into the world stage, gameplay will use them.
- Current world readiness can report a new empty world as ready because platform existence is no longer checked.

### Existing Deterministic Outputs

The game already knows how to render/play these objects:

- Platform:
  - stored in `stage.platforms[]`;
  - shape: `{ x, y, w, h, kind, pass }`.
- Cannon:
  - stored in `stage.platforms[]`;
  - shape: `kind: "cannon"` plus `fire: { deg, every, speed, damage, kbBase, kbScale, r, delay }`.
- Spikes:
  - stored in `stage.platforms[]`;
  - shape: `kind: "spikes"` plus `hurt: { damage, kbBase, kbScale, cooldown }`.
- Portal:
  - stored in `stage.portals[]`;
  - always two linked endpoint records;
  - each endpoint shape: `{ id, link, x, y, r, col }`.

Current `js/magicBoardGame.js` can build/apply platform, cannon, and spikes through platform candidates. It does not yet support portal patch operations.

### iPad/Backend/VLM

- `draw-client/src/App.jsx` sends full tldraw capture/projection over WebSocket after a short debounce.
- The iPad can connect by explicit `?room=...` or by listening to backend `/ws/selection`.
- Backend `RoomRegistry.store_capture` stores capture/projection, increments room version, and builds a semantic draft.
- `backend/app/semantic.py` currently extracts platform-shaped candidates:
  - clear rectangles;
  - horizontal strokes;
  - grouped aligned strokes.
- VLM currently observes the whole projection image, not a candidate crop.
- `_schedule_visual_observation` creates a task per capture. There is stale rejection, but not a real candidate-level queue.
- VLM hints can auto-confirm candidates by matching `sourceIds`.
- Current semantic schema supports platform behaviors, including cannon and hurt/spikes. It does not yet model portal endpoints or portal pairs.

## Required Phase 1 User Flow

### Desktop

1. User opens:
   - desktop game/library;
   - backend;
   - iPad draw client.
2. User clicks `Edit Level` on a world.
3. Desktop enters the MagicBoard stage editing flow, not the disconnected legacy-only editor flow.
4. Desktop publishes backend selection:
   - `roomId`;
   - `worldId`;
   - `worldName`;
   - active stage reference/snapshot.
5. Desktop renders proposed and accepted objects over the stage.
6. Desktop exposes simple actions:
   - accept proposed object;
   - correct classification;
   - ignore/delete proposed object;
   - play stage.

### iPad

1. iPad connects to the selected world room.
2. iPad shows the active stage reference, not the empty static `stageReferenceData`.
3. User draws freely. There are no explicit object buttons for Phase 1.
4. Drawing stays responsive while VLM work happens in the background.
5. Candidate outlines/proposed classifications can appear as overlays.

### Backend

1. Receives capture/projection updates.
2. Detects the recently changed source IDs.
3. Builds or updates one active candidate at a time.
4. Enqueues candidate classification work.
5. Coalesces updates for candidates that are still changing.
6. Sends candidate crops to the VLM.
7. Applies only fresh VLM results.
8. Updates semantic objects.
9. Emits semantic/object preview updates to desktop and iPad.

## Semantic Flow

```text
raw iPad strokes
  -> deterministic candidate evidence
  -> candidate-level VLM classification
  -> semantic object
  -> deterministic game-object constructor
  -> typed stage patch
  -> saved playable stage
```

Definitions:

- Candidate: geometry/evidence derived from raw drawing.
- Semantic object: the interpreted intent, still editable.
- Stage object: actual playable game data in `stage.platforms[]` or `stage.portals[]`.

Candidate metadata must include:

- `candidateId`;
- `candidateVersion`;
- `sourceIds`;
- `geometry`;
- `geometryHash`;
- `captureVersion`;
- `extractor`;
- `status`;
- optional `classification`.

Semantic object types for Phase 1:

- `semantic_platform`;
- `semantic_cannon`;
- `semantic_spikes`;
- `semantic_portal_endpoint`;
- `semantic_portal_pair`;
- `semantic_unknown`.

## One-At-A-Time Real-Time Loop

The system should not wait for the whole scene to be finished. It should process the most recent doodle as the unit of work.

```text
stroke burst starts
  -> active candidate updates locally
  -> user pauses briefly
  -> candidate version freezes
  -> candidate crop enters VLM queue
  -> user keeps drawing
  -> VLM result returns later
  -> stale result is accepted or discarded
```

Implementation rules:

- Drawing is never blocked by VLM.
- Candidate extraction is fast and deterministic.
- VLM classification is background work.
- Queue unit is a candidate or candidate group, not the whole scene.
- Reclassify a candidate only when its `candidateVersion` changes.
- If a newer candidate version exists, discard the old VLM result.
- If the user manually corrects a candidate, future VLM results must not overwrite it.

## Candidate Grouping

Phase 1 grouping should be conservative and deterministic first, with VLM used for classification, not geometry creation.

Signals:

- source IDs from tldraw;
- recent changed source IDs;
- temporal stroke burst;
- spatial proximity;
- shape type;
- color/tool continuity;
- nearby labels;
- existing candidate membership.

Initial grouping rules:

- One clear rectangle or horizontal stroke burst -> platform-like candidate.
- Several close, aligned horizontal strokes in one burst -> one platform candidate.
- Compact doodle near/on a platform -> possible cannon or spikes candidate.
- One circle/oval -> possible portal endpoint candidate.
- Two circle/oval candidates -> possible portal pair, even if far apart.
- If uncertain, keep candidates separate and ask/correct later.

Portal exception:

- A portal is drawn as two circles.
- One circle creates a pending portal endpoint.
- The second compatible circle completes a portal pair.
- The two circles can be far apart.
- Pairing can use:
  - draw order;
  - matching color;
  - matching size;
  - labels;
  - user confirmation.

## VLM Input Strategy

Do not rely on whole-scene classification.

For each queued candidate, render:

- candidate crop with padding;
- highlighted candidate mask/outline;
- nearby context crop;
- optional small whole-stage thumbnail;
- metadata:
  - `candidateId`;
  - `candidateVersion`;
  - `sourceIds`;
  - bounds;
  - nearby labels;
  - capture version.

For portal pairing, the VLM may receive:

- one endpoint crop for endpoint classification;
- a two-crop/contact sheet for pair classification;
- a small whole-stage thumbnail so far-apart endpoints still have context.

Expected VLM response:

```json
{
  "candidateId": "candidate-abc123",
  "candidateVersion": 4,
  "sourceIds": ["shape:xyz"],
  "class": "cannon",
  "confidence": 0.86,
  "needsQuestion": false,
  "question": null,
  "reason": "compact cannon-like doodle on a ledge"
}
```

Allowed classes:

- `platform`;
- `cannon`;
- `spikes`;
- `portal_endpoint`;
- `portal_pair`;
- `unknown`;
- `ignore`.

## Queue/Parallelization Requirements

Add a candidate-level coalescing queue.

Required behavior:

- Per room, keep a queue of candidate classification jobs.
- Allow drawing/capture updates to continue while jobs run.
- Coalesce duplicate queued jobs for the same candidate.
- Replace queued stale candidate versions with the latest candidate version.
- Limit active VLM work:
  - per room: likely 1 active job at a time for predictable ordering;
  - globally: small worker limit, such as 2-3 concurrent VLM requests.
- Prioritize:
  - currently active/recent candidate;
  - visible unclassified candidates;
  - portal endpoint pairing jobs after endpoint classification.
- Drop stale results by `roomId`, `captureVersion`, `candidateId`, and `candidateVersion`.
- Never overwrite manual corrections.

## Deterministic Constructors

VLM output maps to deterministic constructors:

- `platform` -> `makePlatform(candidate)`.
- `cannon` -> `makeCannon(candidate)`.
- `spikes` -> `makeSpikes(candidate)`.
- `portal_endpoint` -> `makePortalEndpoint(candidate)`.
- `portal_pair` -> `makePortalPair(endpointA, endpointB)`.

Constructor outputs:

- `makePlatform` creates `stage.platforms[]` record.
- `makeCannon` creates `stage.platforms[]` record with `kind: "cannon"` and default `fire`.
- `makeSpikes` creates `stage.platforms[]` record with `kind: "spikes"` and default `hurt`.
- `makePortalPair` creates two linked `stage.portals[]` records.

Constructors must be pure and deterministic. They should not call VLM or inspect pixels.

## Typed Patch Contract

Extend `js/magicBoardGame.js` beyond platform-only patches.

Current ops:

- `replace_platforms`;
- `add_platform`;
- `set_spawns`.

Needed ops:

- `add_platform`;
- `remove_generated_object`;
- `add_portal_pair`;
- `set_portals` or `replace_portals` if needed;
- optional `replace_generated_objects` instead of wiping all manual platforms.

Important: current `Apply Platforms` can use `replacePlatforms: true`, which wipes existing platforms. Phase 1 should avoid wiping manually edited stage content unless the user explicitly requests reset.

## Implementation Steps

### 1. Fix Desktop Entry And Room Selection

- [x] Decide final Phase 1 editing entry: `Edit Level` should open MagicBoard/iPad stage editing.
- [x] Wire `worldLibrary.onEdit` to the MagicBoard editing flow, not legacy-only `enterWorldStageEditor`.
- [x] Keep legacy Stage editor accessible separately if still needed.
- [x] On entering MagicBoard editing, publish backend selection for the active world.
- [x] Make desktop and iPad URLs deterministic:
  - backend URL;
  - draw client URL;
  - room ID;
  - world ID;
  - world name.
- [ ] Add tests/smoke coverage that `Edit Level` publishes selection and the iPad does not stay on waiting.

### 2. Send Active Stage Reference To iPad

- [x] Add backend selection state for active stage reference/snapshot.
- [x] Include stage bounds, existing platforms, existing portals, and spawns.
- [x] Update draw-client to render the active stage reference instead of static empty `stageReferenceData`.
- [ ] Update stage reference whenever the desktop changes the active world/stage.
- [ ] Ensure coordinates match world/stage coordinates for large maps, not only 1920x1080 screen space.

### 3. Make World Stage The Source Of Truth

- [x] Decide whether world `draft` or `DS.Store.data.stages[worldId]` owns stage objects.
- [x] For Phase 1, prefer `DS.Store.data.stages[worldId]` as the playable source.
- [x] Sync world library status/thumbnail from the actual stage.
- [x] Fix readiness so a world needs at least one playable platform or accepted stage object.
- [x] Ensure `Play` always uses the same stage objects the editor shows.

### 4. Add Candidate Tracking

- [x] Track changed source IDs from each iPad capture.
- [x] Add candidate versioning.
- [ ] Keep candidate records in backend room state.
- [x] Distinguish raw evidence candidates from semantic classifications.
- [ ] Add candidate statuses:
  - `active`;
  - `queued`;
  - `classifying`;
  - `classified`;
  - `needs_confirmation`;
  - `accepted`;
  - `ignored`;
  - `stale`.
- [x] Preserve candidate provenance for generated stage objects.

### 5. Improve Candidate Extraction And Grouping

- [x] Keep existing rectangle/horizontal stroke platform extraction.
- [ ] Add stroke-burst grouping around recent source IDs.
- [x] Add circle/oval detection for portal endpoints.
- [x] Add compact glyph detection for possible cannon/spikes.
- [x] Add two-endpoint portal pair grouping:
  - same/near draw time;
  - matching color;
  - compatible size;
  - pending unmatched endpoint list.
- [x] Keep grouping conservative; prefer user correction over aggressive merging.

### 6. Add Candidate Crop Rendering

- [ ] Render a crop for one candidate with padding.
- [ ] Highlight candidate strokes/shapes in the crop.
- [ ] Include nearby context.
- [ ] Render a two-candidate contact sheet for portal pair checks.
- [ ] Include a small whole-stage thumbnail only as context.
- [ ] Store crop metadata with candidate ID/version/source IDs.

### 7. Add Candidate-Level VLM Queue

- [ ] Replace per-capture whole-scene VLM scheduling with candidate classification jobs.
- [ ] Add per-room coalescing queue.
- [ ] Add global worker limit.
- [ ] Coalesce jobs by candidate ID.
- [ ] Drop stale results by candidate version/capture version.
- [ ] Keep whole-scene observation only as optional debug/fallback.

### 8. Extend Backend Semantic Schema

- [x] Add semantic object classes:
  - platform;
  - cannon;
  - spikes;
  - portal endpoint;
  - portal pair;
  - unknown;
  - ignore.
- [x] Add portal endpoint/pair fields to schemas.
- [x] Add VLM response schema for candidate classification.
- [x] Preserve existing manual answer/clarification behavior.
- [ ] Ensure manual corrections override VLM output.

### 9. Update VLM Prompt And Parser

- [ ] Prompt model to classify only the highlighted candidate/candidate pair.
- [x] Make allowed classes explicit.
- [x] Ask for structured JSON only.
- [ ] Include `candidateId`, `candidateVersion`, and `sourceIds` in the response.
- [x] Add parser normalization:
  - "hazard", "teeth", "danger" -> `spikes`;
  - "gun", "turret", "shooter" -> `cannon`;
  - "circle", "wormhole", "teleporter" -> `portal_endpoint`;
  - "two portals" -> `portal_pair`.

### 10. Extend Deterministic Patch/Application

- [x] Keep platform/cannon/spikes platform output.
- [x] Add portal pair constructor.
- [x] Add `add_portal_pair` validation.
- [x] Add portal generated-source provenance.
- [x] Allow replacing/removing generated portal pairs by candidate IDs.
- [x] Avoid replacing all existing platforms by default.
- [x] Apply accepted semantic objects into `DS.Maps.stageFor(data, worldId)`.
- [x] Save through `DS.Store.save()`.

### 11. Build Desktop Preview And Acceptance UI

- [x] Preview classified candidates on the desktop stage.
- [ ] Show class label and confidence.
- [ ] Provide accept/correct/ignore actions.
- [ ] Corrections should update semantic object and prevent stale VLM overwrite.
- [ ] Portal endpoints should show pending state until paired.
- [x] Accepted objects should render using the actual deterministic stage renderer.

### 12. Update iPad Feedback

- [x] Show candidate outlines while drawing.
- [x] Show class/status once VLM result returns.
- [x] Keep interaction lightweight so iPad remains a sketch surface.
- [x] Do not require waiting for one object before drawing another.

### 13. Save And Play

- [x] Persist accepted objects into the active world stage.
- [x] Update library thumbnail/status from saved stage.
- [x] Verify Play uses updated platform/cannon/spikes/portal objects.
- [ ] Verify cannon firing, spike damage, and portal teleport all work in match.

## Phase 1 Acceptance Criteria

- [x] From the library, clicking `Edit Level` connects the iPad without manual room ID entry.
- [x] iPad shows the active stage reference.
- [ ] User can draw a platform; VLM/classifier identifies it; accepted object becomes playable platform.
- [ ] User can draw a cannon; VLM/classifier identifies it; accepted object becomes a firing cannon.
- [ ] User can draw spikes; VLM/classifier identifies them; accepted object damages players.
- [ ] User can draw two portal circles; VLM/classifier identifies endpoints/pair; accepted object teleports players.
- [ ] User can continue drawing while VLM jobs are still running.
- [x] Stale VLM results do not overwrite newer drawings.
- [ ] Manual corrections override VLM guesses.
- [x] Play uses the exact updated stage objects.
- [x] Existing manually edited stage objects are not wiped by applying new generated objects.

## Non-Goals For Phase 1

- No arbitrary code generation.
- No VLM-created geometry.
- No full-scene-only classification as the primary path.
- No final level balancing system.
- No broad object catalog beyond platform, cannon, spikes, and portal.
- No complex voice-agent planning loop yet.

# Phase 2: Voice-Agent-Powered Level Editing

Phase 2 goal: make the MagicBoard level editing stage voice-agent powered. The user should be able to draw and speak naturally while the system guides them through a deterministic creation flow:

1. Add or confirm platforms and level structure.
2. Enhance accepted platforms with supported effects such as bouncy, icy, damaging/spikes, cannon, breakable, pass-through, or portal.
3. Add characters and spawn locations.
4. Review and approve a concrete scene plan.
5. Launch the game immediately once playable requirements are met.

The intended architecture is:

```text
iPad/desktop microphone
  -> MagicBoard backend voice websocket
  -> Deepgram realtime speech transport
  -> final transcript
  -> OpenAI orchestration runtime
  -> typed MagicBoard tools
  -> semantic objects / proposals / patches
  -> desktop and iPad room updates
```

The voice agent is an orchestration layer over MagicBoard capabilities. It must not generate code, invent arbitrary game data, silently apply patches, template missing outputs, or insert fake fallback classifications/assets. If a required model, key, MCP server, tool, job, or permission is unavailable, the system must emit a typed error and ask the user to resolve it.

Phase 2 should be implementable autonomously in one focused pass once `OPENAI_API_KEY`, `MAGICBOARD_VLM_MODEL`, and `DEEPGRAM_API_KEY` are available in the backend `.env`. Do not block Phase 2 on Pika, external animation generation, or a future MCP integration. Pika moves to Phase 3.

## Current Phase 2 Starting Reality

### Backend

- Backend already has room capture, semantic draft, clarification answers, visual observation, and stub agent job support.
- `/agent/status` reports `deterministic_semantic`, `vlm_semantic`, and `voice`.
- Voice is not implemented:
  - `agent_runtime.py` marks voice deferred/missing key.
  - `make_stub_job` returns unsupported for `modality: "voice"`.
- Room state is in-memory and capture-driven in `backend/app/rooms.py`.
- WebSocket room messages only accept:
  - `canvas_capture`;
  - `clarification_answer`.
- Candidates are regenerated from projection on each capture.
- `candidateVersion` exists conceptually but is not yet a real evolving version.
- No Pika/MCP implementation exists in the repo, and Pika is no longer part of Phase 2.

### Desktop/iPad

- `Edit Level` still needs to consistently enter the MagicBoard/iPad flow, not only the legacy editor.
- `DS.LevelPreview.publishSelection()` currently posts `roomId`, `worldId`, and `worldName`; backend selection schemas already allow `stageReference`.
- Desktop level preview has platform-preview controls but no first-class voice panel, transcript, scene plan, permission prompts, or job tray.
- Draw client has semantic candidate tap choices and candidate overlays, but no microphone capture, transcript stream, or voice answer path.
- Draw client must consume the active `selection.stageReference` instead of static stage reference data.

### Game/Patch

- `js/magicBoardGame.js` currently supports only:
  - `replace_platforms`;
  - `add_platform`;
  - `set_spawns`.
- Platform candidates can become platform/cannon/spikes-style platform records.
- Portal, spawn, character, generated-object removal, and plan/proposal operations still need typed support.
- Current readiness/status logic can drift from the actual playable stage source of truth.

## Phase 2 User Flow

### 1. Enter Voice-Guided Level Editing

1. User opens the desktop game library.
2. User clicks `Edit Level` on a world.
3. Desktop enters MagicBoard creation mode for that world.
4. Desktop publishes backend selection:
   - `roomId`;
   - `worldId`;
   - `worldName`;
   - `stageReference`;
   - `stageReferenceVersion`.
5. iPad automatically joins the selected room.
6. iPad shows the active stage reference, existing accepted objects, spawns, portals, and candidate overlays.
7. Desktop and iPad show voice session state.

### 2. Platform Creation And Confirmation

1. User draws platforms or level marks on the iPad.
2. Phase 1 candidate-level VLM/deterministic semantic work continues in the background.
3. The voice agent guides the user with bounded prompts:
   - "I found three platform candidates. Should platform 1 be solid, pass-through, bouncy, damaging, cannon, or decoration?"
   - "Do you want to keep drawing platforms, or move on to effects?"
4. User can answer by voice or tap.
5. Voice answers must map to the same `clarification_answer` semantics as tap answers.
6. Accepted platform objects become proposal items first, then saved stage objects only after approval/apply.

### 3. Platform Effects Pass

After at least one playable platform exists or is proposed, the agent moves into effects:

- bouncy/trampoline;
- icy/crystal;
- damaging/spikes;
- cannon;
- breakable/box;
- pass-through/float;
- portal endpoint/pair;
- cosmetic-only visual note.

The agent should ask specific questions:

- "Should the top platform bounce players or just look icy?"
- "Should this compact drawing be a cannon, spikes, or decoration?"
- "Should these two circles become linked portals?"

Effects must be represented as typed semantic objects and deterministic patch operations. Voice must not mutate platform records directly.

### 4. Characters And Spawns

After platform structure is acceptable, the agent prompts for required play data:

1. Ask for spawn locations:
   - "Where should Player 1 spawn?"
   - "Is this marker Player 1 spawn, Player 2 spawn, both spawns, or decoration?"
2. Ask for playable characters:
   - "Use existing characters, draw new fighters, or keep the default roster?"
3. Character sketches must map to the existing draw-your-fighter/skin flow or remain unresolved.
4. The system must not silently turn a free sketch into a playable character if the rig/skin data is incomplete.

Launch validation requires the actual saved playable stage to have:

- at least one playable platform;
- at least two finite spawn points;
- at least two valid roster entries present in `DS.Store.data.characters`.

### 5. Scene Plan Review

Before applying non-trivial edits, the agent must create a scene plan:

- world name/id;
- target map/stage;
- current validation state;
- missing requirements;
- accepted/proposed platforms;
- platform effects and gimmicks;
- portals;
- spawns;
- characters/skins/roster;
- voice/VLM/agent jobs requested or pending;
- unsupported requests;
- approximations;
- unresolved questions.

The user must approve the scene plan before applying playable patches.

Supported approval commands:

- voice: "Apply it", "Looks good", "Build it";
- tap/click: `Apply Plan`.

Supported rejection/revision commands:

- voice: "Change platform two to icy", "Move Player 1 to the left platform", "Do not use that portal";
- tap/click: `Reject Proposal`, `Undo Last Agent Change`, `Keep Drawing`.

### 6. Launch

1. `Play Now` becomes available once launch validation passes.
2. User can launch immediately after approved playable patches are applied.
3. Game uses the exact last applied playable stage data.
4. Voice/VLM/agent status may continue updating room metadata, but no late result may mutate the running match without a fresh proposal and approval.

## Phase 2 State Machine

Track the agent/editor phase explicitly:

- `awaiting_platforms`;
- `classifying_candidates`;
- `confirming_platforms`;
- `enhancing_platform_effects`;
- `placing_spawns`;
- `adding_characters`;
- `reviewing_scene_plan`;
- `applying_playable_patch`;
- `playable_ready`;
- `playing`;
- `error_needs_user_action`.

State transitions must be driven by validation and user approval, not only by assistant text.

## Phase 2 Backend Implementation

### 1. Add Backend Env Loading

- [ ] Treat provider secrets as backend-only configuration.
- [ ] Keep `OPENAI_API_KEY`, `MAGICBOARD_VLM_MODEL`, and `DEEPGRAM_API_KEY` out of `draw-client/.env`.
- [ ] Support loading backend secrets from a backend-only `.env` file for local development.
- [ ] Add the backend dependency needed for this, such as `python-dotenv`, to `backend/pyproject.toml`.
- [ ] Load backend `.env` before `agent_status()`, VLM classification, and voice session startup read environment variables.
- [ ] Document the expected backend `.env` keys in a backend-local `.env.example`.
- [ ] Expected Phase 2 backend `.env` keys:
  - `OPENAI_API_KEY`;
  - `MAGICBOARD_VLM_MODEL`;
  - `DEEPGRAM_API_KEY`.
- [ ] Do not require any Pika key for Phase 2.
- [ ] Ensure backend `.env` remains gitignored.

### 2. Add Voice And Agent Schemas

Add Pydantic schemas for:

- `VoiceSession`:
  - `sessionId`;
  - `roomId`;
  - `worldId`;
  - `status`;
  - `createdAt`;
  - `updatedAt`;
  - `endedAt`;
  - `captureVersion`;
  - `semanticDraftVersion`;
  - `stageReferenceVersion`;
  - `clientId`;
  - `permissions`.
- Voice session statuses:
  - `starting`;
  - `waiting_for_permission`;
  - `listening`;
  - `thinking`;
  - `running_tool`;
  - `waiting_for_job`;
  - `speaking`;
  - `error`;
  - `ended`.
- `VoiceTranscriptEvent`:
  - partial/final transcript;
  - confidence;
  - timestamps;
  - provider metadata.
- `AgentTurn`:
  - user transcript;
  - normalized intent;
  - assistant response;
  - tool calls;
  - validation results.
- `AgentToolCall`:
  - `toolCallId`;
  - `name`;
  - `arguments`;
  - `status`;
  - `result`;
  - `error`.
- `LevelEditProposal`:
  - proposal id;
  - typed patch;
  - scene plan;
  - validation report;
  - approval state;
  - required permissions.
- `PermissionRequest`:
  - `permissionRequestId`;
  - action;
  - arguments;
  - risk summary;
  - required version refs;
  - status.
- `AgentError`:
  - stable code;
  - user-safe message;
  - retryable flag;
  - optional details.

### 3. Extend Room State

Extend `RoomState` with:

- `voice_sessions: dict[str, VoiceSession]`;
- `voice_events`;
- `agent_turns`;
- `candidate_registry`;
- `semantic_objects`;
- `stage_reference`;
- `stage_reference_version`;
- `level_edit_proposals`;
- `permission_requests`;
- `agent_jobs`.

Rules:

- Capture updates must not erase active voice state.
- Voice/orchestrator tools must read latest room state through one canonical accessor.
- Do not let long-running jobs hold stale room snapshots.
- Stable candidates need real `candidateVersion`, manual override markers, accepted/ignored state, and generated-object provenance.

### 4. Add Voice Session Endpoints

Add:

- `POST /rooms/{roomId}/voice/sessions`
  - starts a voice session;
  - validates selected world/room;
  - validates `DEEPGRAM_API_KEY` and `OPENAI_API_KEY`;
  - returns `VoiceSession`.
- `GET /rooms/{roomId}/voice/sessions/{sessionId}`.
- `DELETE /rooms/{roomId}/voice/sessions/{sessionId}`
  - ends Deepgram stream;
  - cancels nonessential pending work;
  - marks session ended.
- `GET /rooms/{roomId}/voice/events`.
- `WebSocket /ws/rooms/{roomId}/voice/{sessionId}`
  - browser sends audio/control messages;
  - backend emits transcript/session/agent/tool/error events.

Startup must fail with typed `missing_key` if required keys are absent. Do not create a mock voice or fake transcript path.

### 5. Implement Deepgram Voice Transport

- Browser/iPad captures microphone audio.
- Browser sends audio frames to MagicBoard backend voice WebSocket.
- Backend opens a Deepgram streaming connection with `DEEPGRAM_API_KEY`.
- Backend forwards binary audio frames to Deepgram.
- Backend receives partial/final transcripts.
- Backend broadcasts transcript events to desktop and iPad.
- Partial transcripts update UI only.
- Final transcripts create agent turns by default.
- Deepgram disconnect/error must:
  - mark session `error` or `ended`;
  - emit typed `voice_error`;
  - avoid unbounded retry loops.

### 6. Add OpenAI Agent Orchestrator

Replace the voice stub path with an `AgentOrchestrator` that can call only typed server tools.

Required tools:

- `get_room_state`;
- `list_candidates`;
- `get_candidate`;
- `list_semantic_objects`;
- `answer_clarification`;
- `propose_level_patch`;
- `validate_level_patch`;
- `request_permission`;
- `apply_approved_patch`;
- `cancel_job`.

Tool calls must include freshness arguments where relevant:

- `roomId`;
- `worldId`;
- `captureVersion`;
- `semanticDraftVersion`;
- `candidateId`;
- `candidateVersion`;
- `geometryHash`;
- `sourceIds`;
- `stageReferenceVersion`.

Reject tool calls if any expected version is stale.

### 7. Add Permission Gates

Require explicit permission for:

- applying a level patch;
- replacing/removing existing generated objects;
- deleting manual/user-created stage content;
- ending another active voice session.

Permission approval must echo the same ids and versions as the request.

### 8. Add Typed Error Contract

Use stable error codes:

- `missing_key`;
- `stale_capture`;
- `stale_candidate`;
- `stale_stage_reference`;
- `unknown_candidate`;
- `manual_override_exists`;
- `permission_required`;
- `permission_denied`;
- `tool_validation_failed`;
- `deepgram_disconnected`;
- `openai_failed`;
- `unsupported_operation`.

Errors must be broadcast to voice session clients and room clients. Do not hide failures behind generic assistant prose.

## Phase 2 Data Contract And Patch Implementation

### Contract Principles

- Voice and VLM are intent sources only.
- They emit semantic objects, proposals, typed patches, or async jobs.
- They never emit JavaScript or ad hoc JSON mutations.
- Canonical flow:

```text
capture/projection + voice transcript + current world context
  -> semantic objects
  -> deterministic constructors
  -> magicboard_world_patch
  -> validated saved stage
```

Keep three layers separate:

- Candidate evidence:
  - source IDs;
  - geometry;
  - crop/job metadata;
  - candidate version.
- Semantic object:
  - platform;
  - cannon;
  - spikes;
  - portal pair;
  - spawn;
  - character skin;
  - decor;
  - unknown;
  - ignore.
- Stage object:
  - actual `stage.platforms[]`;
  - actual `stage.portals[]`;
  - actual `stage.spawns[]`;
  - actual `DS.Store.data.characters`.

### Patch Operations To Support

Keep the patch envelope `magicboard_world_patch` version 1, but expand allowed operations:

- `add_platform`;
- `update_platform`;
- `add_portal_pair`;
- `remove_generated`;
- `set_spawns`;
- `set_character_skin`;
- `set_roster`;
- `set_world_metadata`;
- optional/admin-only `replace_platforms`.

`replace_platforms` must not be used in normal voice/agent apply flows unless the user explicitly chooses reset.

### Generated Provenance

Generated objects must include source metadata:

```json
{
  "source": {
    "kind": "magicboard_agent",
    "roomId": "room-id",
    "worldId": "world-id",
    "captureVersion": 12,
    "candidateId": "candidate-id",
    "candidateVersion": 3,
    "geometryHash": "hash",
    "sourceIds": ["shape-id"],
    "agentJobId": "optional",
    "voiceTurnId": "optional",
    "assetId": "optional"
  }
}
```

### Validation Requirements

Add deterministic validation for:

- patch envelope shape/version;
- allowed operation types;
- finite coordinates;
- platform width/height bounds;
- platform effects:
  - `kind`;
  - `pass`;
  - `hp`;
  - `bounce`;
  - `hurt`;
  - `fire`;
  - `move`.
- portal pairs:
  - exactly two endpoints;
  - finite `x/y/r`;
  - reciprocal links;
  - unique ids;
  - reasonable radius;
  - generated provenance on both endpoints.
- spawn points:
  - at least two finite positions for launch;
  - optional player labels/slots.
- character skins:
  - valid target roster id;
  - valid skin part schema;
  - no incomplete sketch silently becoming playable.
- `remove_generated`:
  - must require `candidateId`, generated object id, or typed generated source ref;
  - must report removed platform/portal/decor counts.

## Phase 2 Frontend/Desktop/iPad Implementation

### 1. Desktop Creation Entry

- [ ] Change Library `Edit Level` to enter MagicBoard creation mode by default.
- [ ] Keep legacy Stage editor behind a separate `Advanced Editor` action.
- [ ] On enter, call `DS.LevelPreview.enter(world)`.
- [ ] Publish `roomId`, `worldId`, `worldName`, `stageReference`, and `stageReferenceVersion`.
- [ ] Build `stageReference` from `DS.Maps.stageFor(DS.Store.data, world.mapId)`.
- [ ] Include in `stageReference`:
  - bounds;
  - platforms;
  - portals;
  - spawns;
  - accepted generated objects;
  - source stage/map id.

### 2. Desktop Voice Panel

- [ ] Add a Phase 2 agent panel inside `#level-preview-ui`.
- [ ] Add mic button states:
  - `idle`;
  - `requesting_permission`;
  - `listening`;
  - `thinking`;
  - `speaking`;
  - `muted`;
  - `error`.
- [ ] Add transcript rows with source labels:
  - `user`;
  - `agent`;
  - `system`;
  - `tool`;
  - `error`.
- [ ] Add current agent prompt card with bounded choices.
- [ ] Choices must mirror iPad tap choices.
- [ ] Add scene-plan/validation summary:
  - missing platforms;
  - missing spawns;
  - missing characters;
  - unresolved questions;
  - pending jobs.
- [ ] Add actions:
  - `Apply Plan`;
  - `Reject Proposal`;
  - `Undo Last Agent Change`;
  - `Preview Stage`;
  - `Play Now`;
  - `Wait for Jobs`.

### 3. iPad Voice/Agent Surface

- [ ] Add compact mic control to draw-client.
- [ ] Place it away from tldraw controls and semantic panel.
- [ ] Show transcript as a collapsible bottom sheet.
- [ ] Default transcript collapsed on iPad.
- [ ] Keep `SemanticPanel` tap-first.
- [ ] Add voice status/hint without blocking drawing.
- [ ] Consume `selection.stageReference`.
- [ ] Render active stage reference instead of static `stageReferenceData`.
- [ ] On stage reference changes, update the reference layer without losing unsent local strokes.

### 4. Candidate Labels And Overlays

- [ ] Keep numbered candidate labels on desktop and iPad.
- [ ] Make candidate labels selectable on desktop and iPad.
- [ ] Add candidate statuses:
  - `active`;
  - `queued`;
  - `classifying`;
  - `needs_confirmation`;
  - `proposed`;
  - `accepted`;
  - `ignored`;
  - `stale`;
  - `error`.
- [ ] Desktop overlay must show deterministic preview objects separately from raw candidates.
- [ ] Accepted objects should render through actual stage renderer after saving, not only as candidate rectangles.
- [ ] Add stale-version warnings when user answers after changing drawings.

### 5. Spawn And Character Placement UI

- [ ] Add desktop/iPad overlays for spawn markers.
- [ ] Label spawn markers `P1`, `P2`, etc.
- [ ] Add candidate choices for:
  - spawn;
  - character slot;
  - character skin;
  - decoration;
  - ignore.
- [ ] Voice prompts must ask bounded questions:
  - "Is this Player 1 spawn, Player 2 spawn, both spawns, or decoration?"
  - "Is this a playable character, background character, spawn marker, or note?"
- [ ] Character sketches must route to draw-your-fighter/skin flow or stay unresolved.

### 6. Agent Job Tray

- [ ] Add generic agent job tray for voice, VLM, and OpenAI agent/tool work.
- [ ] Job rows need:
  - `jobId`;
  - `kind`;
  - `status`;
  - `progress`;
  - `candidateId`;
  - `proposalId`;
  - `startedAt`;
  - `updatedAt`;
  - `error`.
- [ ] Job statuses:
  - `queued`;
  - `submitted`;
  - `running`;
  - `needs_input`;
  - `ready`;
  - `applied`;
  - `failed`;
  - `stale`;
  - `cancelled`.
- [ ] Stale/cancelled jobs must never overwrite manual corrections or newer candidate versions.

### 7. Activity History

- [ ] Add an activity/history drawer.
- [ ] Include:
  - transcript;
  - user answers;
  - agent turns;
  - tool calls;
  - permission requests;
  - applied patches;
  - rejected proposals;
  - job results.

## Phase 2 Launch And World Source Of Truth

- [ ] Treat `DS.Store.data.stages[worldId]` as the canonical playable level for custom worlds.
- [ ] Add shared launch validator, such as `DS.WorldLibrary.validateLaunch(world, data)`.
- [ ] Validator must read `DS.Maps.stageFor(DS.Store.data, world.mapId)`.
- [ ] Do not validate only against `world.draft`.
- [ ] Block Play unless actual stage has:
  - at least one playable platform;
  - at least two finite spawn points;
  - at least two valid character roster entries.
- [ ] Update world status and thumbnail from saved stage data.
- [ ] `Preview Stage` may rebuild game without starting a match.
- [ ] `Play Now` should:
  - save capture;
  - apply approved playable patches;
  - update library status/thumbnail;
  - rebuild;
  - start match.
- [ ] Launch must use the exact last applied playable snapshot.
- [ ] Voice/VLM/agent jobs can continue reporting status after launch but cannot mutate the running match.

## Phase 2 Engineering Edge Cases

- Mic permission denied.
- Missing `DEEPGRAM_API_KEY`.
- Missing `OPENAI_API_KEY`.
- Deepgram disconnects mid-turn.
- OpenAI orchestration call fails.
- User keeps drawing while VLM/voice/agent jobs are running.
- User changes/deletes a candidate after a question was asked.
- User says "this one" when no candidate/object is selected.
- Multiple devices answer the same clarification.
- Voice result returns for old capture/candidate/stage version.
- Manual editor changes conflict with generated proposals.
- Manual correction exists and voice/VLM tries to overwrite it.
- Applying generated edits must not wipe manual platforms/spawns/portals.
- Unsupported requests must become notes, approximations requiring confirmation, or typed rejections.

## Phase 2 Tests To Add

### Backend

- [ ] Voice status reports enabled only when required env vars are present.
- [ ] Starting a voice session without Deepgram/OpenAI key fails with typed `missing_key`.
- [ ] Voice WebSocket rejects unknown session ids.
- [ ] Final transcript creates one agent turn.
- [ ] Partial transcript does not mutate state.
- [ ] Agent tool call rejects stale `captureVersion`.
- [ ] Agent tool call rejects stale `candidateVersion`.
- [ ] Agent tool call rejects stale `stageReferenceVersion`.
- [ ] Manual correction blocks voice/VLM overwrite.
- [ ] Permission-required tool does not run before approval.
- [ ] Deepgram disconnect emits typed error and ends/marks session.
- [ ] No voice path returns stubbed/generated fallback data.

### Patch/Game

- [ ] `add_portal_pair` validation.
- [ ] `remove_generated` validation and counts.
- [ ] Platform effect range validation.
- [ ] Spawn validation.
- [ ] Character skin validation.
- [ ] Launch validation reads actual stage source of truth.
- [ ] Actual-stage readiness requires platform, spawns, and characters.
- [ ] Voice commands produce the same patch contract as tap/VLM corrections.

### Frontend/E2E

- [ ] Desktop smoke: `Edit Level` publishes selection with `stageReference`.
- [ ] Draw-client smoke: waiting screen exits on selection and renders selected stage platforms/spawns.
- [ ] Voice unit: transcript final maps to clarification answer.
- [ ] Voice unit: stale answer is rejected.
- [ ] Launch smoke: accepted platform plus two spawns plus valid roster makes world playable.
- [ ] Launch smoke: `Play Now` starts updated stage while voice/agent status remains connected.
- [ ] Job tray smoke: stale voice/VLM/agent jobs do not overwrite newer semantic state.

## Phase 2 Acceptance Criteria

- [ ] `Edit Level` launches MagicBoard authoring and auto-connects iPad to the active world.
- [ ] iPad renders the selected active stage reference, not static default reference data.
- [ ] User can use voice to describe level edits while continuing to draw.
- [ ] User can answer agent questions by voice or tap through the same clarification path.
- [ ] Agent questions are bounded, candidate-specific, version-safe, and visible on iPad.
- [ ] User can add/confirm platforms, effects, portals, spawns, and character requirements into playable stage data.
- [ ] User sees and approves a scene plan before non-trivial playable changes are applied.
- [ ] `Play Now` is enabled once actual playable requirements are satisfied.
- [ ] Game launch uses the exact last applied playable snapshot.
- [ ] Background jobs continue updating status without corrupting the running match.
- [ ] Stale agent, voice, and VLM results never overwrite manual corrections or newer drawings.
- [ ] No templated/fallback assets, classifications, or patches are inserted when a provider/tool fails.

# Phase 3: Pika MCP Animation And Media Enhancement

Phase 3 goal: after Phase 2 voice-agent level editing is complete and playable, add optional Pika MCP animation/media generation as a background enhancement layer.

Phase 3 is explicitly not required for Phase 2. A Phase 2 implementation should not require:

- `PIKA_DEV_KEY`;
- Pika MCP server setup;
- Pika schemas;
- Pika job tests;
- Pika UI affordances;
- generated video/media assets.

## Phase 3 Pika User Flow

Once the level is playable, the user can ask:

- "Make an intro animation for this level."
- "Animate the icy platform glowing."
- "Create a victory animation for the red character."
- "Make a thumbnail animation from the final stage."

The game can launch immediately while Pika work runs later in the background.

## Phase 3 Pika Principles

- Pika outputs are asset proposals, not gameplay logic.
- Pika must not block playable launch.
- Pika jobs must require explicit permission before submission.
- Pika results must be previewed or attached to a proposal before being applied.
- Failed or unavailable Pika must emit typed errors; no placeholder/fallback media should be inserted.
- Do not use Pika to replace core gameplay animation unless a later typed spritesheet/rig conversion pipeline is explicitly designed.

## Phase 3 Pika Implementation Notes

- [ ] Add backend env support for `PIKA_DEV_KEY` or the final Pika MCP credential name.
- [ ] Add provider-neutral async media job adapter.
- [ ] Add `PikaJob` or `MediaGenerationJob` schema:
  - `jobId`;
  - `providerJobId`;
  - `roomId`;
  - `sessionId`;
  - `status`;
  - prompt/input refs;
  - result asset refs;
  - errors;
  - created/updated timestamps.
- [ ] Add orchestrator tools:
  - `submit_pika_job`;
  - `get_pika_job_status`;
  - `attach_generated_asset_to_proposal`.
- [ ] Store Pika metadata separately from gameplay fields:
  - provider;
  - model;
  - prompt;
  - input source refs;
  - job status;
  - output asset URLs/blob ids;
  - approval state;
  - semantic target;
  - created/updated timestamps.
- [ ] Surface Pika as `kind: "pika_generation"` through the existing generic job tray.
- [ ] Add typed errors:
  - `pika_unavailable`;
  - `pika_failed`.
- [ ] Ensure stale/cancelled Pika jobs never overwrite manual corrections or newer candidate versions.

## Phase 3 Pika Tests

- [ ] Pika metadata persists without gameplay mutation.
- [ ] Pika job success attaches only to matching fresh proposal.
- [ ] Pika job completion after proposal changes marks job stale.
- [ ] `Play Now` starts updated stage while a fake Pika background job remains pending.
