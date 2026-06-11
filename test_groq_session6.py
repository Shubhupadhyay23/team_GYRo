import asyncio
from dotenv import load_dotenv
load_dotenv("backend/.env")

from groq import AsyncGroq
from backend.agent.tools import TOOL_DEFINITIONS
from backend.agent.prompts import build_system_prompt

async def main():
    client = AsyncGroq()
    system_prompt = build_system_prompt(
        user_profile={"name": "Test"},
        purchases=[],
        purchase_stats=None,
        calendar_events=[],
        session_history=[],
        session_state={}
    )
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": "A new user just stepped up to the mirror. Introduce yourself and start the session."}
    ]
    try:
        stream = await client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=messages,
            tools=TOOL_DEFINITIONS,
            stream=True
        )
        async for chunk in stream:
            pass
        print("SUCCESS")
    except Exception as e:
        import traceback
        traceback.print_exc()

asyncio.run(main())
