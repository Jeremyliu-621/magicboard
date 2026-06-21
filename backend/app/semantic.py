from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from .schemas import (
    ClarificationAnswerMessage,
    PortalEndpointGeometry,
    SemanticAnswer,
    SemanticCandidate,
    SemanticChoice,
    SemanticDraft,
    SemanticGeometry,
    SemanticQuestion,
    VisualObservationHint,
)

MIN_PLATFORM_W = 64.0
MIN_PLATFORM_H = 10.0
MAX_PLATFORM_H = 150.0

CHOICES = [
    SemanticChoice(id="yes_platform", label="Yes, solid platform", role="platform", behavior="solid"),
    SemanticChoice(id="normal", label="Normal solid", role="platform", behavior="solid"),
    SemanticChoice(id="pass_through", label="Pass-through", role="platform", behavior="pass"),
    SemanticChoice(id="bouncy", label="Bouncy / trampoline", role="platform", behavior="bounce"),
    SemanticChoice(id="damaging", label="Damaging / spikes", role="spikes", behavior="spikes"),
    SemanticChoice(id="icy", label="Icy / crystal look", role="platform", behavior="ice"),
    SemanticChoice(id="breakable", label="Breakable / box", role="platform", behavior="breakable"),
    SemanticChoice(id="cannon", label="Cannon", role="cannon", behavior="cannon"),
    SemanticChoice(id="spikes", label="Spikes", role="spikes", behavior="spikes"),
    SemanticChoice(id="portal_endpoint", label="Portal endpoint", role="portal_endpoint", behavior="portal_endpoint"),
    SemanticChoice(id="portal_pair", label="Portal pair", role="portal_pair", behavior="portal_pair"),
    SemanticChoice(id="decor", label="Decoration", role="decor", behavior="decor"),
    SemanticChoice(id="no_ignore", label="No / ignore", role="ignore", behavior="ignore"),
]

CHOICE_BY_ID = {choice.id: choice for choice in CHOICES}

CHOICE_ID_BY_BEHAVIOR = {
    "solid": "normal",
    "pass": "pass_through",
    "bounce": "bouncy",
    "hurt": "damaging",
    "spikes": "spikes",
    "ice": "icy",
    "breakable": "breakable",
    "cannon": "cannon",
    "portal_endpoint": "portal_endpoint",
    "portal_pair": "portal_pair",
    "unknown": "no_ignore",
    "decor": "decor",
    "ignore": "no_ignore",
}


def _num(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    return None


def _round(value: float) -> float:
    return round(value, 2)


def _hash(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _bounds_from_points(points: list[dict[str, Any]]) -> dict[str, float] | None:
    cleaned: list[tuple[float, float]] = []
    for point in points:
        x = _num(point.get("x"))
        y = _num(point.get("y"))
        if x is not None and y is not None:
            cleaned.append((x, y))
    if len(cleaned) < 2:
        return None
    xs = [point[0] for point in cleaned]
    ys = [point[1] for point in cleaned]
    return {
        "x": min(xs),
        "y": min(ys),
        "w": max(xs) - min(xs),
        "h": max(ys) - min(ys),
        "start_y": cleaned[0][1],
        "end_y": cleaned[-1][1],
    }


def _geometry_hash(source_ids: list[str], geometry: SemanticGeometry) -> str:
    return _hash(
        {
            "sourceIds": source_ids,
            "geometry": {
                "x": _round(geometry.x),
                "y": _round(geometry.y),
                "w": _round(geometry.w),
                "h": _round(geometry.h),
            },
        }
    )


def _candidate_id(source_ids: list[str], geometry_hash: str, semantic_type: str) -> str:
    return "candidate-" + semantic_type.replace("_", "-") + "-" + _hash({"sourceIds": source_ids, "geometryHash": geometry_hash})[:12]


def _question_id(candidate_id: str, geometry_hash: str, capture_version: int) -> str:
    return "question-" + _hash(
        {"candidateId": candidate_id, "geometryHash": geometry_hash, "captureVersion": capture_version}
    )[:12]


def _is_clear_rectangle(shape: dict[str, Any]) -> bool:
    kind = str(shape.get("kind") or "").lower()
    if kind not in {"rectangle", "rect", "geo", "draw"}:
        return False
    w = _num(shape.get("w"))
    h = _num(shape.get("h"))
    if w is None or h is None:
        return False
    w = abs(w)
    h = abs(h)
    return w >= MIN_PLATFORM_W and MIN_PLATFORM_H <= h <= MAX_PLATFORM_H and w / max(h, 1.0) >= 1.8


def _stage_choice_id(shape: dict[str, Any]) -> str | None:
    stage = shape.get("stage")
    if not isinstance(stage, dict) or stage.get("role") != "platform":
        return None
    behavior = str(stage.get("behavior") or "").lower()
    return CHOICE_ID_BY_BEHAVIOR.get(behavior)


def _semantic_type_for_choice(choice_id: str | None) -> str:
    choice = CHOICE_BY_ID.get(choice_id or "")
    if choice is None:
        return "unknown"
    if choice.role in {"platform", "cannon", "spikes", "portal_endpoint", "portal_pair"}:
        return choice.role
    return "unknown"


def _rectangle_geometry(shape: dict[str, Any]) -> SemanticGeometry | None:
    x = _num(shape.get("x"))
    y = _num(shape.get("y"))
    w = _num(shape.get("w"))
    h = _num(shape.get("h"))
    if x is None or y is None or w is None or h is None:
        return None
    if w < 0:
        x += w
        w = abs(w)
    if h < 0:
        y += h
        h = abs(h)
    return SemanticGeometry(x=_round(x), y=_round(y), w=_round(w), h=_round(h))


def _stroke_geometry(stroke: dict[str, Any]) -> SemanticGeometry | None:
    points = stroke.get("points") or []
    bounds = _bounds_from_points(points)
    if not bounds:
        return None
    width = _num(stroke.get("width")) or 6.0
    horizontal_drift = abs(bounds["end_y"] - bounds["start_y"])
    if width < 8:
        # Thin freehand platform outlines often produce tall scribbly bounds.
        # Accept them when their start/end line stays level and the overall mark
        # is still wider than it is tall enough to be playable.
        if len(points) < 6:
            return None
        if bounds["w"] < MIN_PLATFORM_W or bounds["w"] < bounds["h"] * 1.2:
            return None
        if horizontal_drift > max(38.0, bounds["w"] * 0.16):
            return None
        h = max(MIN_PLATFORM_H, min(MAX_PLATFORM_H, bounds["h"]))
        return SemanticGeometry(x=_round(bounds["x"]), y=_round(bounds["y"]), w=_round(bounds["w"]), h=_round(h))
    visual_h = max(width * 2.4, bounds["h"] + width * 1.8, MIN_PLATFORM_H)
    if bounds["w"] < MIN_PLATFORM_W:
        return None
    if horizontal_drift > max(36.0, bounds["w"] * 0.18):
        return None
    if bounds["h"] > max(80.0, bounds["w"] * 0.26):
        return None
    y = bounds["y"] + bounds["h"] / 2 - visual_h / 2
    return SemanticGeometry(x=_round(bounds["x"]), y=_round(y), w=_round(bounds["w"]), h=_round(visual_h))


def _compact_glyph_geometry(stroke: dict[str, Any]) -> SemanticGeometry | None:
    points = stroke.get("points") or []
    bounds = _bounds_from_points(points)
    if not bounds:
        return None
    if len(points) < 4:
        return None
    width = _num(stroke.get("width")) or 6.0
    pad = max(10.0, width * 1.4)
    w = bounds["w"] + pad * 2
    h = bounds["h"] + pad * 2
    if w < 18 or h < 18 or w > 180 or h > 180:
        return None
    ratio = w / max(h, 1.0)
    if ratio > 2.5 or ratio < 0.4:
        return None
    return SemanticGeometry(x=_round(bounds["x"] - pad), y=_round(bounds["y"] - pad), w=_round(w), h=_round(h))


def _stroke_circle_geometry(stroke: dict[str, Any]) -> tuple[SemanticGeometry, PortalEndpointGeometry] | None:
    points = stroke.get("points") or []
    bounds = _bounds_from_points(points)
    if not bounds or len(points) < 8:
        return None
    width = _num(stroke.get("width")) or 6.0
    w = bounds["w"]
    h = bounds["h"]
    if w < 28 or h < 28 or w > 260 or h > 260:
        return None
    ratio = w / max(h, 1.0)
    if ratio < 0.45 or ratio > 2.2:
        return None
    first = points[0]
    last = points[-1]
    if not all(isinstance(point, dict) for point in (first, last)):
        return None
    close_distance = ((float(first.get("x") or 0.0) - float(last.get("x") or 0.0)) ** 2 + (float(first.get("y") or 0.0) - float(last.get("y") or 0.0)) ** 2) ** 0.5
    if close_distance > max(width * 5.0, min(w, h) * 0.45):
        return None
    length = 0.0
    previous = None
    for point in points:
        if not isinstance(point, dict) or not isinstance(point.get("x"), int | float) or not isinstance(point.get("y"), int | float):
            continue
        if previous is not None:
            length += ((float(point["x"]) - previous[0]) ** 2 + (float(point["y"]) - previous[1]) ** 2) ** 0.5
        previous = (float(point["x"]), float(point["y"]))
    if length < (w + h) * 1.15:
        return None
    pad = max(8.0, width * 1.2)
    geometry = SemanticGeometry(x=_round(bounds["x"] - pad), y=_round(bounds["y"] - pad), w=_round(w + pad * 2), h=_round(h + pad * 2))
    endpoint = PortalEndpointGeometry(
        x=_round(bounds["x"] + w / 2),
        y=_round(bounds["y"] + h / 2),
        r=_round(max(30.0, min(90.0, (w + h) / 4))),
    )
    return geometry, endpoint


def _circle_geometry(shape: dict[str, Any]) -> tuple[SemanticGeometry, PortalEndpointGeometry] | None:
    kind = str(shape.get("kind") or "").lower()
    if kind not in {"ellipse", "oval", "circle"}:
        return None
    geometry = _rectangle_geometry(shape)
    if not geometry:
        return None
    if geometry.w < 28 or geometry.h < 28:
        return None
    ratio = geometry.w / max(geometry.h, 1.0)
    if ratio < 0.45 or ratio > 2.2:
        return None
    endpoint = PortalEndpointGeometry(
        x=_round(geometry.x + geometry.w / 2),
        y=_round(geometry.y + geometry.h / 2),
        r=_round(max(30.0, min(90.0, (geometry.w + geometry.h) / 4))),
    )
    return geometry, endpoint


def _make_candidate(
    *,
    room_id: str,
    world_id: str | None,
    capture_version: int,
    client_id: str | None,
    source_ids: list[str],
    geometry: SemanticGeometry,
    extractor: str,
    confidence: float,
    answers_by_binding: dict[tuple[str, str, tuple[str, ...]], SemanticAnswer],
    forced_choice_id: str | None = None,
    semantic_type: str = "unknown",
    portal_endpoints: list[PortalEndpointGeometry] | None = None,
) -> SemanticCandidate:
    source_ids = sorted(source_ids)
    geometry_hash = _geometry_hash(source_ids, geometry)
    if forced_choice_id:
        semantic_type = _semantic_type_for_choice(forced_choice_id)
    candidate_id = _candidate_id(source_ids, geometry_hash, semantic_type)
    question_id = _question_id(candidate_id, geometry_hash, capture_version)
    question = SemanticQuestion(
        questionId=question_id,
        candidateId=candidate_id,
        prompt="What should this platform do?" if semantic_type == "platform" else "What should this doodle become?",
        choices=CHOICES,
        roomId=room_id,
        worldId=world_id,
        captureVersion=capture_version,
        sourceIds=source_ids,
        geometryHash=geometry_hash,
        clientId=client_id,
    )
    answer = answers_by_binding.get((candidate_id, geometry_hash, tuple(source_ids)))
    forced_choice = CHOICE_BY_ID.get(forced_choice_id or "")
    if forced_choice is not None:
        answer_id = "answer-" + _hash(
            {
                "roomId": room_id,
                "candidateId": candidate_id,
                "questionId": question_id,
                "choiceId": forced_choice.id,
                "geometryHash": geometry_hash,
                "sourceIds": source_ids,
                "deterministic": True,
            }
        )[:12]
        answer = SemanticAnswer(
            answerId=answer_id,
            questionId=question_id,
            candidateId=candidate_id,
            choiceId=forced_choice.id,
            role=forced_choice.role,
            behavior=forced_choice.behavior,
            roomId=room_id,
            worldId=world_id,
            captureVersion=capture_version,
            sourceIds=source_ids,
            geometryHash=geometry_hash,
            clientId=client_id,
            confidence=1.0,
            classifier="deterministic",
            answeredAt=datetime.now(UTC),
        )
    status = "needs_answer"
    if answer:
        if answer.role in {"platform", "cannon", "spikes", "portal_endpoint", "portal_pair"}:
            status = "confirmed"
        elif answer.role == "decor":
            status = "decor"
        else:
            status = "ignored"
    return SemanticCandidate(
        candidateId=candidate_id,
        status=status,
        semanticType=answer.role if answer and answer.role in {"platform", "cannon", "spikes", "portal_endpoint", "portal_pair"} else semantic_type,  # type: ignore[arg-type]
        candidateVersion=1,
        classification=answer,
        extractor=extractor,  # type: ignore[arg-type]
        confidence=confidence,
        geometry=geometry,
        portalEndpoints=portal_endpoints or [],
        sourceIds=source_ids,
        geometryHash=geometry_hash,
        roomId=room_id,
        worldId=world_id,
        captureVersion=capture_version,
        questionId=question_id,
        question=question,
        answer=answer,
    )


def _visual_hint_choice_id(hint: VisualObservationHint) -> str | None:
    if hint.kind == "portal_pair" or (hint.kind == "portal_endpoint" and len(hint.source_ids) >= 2):
        return "portal_pair"
    if hint.kind == "portal_endpoint":
        return "portal_endpoint"
    if hint.kind == "cannon":
        return "cannon"
    if hint.kind in {"spikes", "hazard"}:
        return "spikes"
    if hint.kind == "decor":
        return "decor"
    if hint.kind == "ignore":
        return "no_ignore"
    behavior = (hint.behavior or "").lower()
    choice_id = CHOICE_ID_BY_BEHAVIOR.get(behavior)
    if choice_id:
        return choice_id
    if hint.kind == "platform":
        return "normal"
    return None


def _visual_hint_match_score(candidate: SemanticCandidate, hint: VisualObservationHint) -> int:
    hint_source_ids = set(hint.source_ids)
    if not hint_source_ids:
        return 0
    candidate_source_ids = set(candidate.source_ids)
    bonus = 3 if (
        candidate.semantic_type == "portal_pair"
        and hint.kind in {"portal_endpoint", "portal_pair"}
        and len(hint_source_ids) >= 2
    ) else 0
    if candidate_source_ids == hint_source_ids:
        return 3 + bonus
    if candidate_source_ids.issubset(hint_source_ids) or hint_source_ids.issubset(candidate_source_ids):
        return 2 + bonus
    if candidate_source_ids & hint_source_ids:
        return 1 + bonus
    return 0


def _apply_visual_hints(
    *,
    candidates: list[SemanticCandidate],
    hints: list[VisualObservationHint],
    room_id: str,
    world_id: str | None,
    capture_version: int,
    client_id: str | None,
) -> None:
    for hint in sorted(hints, key=lambda item: item.confidence, reverse=True):
        threshold = 0.55 if hint.kind in {"portal_endpoint", "portal_pair"} else 0.74
        if hint.confidence < threshold:
            continue
        choice = CHOICE_BY_ID.get(_visual_hint_choice_id(hint) or "")
        if choice is None:
            continue
        matches = sorted(
            (
                (_visual_hint_match_score(candidate, hint), candidate)
                for candidate in candidates
                if candidate.answer is None
            ),
            key=lambda item: item[0],
            reverse=True,
        )
        if not matches or matches[0][0] <= 0:
            continue
        candidate = matches[0][1]
        answer_id = "answer-" + _hash(
            {
                "roomId": room_id,
                "candidateId": candidate.candidate_id,
                "questionId": candidate.question_id,
                "choiceId": choice.id,
                "geometryHash": candidate.geometry_hash,
                "sourceIds": candidate.source_ids,
                "visualObservation": True,
            }
        )[:12]
        candidate.answer = SemanticAnswer(
            answerId=answer_id,
            questionId=candidate.question_id,
            candidateId=candidate.candidate_id,
            choiceId=choice.id,
            role=choice.role,
            behavior=choice.behavior,
            roomId=room_id,
            worldId=world_id,
            captureVersion=capture_version,
            sourceIds=candidate.source_ids,
            geometryHash=candidate.geometry_hash,
            clientId=client_id,
            confidence=max(0.0, min(1.0, hint.confidence)),
            classifier="vlm",
            answeredAt=datetime.now(UTC),
        )
        candidate.classification = candidate.answer
        candidate.semantic_type = choice.role if choice.role in {"platform", "cannon", "spikes", "portal_endpoint", "portal_pair"} else "unknown"
        if choice.role in {"platform", "cannon", "spikes", "portal_endpoint", "portal_pair"}:
            candidate.status = "confirmed"
        elif choice.role == "decor":
            candidate.status = "decor"
        else:
            candidate.status = "ignored"


def _grouped_stroke_candidates(
    strokes: list[dict[str, Any]],
    used_source_ids: set[str],
) -> list[tuple[list[str], SemanticGeometry]]:
    items: list[dict[str, Any]] = []
    for stroke in strokes:
        source_id = str(stroke.get("sourceId") or stroke.get("id") or "")
        if not source_id or source_id in used_source_ids:
            continue
        bounds = _bounds_from_points(stroke.get("points") or [])
        if not bounds or bounds["w"] < 24:
            continue
        width = _num(stroke.get("width")) or 6.0
        if bounds["h"] > max(58.0, bounds["w"] * 0.35):
            continue
        items.append({"sourceId": source_id, "bounds": bounds, "width": width})

    groups: list[list[dict[str, Any]]] = []
    for item in sorted(items, key=lambda value: (value["bounds"]["y"], value["bounds"]["x"])):
        placed = False
        cy = item["bounds"]["y"] + item["bounds"]["h"] / 2
        for group in groups:
            gys = [entry["bounds"]["y"] + entry["bounds"]["h"] / 2 for entry in group]
            if abs(cy - (sum(gys) / len(gys))) <= 28:
                group.append(item)
                placed = True
                break
        if not placed:
            groups.append([item])

    candidates: list[tuple[list[str], SemanticGeometry]] = []
    for group in groups:
        if len(group) < 2:
            continue
        min_x = min(entry["bounds"]["x"] for entry in group)
        min_y = min(entry["bounds"]["y"] for entry in group)
        max_x = max(entry["bounds"]["x"] + entry["bounds"]["w"] for entry in group)
        max_y = max(entry["bounds"]["y"] + entry["bounds"]["h"] for entry in group)
        w = max_x - min_x
        h = max(max_y - min_y, max(entry["width"] for entry in group) * 2.2, 18.0)
        if w < MIN_PLATFORM_W or h > 95 or w / max(h, 1.0) < 2.2:
            continue
        source_ids = sorted(entry["sourceId"] for entry in group)
        candidates.append((source_ids, SemanticGeometry(x=_round(min_x), y=_round(min_y), w=_round(w), h=_round(h))))
    return candidates


def build_semantic_draft(
    *,
    room_id: str,
    world_id: str | None,
    capture_version: int,
    projection: dict[str, Any] | None,
    client_id: str | None,
    prior_answers: list[SemanticAnswer],
    visual_hints: list[VisualObservationHint] | None = None,
) -> SemanticDraft:
    answers_by_binding = {
        (answer.candidate_id, answer.geometry_hash, tuple(sorted(answer.source_ids))): answer
        for answer in prior_answers
    }
    candidates: list[SemanticCandidate] = []
    projection = projection or {}
    used_source_ids: set[str] = set()

    for shape in projection.get("shapes") or []:
        forced_choice_id = _stage_choice_id(shape) if isinstance(shape, dict) else None
        if not isinstance(shape, dict):
            continue
        circle = _circle_geometry(shape)
        if not forced_choice_id and not _is_clear_rectangle(shape) and not circle:
            continue
        geometry = circle[0] if circle else _rectangle_geometry(shape)
        source_id = str(shape.get("sourceId") or shape.get("id") or "")
        if not geometry or not source_id:
            continue
        semantic_type = "portal_endpoint" if circle else "platform"
        candidate = _make_candidate(
            room_id=room_id,
            world_id=world_id,
            capture_version=capture_version,
            client_id=client_id,
            source_ids=[source_id],
            geometry=geometry,
            extractor="stage_tool" if forced_choice_id else ("circle" if circle else "rectangle"),
            confidence=0.99 if forced_choice_id else 0.94,
            answers_by_binding=answers_by_binding,
            forced_choice_id=forced_choice_id,
            semantic_type=semantic_type,
            portal_endpoints=[circle[1]] if circle else [],
        )
        candidates.append(candidate)
        used_source_ids.add(source_id)

    strokes = [stroke for stroke in projection.get("strokes") or [] if isinstance(stroke, dict)]
    for stroke in strokes:
        source_id = str(stroke.get("sourceId") or stroke.get("id") or "")
        if not source_id:
            continue
        circle = _stroke_circle_geometry(stroke)
        if circle:
            candidate = _make_candidate(
                room_id=room_id,
                world_id=world_id,
                capture_version=capture_version,
                client_id=client_id,
                source_ids=[source_id],
                geometry=circle[0],
                extractor="circle",
                confidence=0.78,
                answers_by_binding=answers_by_binding,
                semantic_type="portal_endpoint",
                portal_endpoints=[circle[1]],
            )
            candidates.append(candidate)
            used_source_ids.add(source_id)
            continue
        geometry = _stroke_geometry(stroke)
        if geometry:
            candidate = _make_candidate(
                room_id=room_id,
                world_id=world_id,
                capture_version=capture_version,
                client_id=client_id,
                source_ids=[source_id],
                geometry=geometry,
                extractor="stroke",
                confidence=0.82,
                answers_by_binding=answers_by_binding,
                semantic_type="platform",
            )
            candidates.append(candidate)
            used_source_ids.add(source_id)
        else:
            compact = _compact_glyph_geometry(stroke)
            if compact:
                candidate = _make_candidate(
                    room_id=room_id,
                    world_id=world_id,
                    capture_version=capture_version,
                    client_id=client_id,
                    source_ids=[source_id],
                    geometry=compact,
                    extractor="compact_glyph",
                    confidence=0.64,
                    answers_by_binding=answers_by_binding,
                    semantic_type="unknown",
                )
                candidates.append(candidate)
                used_source_ids.add(source_id)

    for source_ids, geometry in _grouped_stroke_candidates(strokes, used_source_ids):
        candidates.append(
            _make_candidate(
                room_id=room_id,
                world_id=world_id,
                capture_version=capture_version,
                client_id=client_id,
                source_ids=source_ids,
                geometry=geometry,
                extractor="grouped_strokes",
                confidence=0.72,
                answers_by_binding=answers_by_binding,
                semantic_type="platform",
            )
        )

    portal_endpoints = [
        candidate for candidate in candidates
        if candidate.semantic_type == "portal_endpoint" and len(candidate.portal_endpoints) == 1
    ]
    if len(portal_endpoints) >= 2:
        first, second = portal_endpoints[-2], portal_endpoints[-1]
        x0 = min(first.geometry.x, second.geometry.x)
        y0 = min(first.geometry.y, second.geometry.y)
        x1 = max(first.geometry.x + first.geometry.w, second.geometry.x + second.geometry.w)
        y1 = max(first.geometry.y + first.geometry.h, second.geometry.y + second.geometry.h)
        candidates.append(
            _make_candidate(
                room_id=room_id,
                world_id=world_id,
                capture_version=capture_version,
                client_id=client_id,
                source_ids=first.source_ids + second.source_ids,
                geometry=SemanticGeometry(x=_round(x0), y=_round(y0), w=_round(x1 - x0), h=_round(y1 - y0)),
                extractor="portal_pair",
                confidence=0.78,
                answers_by_binding=answers_by_binding,
                semantic_type="portal_pair",
                portal_endpoints=first.portal_endpoints + second.portal_endpoints,
            )
        )

    if visual_hints:
        _apply_visual_hints(
            candidates=candidates,
            hints=visual_hints,
            room_id=room_id,
            world_id=world_id,
            capture_version=capture_version,
            client_id=client_id,
        )

    active_answer_ids = {candidate.answer.answer_id for candidate in candidates if candidate.answer}
    stale_answers = [answer for answer in prior_answers if answer.answer_id not in active_answer_ids]
    return SemanticDraft(
        roomId=room_id,
        worldId=world_id,
        captureVersion=capture_version,
        clientId=client_id,
        generatedAt=datetime.now(UTC),
        candidates=candidates,
        questions=[candidate.question for candidate in candidates if candidate.status == "needs_answer"],
        answers=[candidate.answer for candidate in candidates if candidate.answer is not None],
        staleAnswers=stale_answers,
    )


def bind_answer(
    *,
    draft: SemanticDraft | None,
    message: ClarificationAnswerMessage,
    room_id: str,
) -> SemanticAnswer:
    if draft is None:
        raise ValueError("no semantic draft exists for this room")
    if message.capture_version != draft.capture_version:
        raise ValueError("stale captureVersion")
    candidate = next((item for item in draft.candidates if item.candidate_id == message.candidate_id), None)
    if candidate is None:
        raise ValueError("unknown candidateId")
    if candidate.question_id != message.question_id:
        raise ValueError("stale questionId")
    if candidate.geometry_hash != message.geometry_hash:
        raise ValueError("stale geometryHash")
    if sorted(candidate.source_ids) != sorted(message.source_ids):
        raise ValueError("stale sourceIds")
    choice = CHOICE_BY_ID.get(message.choice_id)
    if choice is None:
        raise ValueError("unsupported choiceId")
    answer_id = "answer-" + _hash(
        {
            "roomId": room_id,
            "candidateId": candidate.candidate_id,
            "questionId": candidate.question_id,
            "choiceId": message.choice_id,
            "geometryHash": candidate.geometry_hash,
            "clientId": message.client_id,
        }
    )[:12]
    return SemanticAnswer(
        answerId=answer_id,
        questionId=candidate.question_id,
        candidateId=candidate.candidate_id,
        choiceId=message.choice_id,
        role=choice.role,
        behavior=choice.behavior,
        roomId=room_id,
        worldId=message.world_id or draft.world_id,
        captureVersion=draft.capture_version,
        sourceIds=candidate.source_ids,
        geometryHash=candidate.geometry_hash,
        clientId=message.client_id,
        classifier="manual",
        answeredAt=datetime.now(UTC),
    )
