import asyncio
from dotenv import load_dotenv
load_dotenv("backend/.env")

from groq import AsyncGroq
from backend.agent.tools import TOOL_DEFINITIONS
from backend.agent.prompts import MIRA_PERSONALITY

# Remove the critical rule mentioning <function>
FIXED_PROMPT = MIRA_PERSONALITY.replace("CRITICAL: When calling a tool, you must use the standard native tool calling interface. First say your line, then invoke the tool natively. Do NOT output raw JSON or <function> tags in your text response.", "")

async def main():
    client = AsyncGroq()
    try:
        stream = await client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": FIXED_PROMPT},
                {"role": "user", "content": "Start session. I am John. I have no purchase history."}
            ],
            tools=TOOL_DEFINITIONS,
            stream=True
        )
        async for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                print(chunk.choices[0].delta.content, end="", flush=True)
            if chunk.choices and chunk.choices[0].delta.tool_calls:
                print(f"\nTOOL CALL: {chunk.choices[0].delta.tool_calls}", end="")
        print("\nSUCCESS")
    except Exception as e:
        print(f"\nERROR: {e}")

asyncio.run(main())
