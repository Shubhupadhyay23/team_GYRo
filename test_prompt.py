import asyncio
from groq import AsyncGroq
from backend.agent.tools import TOOL_DEFINITIONS
from backend.agent.prompts import build_system_prompt
import os

async def test_prompt(prompt_addon: str):
    print(f"\n--- Testing Addon: {prompt_addon} ---")
    client = AsyncGroq()
    system_prompt = build_system_prompt(
        user_profile={"name": "Test"}, purchases=[], purchase_stats=None, calendar_events=[], session_history=[], session_state={}
    )
    system_prompt = system_prompt.replace("CRITICAL: When calling tools, you MUST use the native JSON tool call format provided by the API. Do NOT use `<function>` tags. You may output text before the tool call.", "")
    system_prompt += "\n" + prompt_addon
    
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
        content_out = ""
        tools_out = []
        async for chunk in stream:
            if chunk.choices[0].delta.content:
                content_out += chunk.choices[0].delta.content
            if chunk.choices[0].delta.tool_calls:
                tools_out.extend(chunk.choices[0].delta.tool_calls)
        print("CONTENT:", content_out)
        print("TOOL CALLS:", [t.function.name for t in tools_out])
    except Exception as e:
        print("EXCEPTION:", str(e))

async def main():
    await test_prompt("When calling a tool, you must use the standard native tool calling interface.")
    await test_prompt("First say your line. Then, invoke the tool call natively using the platform's tool capabilities.")
    await test_prompt("") # Original without CRITICAL

asyncio.run(main())
