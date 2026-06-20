"""
CAELLUM image-pipeline — single source of truth (Neuron / workshop-box side).

Imported by compile.py and serve.py (which run in the AWS workshop Neuron env).
The Colab-side scripts (data/, train/) DUPLICATE the relevant constants inline
(CATEGORIES, SHAPE, STYLE) because Colab is a separate environment that does not
have this repo — keep those copies in sync with this file (the runbook says so).
"""

# ---- static compile geometry (Neuron requires FIXED shapes; one size, forever) ----
SHAPE = 512          # height == width, baked at compile time. Changing it => full recompile.
BATCH = 1
NUM_IMAGES = 1
DTYPE = "bf16"       # --auto_cast matmul --auto_cast_type bf16

# ---- base models ----
# SD1.5 is the GUARANTEED floor (well-trodden Neuron+ControlNet path, ~35GB compile).
SD15_MODEL = "stable-diffusion-v1-5/stable-diffusion-v1-5"
SD15_CONTROLNET = "lllyasviel/sd-controlnet-scribble"   # true scribble conditioner
# SDXL is the PRIMARY/quality target (better looks, slower compile, ~120GB RAM, segfault risk on AL2).
SDXL_MODEL = "stabilityai/stable-diffusion-xl-base-1.0"
SDXL_CONTROLNET = "diffusers/controlnet-canny-sdxl-1.0-small"  # the Neuron-documented SDXL CN; feed the sketch as canny edges

# Which base the serve loads. "sd15" until SDXL is verified, then flip to "sdxl".
ACTIVE_BASE = "sd15"

# Optional style LoRA fused at compile time (train output). None until trained.
# Fuse with: from_pretrained(..., lora_model_ids=LORA_DIR, inline_weights_to_neff=True)
LORA_DIR = None

# ---- runtime ENHANCE params (relaxed 2-3s budget => more steps, embellishment room) ----
STRENGTH = 0.6              # img2img denoise: high enough to ADD detail (handle/pattern), low enough to keep layout
CONTROLNET_SCALE = 0.6     # how tightly to follow the drawn lines
STEPS = 20                 # ~2-3s budget. (LCM variant => 8 steps; turbo => 1, lower quality)
GUIDANCE = 6.0
NEG_PROMPT = "photograph, 3d render, realistic, blurry, color noise, jpeg artifacts, watermark, text, signature"

def prompt_for(label: str) -> str:
    """Build the positive prompt from the semantic hint (typed/voice label)."""
    return (f"a clean 2d game asset of a {label}, bold black outline, flat shading, "
            f"centered, simple bold shapes, crisp lines, white background, sticker, icon")

# ---- item / object taxonomy (mirror the flat CATEGORIES list in data/ + train/ Colab scripts) ----
# CATEGORY_BEHAVIOR is the single source of truth for BOTH halves of the pipeline:
#   - CAELLUM (visual): the KEYS are the labels/prompts the teacher dataset is built from.
#   - role hint + CHLOE (behavior): the VALUE is the archetype that decides what the drawn
#     object DOES and how it is placed. Your teammates' pre-runtime "mode" picks the archetype;
#     the game routes by it. Archetype -> engine primitive:
#       melee_weapon  -> DS.Prop item; swing -> world.damageBox / hitbox        (pickup)
#       ranged_weapon -> DS.Prop item; fire  -> world.spawnProjectile           (pickup)
#       throwable     -> DS.Prop item; throw -> projectile that impacts/explodes (pickup)
#       heal          -> DS.Prop item; on use restores % then consumed          (pickup)
#       buff          -> DS.Prop item; temporary effect (invuln/grow/...)        (pickup)
#       hazard        -> stage element; damage on contact (reuse damage system)  (environment)
#       bouncy        -> stage element; kind:'trampoline' (ALREADY in engine)    (environment)
#       platform      -> stage element; stand on (kind:'drawn' platform)         (environment)
#       prop          -> destructible stage object; may drop an item             (environment)
# Labels are GENERAL everyday nouns (not franchise-specific) so the model generalizes to
# whatever a player actually draws. Smash was only a reference for the archetype TYPES.
CATEGORY_BEHAVIOR = {
    # melee weapons (held, swing)
    "sword": "melee_weapon", "knife": "melee_weapon", "bat": "melee_weapon",
    "hammer": "melee_weapon", "axe": "melee_weapon",
    # ranged weapons (held, fire a projectile)
    "gun": "ranged_weapon", "bow": "ranged_weapon", "slingshot": "ranged_weapon",
    # throwables (pick up and throw; impact / explode)
    "bomb": "throwable", "ball": "throwable", "rock": "throwable",
    "bottle": "throwable", "dart": "throwable",
    # healing / food (consume to restore %)
    "food": "heal", "fruit": "heal", "bread": "heal", "cake": "heal",
    # buffs (temporary effect)
    "star": "buff", "heart": "buff", "gem": "buff", "crown": "buff",
    # environment hazards (damage on contact)
    "spikes": "hazard", "saw": "hazard", "fire": "hazard", "trap": "hazard",
    # environment bouncy (trampoline)
    "spring": "bouncy", "trampoline": "bouncy",
    # environment platforms (stand on)
    "cloud": "platform", "block": "platform", "plank": "platform",
    # destructible props (may drop an item)
    "crate": "prop", "barrel": "prop", "balloon": "prop", "key": "prop", "coin": "prop",
}
CATEGORIES = list(CATEGORY_BEHAVIOR.keys())   # the flat, GENERAL label list the teacher dataset iterates

# ---- artifacts / paths (relative to repo root) ----
ARTIFACT_DIR = "caellum_neuron"          # compile.py output dir (the serialized .neuron pipeline)
DATASET_DIR = "data/caellum_pairs"       # roughen.py output; train_*.py input
TEACHER_DIR = "data/caellum_teacher"     # gen_teacher.py output (finished targets, pre-roughen)

# ---- /enhance HTTP contract (serve.py) ----
# POST {ENHANCE_ENDPOINT}
#   request : {"image_b64": "<png, the rough sketch, any size>", "label": "gun", "steps"?: int, "strength"?: float}
#   response: {"sprite_b64": "<rgba png, enhanced + background removed>", "ms": <int>, "base": "sd15"|"sdxl"}
ENHANCE_ENDPOINT = "/enhance"
HEALTH_ENDPOINT = "/healthz"
PORT = 8400
