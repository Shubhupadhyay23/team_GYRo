"""ElevenLabs TTS proxy endpoint.

Proxies text-to-speech requests to ElevenLabs API so the API key
stays server-side.  Returns audio/mpeg binary via StreamingResponse.
"""

import os

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/tts", tags=["tts"])

ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1"


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=1000)


@router.post("/speak")
async def speak(body: SpeakRequest):
    """Convert text to speech via ElevenLabs and return audio/mpeg."""
    print(f"[tts] TTS request: {body.text[:100]}")
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    voice_id = os.environ.get("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")

    if not api_key:
        raise HTTPException(status_code=500, detail="ELEVENLABS_API_KEY not configured")

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(
                f"{ELEVENLABS_API_URL}/text-to-speech/{voice_id}",
                headers={
                    "Accept": "audio/mpeg",
                    "Content-Type": "application/json",
                    "xi-api-key": api_key,
                },
                json={
                    "text": body.text,
                    "model_id": "eleven_turbo_v2_5",
                    "voice_settings": {
                        "stability": 0.5,
                        "similarity_boost": 0.8,
                        "style": 0.5,
                        "use_speaker_boost": True,
                    },
                    "speed": 1.2,
                },
                timeout=30.0,
            )
        except httpx.RequestError as exc:
            raise HTTPException(
                status_code=502, detail=f"ElevenLabs request failed: {exc}"
            )

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs API error ({resp.status_code}): {resp.text[:200]}",
        )

    return StreamingResponse(
        iter([resp.content]),
        media_type="audio/mpeg",
        headers={"Content-Disposition": "inline"},
    )


@router.post("/stream")
async def stream_speech(body: SpeakRequest):
    """Stream audio from ElevenLabs — returns chunked audio/mpeg."""
    print(f"[tts] TTS stream request: {body.text[:100]}")
    api_key = os.environ.get("ELEVENLABS_API_KEY")
    voice_id = os.environ.get("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL")

    if not api_key:
        raise HTTPException(status_code=500, detail="ELEVENLABS_API_KEY not configured")

    client = httpx.AsyncClient(timeout=30.0)
    try:
        req = client.build_request(
            "POST",
            f"{ELEVENLABS_API_URL}/text-to-speech/{voice_id}/stream?optimize_streaming_latency=3",
            headers={
                "Accept": "audio/mpeg",
                "Content-Type": "application/json",
                "xi-api-key": api_key,
            },
            json={
                "text": body.text,
                "model_id": "eleven_turbo_v2_5",
                "voice_settings": {
                    "stability": 0.5,
                    "similarity_boost": 0.8,
                    "style": 0.5,
                    "use_speaker_boost": True,
                },
                "speed": 1.2,
            }
        )
        resp = await client.send(req, stream=True)
    except Exception as e:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"Failed to connect to ElevenLabs: {e}")

    if resp.status_code != 200:
        await resp.aread()
        err_msg = resp.text
        await resp.aclose()
        await client.aclose()
        print(f"[tts] ElevenLabs streaming failed with {resp.status_code}: {err_msg}")
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs stream error ({resp.status_code}): {err_msg[:200]}"
        )

    async def audio_generator():
        try:
            async for chunk in resp.aiter_bytes(1024):
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(audio_generator(), media_type="audio/mpeg")
