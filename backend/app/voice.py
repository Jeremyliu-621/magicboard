from __future__ import annotations

import asyncio
import base64
import json
from datetime import UTC, datetime
from typing import Any

import httpx
import websockets
from fastapi import WebSocket, WebSocketDisconnect

from .config import env
from .orchestrator import AgentOrchestrator
from .schemas import AgentError, VoiceTranscriptEvent


DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&interim_results=true&encoding=webm"
DEEPGRAM_SPEAK_URL = "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en"


def _event_id(prefix: str, room_id: str, session_id: str) -> str:
    import hashlib

    raw = "|".join([prefix, room_id, session_id, datetime.now(UTC).isoformat()])
    return prefix + "-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def _transcript_from_deepgram(payload: dict[str, Any]) -> tuple[str, bool, float | None]:
    channel = payload.get("channel") or {}
    alternatives = channel.get("alternatives") or []
    first = alternatives[0] if alternatives and isinstance(alternatives[0], dict) else {}
    transcript = str(first.get("transcript") or "").strip()
    confidence = first.get("confidence")
    if not isinstance(confidence, int | float):
        confidence = None
    return transcript, bool(payload.get("is_final") or payload.get("speech_final")), confidence


async def synthesize_agent_audio(text: str) -> tuple[str | None, str | None]:
    if not text.strip() or not env("DEEPGRAM_API_KEY"):
        return None, None
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                DEEPGRAM_SPEAK_URL,
                headers={"Authorization": f"Token {env('DEEPGRAM_API_KEY')}", "Content-Type": "application/json"},
                json={"text": text[:1800]},
            )
            response.raise_for_status()
            return base64.b64encode(response.content).decode("ascii"), response.headers.get("content-type") or "audio/mpeg"
    except Exception:
        return None, None


class VoiceTransport:
    def __init__(self, registry: Any, orchestrator: AgentOrchestrator) -> None:
        self.registry = registry
        self.orchestrator = orchestrator

    async def handle_socket(self, websocket: WebSocket, room_id: str, session_id: str) -> None:
        session = self.registry.get_voice_session(room_id, session_id)
        if session is None:
            await websocket.close(code=4404)
            return
        await websocket.accept()
        deepgram_key = env("DEEPGRAM_API_KEY")
        if not deepgram_key:
            error = AgentError(code="missing_key", message="DEEPGRAM_API_KEY is not configured.", retryable=True)
            self.registry.update_voice_session(room_id, session_id, status="error", error=error, ended=True)
            await self._append_error(room_id, session_id, error)
            await self.registry.broadcast_voice_state(room_id)
            await websocket.send_json({"type": "voice_error", "error": error.model_dump(mode="json")})
            return

        self.registry.update_voice_session(room_id, session_id, status="listening")
        await self.registry.broadcast_voice_state(room_id)
        try:
            async with websockets.connect(
                DEEPGRAM_LISTEN_URL,
                additional_headers={"Authorization": f"Token {deepgram_key}"},
                max_size=8 * 1024 * 1024,
            ) as dg_socket:
                receiver = asyncio.create_task(self._receive_deepgram(room_id, session_id, dg_socket))
                try:
                    while True:
                        message = await websocket.receive()
                        if message.get("bytes") is not None:
                            await dg_socket.send(message["bytes"])
                        elif message.get("text"):
                            data = json.loads(message["text"])
                            if data.get("type") == "stop":
                                break
                except WebSocketDisconnect:
                    pass
                finally:
                    receiver.cancel()
                    try:
                        await dg_socket.send(json.dumps({"type": "CloseStream"}))
                    except Exception:
                        pass
        except Exception as error:
            agent_error = AgentError(
                code="deepgram_disconnected",
                message="Deepgram speech transport disconnected.",
                retryable=True,
                details={"reason": str(error)[:300]},
            )
            self.registry.update_voice_session(room_id, session_id, status="error", error=agent_error, ended=True)
            await self._append_error(room_id, session_id, agent_error)
            await self.registry.broadcast_voice_state(room_id)
            return
        self.registry.update_voice_session(room_id, session_id, ended=True)
        await self.registry.broadcast_voice_state(room_id)

    async def _receive_deepgram(self, room_id: str, session_id: str, dg_socket: Any) -> None:
        async for raw in dg_socket:
            try:
                payload = json.loads(raw)
            except Exception:
                continue
            transcript, is_final, confidence = _transcript_from_deepgram(payload)
            if not transcript:
                continue
            event = VoiceTranscriptEvent(
                eventId=_event_id("voice-event", room_id, session_id),
                sessionId=session_id,
                roomId=room_id,
                type="final" if is_final else "partial",
                transcript=transcript,
                confidence=confidence,
                provider="deepgram",
                metadata={"rawType": payload.get("type")},
                createdAt=datetime.now(UTC),
            )
            self.registry.append_voice_event(room_id, event)
            await self.registry.broadcast_voice_state(room_id)
            if is_final:
                await self._run_agent_turn(room_id, session_id, transcript)

    async def _run_agent_turn(self, room_id: str, session_id: str, transcript: str) -> None:
        self.registry.update_voice_session(room_id, session_id, status="thinking")
        await self.registry.broadcast_voice_state(room_id)
        turn = await self.orchestrator.run_turn(room_id, session_id, transcript)
        await self.registry.broadcast_voice_state(room_id)
        text = turn.assistant_response or (turn.error.message if turn.error else "")
        if not text:
            self.registry.update_voice_session(room_id, session_id, status="listening")
            await self.registry.broadcast_voice_state(room_id)
            return
        self.registry.append_voice_event(
            room_id,
            VoiceTranscriptEvent(
                eventId=_event_id("voice-agent", room_id, session_id),
                sessionId=session_id,
                roomId=room_id,
                type="assistant_text",
                transcript=text,
                provider="openai",
                createdAt=datetime.now(UTC),
            ),
        )
        self.registry.update_voice_session(room_id, session_id, status="speaking")
        await self.registry.broadcast_voice_state(room_id)
        audio, mime = await synthesize_agent_audio(text)
        if audio:
            self.registry.append_voice_event(
                room_id,
                VoiceTranscriptEvent(
                    eventId=_event_id("voice-audio", room_id, session_id),
                    sessionId=session_id,
                    roomId=room_id,
                    type="assistant_audio",
                    transcript=text,
                    audioBase64=audio,
                    mimeType=mime,
                    provider="deepgram",
                    createdAt=datetime.now(UTC),
                ),
            )
        self.registry.update_voice_session(room_id, session_id, status="listening")
        await self.registry.broadcast_voice_state(room_id)

    async def _append_error(self, room_id: str, session_id: str, error: AgentError) -> None:
        self.registry.append_voice_event(
            room_id,
            VoiceTranscriptEvent(
                eventId=_event_id("voice-error", room_id, session_id),
                sessionId=session_id,
                roomId=room_id,
                type="error",
                error=error,
                provider="deepgram",
                createdAt=datetime.now(UTC),
            ),
        )
