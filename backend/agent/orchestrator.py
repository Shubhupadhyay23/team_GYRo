"""Mira — Event-driven AI agent orchestrator.

Receives events (voice, gestures, poses, silence) and orchestrates Claude API
calls with tool use. Streams responses to HeyGen for voice output and broadcasts
tool results to the frontend via Socket.io.
"""

import asyncio
import copy
import json
import os
import time
from dataclasses import dataclass, field
from typing import Dict, Optional
from uuid import uuid4

import groq
from groq import AsyncGroq
from dotenv import load_dotenv

from agent.prompts import build_system_prompt, build_recommendation_prompt, get_mira_system_prompt
from agent.tools import TOOL_DEFINITIONS, execute_tool
from agent.memory import (
    load_user_profile,
    load_user_purchases,
    load_past_sessions,
    load_purchase_statistics,
    save_session_summary,
    get_user_oauth_token,
    refresh_calendar_events,
)
from models.database import NeonHTTPClient
from services.user_data_service import (
    get_user_profile_and_purchases,
    is_new_user,
    save_outfits_to_database,
)

load_dotenv()

SONNET_MODEL = "llama-3.3-70b-versatile"
HAIKU_MODEL = "llama-3.1-8b-instant"
SILENCE_TIMEOUT_SECONDS = 5
EVENT_BATCH_WINDOW_MS = 200
SOFT_API_LIMIT = 20
MAX_TOOL_RESULT_CHARS = 20_000  # ~5k tokens max per tool result in history

# Initialize Anthropic client for recommendation pipeline
groq_client = AsyncGroq(api_key=os.environ.get("GROQ_API_KEY", "missing_key"))


@dataclass
class SessionState:
    """Tracks state for a single mirror session."""

    session_id: str = field(default_factory=lambda: str(uuid4()))
    user_id: str = ""
    api_calls: int = 0
    items_shown: int = 0
    likes: int = 0
    dislikes: int = 0
    liked_items: list = field(default_factory=list)
    conversation_history: list = field(default_factory=list)
    is_active: bool = True
    last_input_time: float = field(default_factory=time.time)
    wrapping_up: bool = False
    is_processing: bool = False
    user_context: dict = field(default_factory=dict)
    system_prompt: str = ""
    _last_shown_item: dict | None = None
    _event_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _snapshot_future: asyncio.Future | None = None
    _photo_taken: bool = False
    _interrupted: bool = False


class MiraOrchestrator:
    """Event-driven orchestrator for the Mira AI stylist agent."""

    def __init__(self, socket_io=None):
        self.client = AsyncGroq(api_key=os.environ.get("GROQ_API_KEY", "missing_key"))
        self.sio = socket_io
        self.sessions: dict[str, SessionState] = {}
        self._silence_tasks: dict[str, asyncio.Task] = {}

    async def interrupt(self, user_id: str) -> None:
        """Request interruption of the current Claude stream for a user.

        Sets a flag that the stream loop checks each iteration. No lock needed —
        this runs outside _event_lock so it can fire while _call_claude holds it.
        """
        session = self.sessions.get(user_id)
        if session:
            session._interrupted = True
            print(f"[mira] Interrupt requested for {user_id}")

    async def start_session(self, user_id: str) -> SessionState:
        """Initialize a new Mira session for a user."""
        # End any existing session to prevent orphaned timers
        if user_id in self.sessions:
            await self.end_session(user_id)

        session = SessionState(user_id=user_id)
        self.sessions[user_id] = session

        # Load user data from DB in parallel — fall back to empty defaults if any fail
        profile = {}
        purchases = []
        past_sessions = []
        oauth_token = None
        purchase_stats = {}
        db = NeonHTTPClient()
        try:
            profile, purchases, past_sessions, oauth_token, purchase_stats = await asyncio.gather(
                load_user_profile(db, user_id),
                load_user_purchases(db, user_id),
                load_past_sessions(db, user_id),
                get_user_oauth_token(db, user_id),
                load_purchase_statistics(db, user_id),
            )
        except Exception as e:
            print(f"[mira] Failed to load user data for {user_id}, using defaults: {e}")
        finally:
            await db.close()

        # Phase 2: Refresh calendar events from Google API (needs oauth_token from phase 1)
        calendar_events = []
        if oauth_token:
            db = NeonHTTPClient()
            try:
                calendar_events = await refresh_calendar_events(db, user_id, oauth_token)
                print(f"[mira] Loaded {len(calendar_events)} calendar events for {user_id}")
            except Exception as e:
                print(f"[mira] Calendar refresh failed for {user_id}, continuing without: {e}")
            finally:
                await db.close()

        # Store on session for tool access
        session.user_context = {
            "profile": profile,
            "purchases": purchases,
            "past_sessions": past_sessions,
            "oauth_token": oauth_token,
            "purchase_stats": purchase_stats,
            "calendar_events": calendar_events,
        }

        # Signal frontend that user data is loaded (drives loading screen text)
        if self.sio:
            await self.sio.emit("session_data_loaded", {
                "user_name": profile.get("name", ""),
                "has_purchases": len(purchases) > 0,
                "purchase_count": len(purchases),
            }, room=user_id)

        # Build system prompt with all user data
        session.system_prompt = build_system_prompt(
            user_profile=profile,
            purchases=purchases,
            purchase_stats=purchase_stats,
            calendar_events=calendar_events,
            session_history=past_sessions,
            session_state={
                "items_shown": 0,
                "likes": 0,
                "dislikes": 0,
                "api_calls": 0,
            },
        )

        # Emit system prompt for debugging
        if self.sio:
            await self.sio.emit(
                "debug_system_prompt",
                {"prompt": session.system_prompt},
                room=user_id,
            )

        # Create the DB session record (best-effort)
        try:
            db = NeonHTTPClient()
            try:
                await db.execute(
                    "INSERT INTO sessions (id, user_id, started_at, status) "
                    "VALUES ($1, $2::uuid, now(), 'active')",
                    [session.session_id, user_id],
                )
            finally:
                await db.close()
        except Exception as e:
            print(f"[mira] Failed to insert session record for {user_id}: {e}")

        # Start silence detection
        self._start_silence_timer(user_id)

        # Brief pause so frontend can initialize TTS (MediaSource + SourceBuffer)
        # before the first audio chunks arrive
        await asyncio.sleep(1.5)

        # Trigger Mira's opening line
        await self.handle_event(user_id, {
            "type": "session_start",
            "message": "A new user just stepped up to the mirror. Introduce yourself and start the session.",
        })

        return session

    async def handle_event(self, user_id: str, event: dict) -> None:
        """Handle an incoming event and generate Mira's response.

        Events are: voice, gesture (swipe_right, swipe_left, thumbs_up, thumbs_down),
        pose, snapshot, silence, session_start.
        """
        session = self.sessions.get(user_id)
        if not session or not session.is_active:
            print(f"[mira] handle_event: no active session for {user_id}, ignoring event {event.get('type', '?')}")
            return

        # If a take_photo Future is pending and this is a snapshot, resolve it
        # immediately and return — do NOT acquire the event lock (the lock is
        # already held by _handle_take_photo's caller chain, so acquiring it
        # here would deadlock).
        if (
            event.get("type") == "snapshot"
            and session._snapshot_future is not None
            and not session._snapshot_future.done()
        ):
            image_data = event.get("image_base64", "")
            session._snapshot_future.set_result(image_data)
            print(f"[mira] take_photo: resolved snapshot Future for {user_id}")
            return

        # Block all new events once graceful shutdown has started
        if session.wrapping_up:
            print(f"[mira] Session wrapping up for {user_id}, ignoring event {event.get('type', '?')}")
            return

        async with session._event_lock:
            session.is_processing = True
            try:
                # Only restart the silence timer on real user input — not on
                # silence events themselves, which would create a feedback loop
                # (silence → Mira speaks → new timer → silence → repeat).
                if event.get("type") != "silence":
                    session.last_input_time = time.time()
                    self._start_silence_timer(user_id)

                # Track gesture outcomes — only thumbs express preference;
                # swipes are pure navigation and don't affect like/dislike counts
                gesture = event.get("gesture")

                if gesture == "thumbs_up":
                    session.likes += 1
                    if session._last_shown_item:
                        session.liked_items.append(session._last_shown_item)
                elif gesture == "thumbs_down":
                    session.dislikes += 1

                # Build user message from event
                user_message = self._event_to_message(event)
                session.conversation_history.append({
                    "role": "user",
                    "content": user_message,
                })

                # Update system prompt with current session state
                session.system_prompt = build_system_prompt(
                    user_profile=session.user_context.get("profile", {}),
                    purchases=session.user_context.get("purchases", []),
                    purchase_stats=session.user_context.get("purchase_stats"),
                    calendar_events=session.user_context.get("calendar_events"),
                    session_history=session.user_context.get("past_sessions", []),
                    session_state={
                        "items_shown": session.items_shown,
                        "likes": session.likes,
                        "dislikes": session.dislikes,
                        "api_calls": session.api_calls,
                    },
                )

                # Call Claude
                try:
                    await self._call_llm(session)
                except Exception as e:
                    print(f"[mira] Error calling Claude: {e}")
                    await self._stream_text(user_id, "Hmm, my brain glitched for a second. What were we talking about?")
                    await self._stream_text(user_id, "", end_of_message=True)
            finally:
                session.is_processing = False

    def _select_model(self, session: SessionState) -> tuple[str, int]:
        """Select the right model and max_tokens for this turn."""
        return SONNET_MODEL, 2048

    def _validate_history(self, session: SessionState) -> None:
        """Validate conversation history and truncate to last valid point if corrupted.

        Checks:
        1. Alternating user → assistant → user roles (tool_result messages are user role)
        2. Every assistant message with tool_use blocks is immediately followed by a
           user message with matching tool_result blocks

        If corruption is found, truncates history to the last valid position and logs
        a warning. This is defense-in-depth — the event lock should prevent corruption,
        but edge cases or future bugs could still cause issues.
        """
        history = session.conversation_history
        if not history:
            return

        valid_up_to = 0  # exclusive — history[:valid_up_to] is valid

        i = 0
        while i < len(history):
            msg = history[i]
            role = msg.get("role")

            # First message must be from user
            if i == 0 and role != "user":
                print(f"[mira] History validation: first message is {role}, expected user — truncating")
                break

            # Check alternating roles (user and assistant)
            if i > 0:
                prev_role = history[i - 1].get("role")
                # After user, expect assistant; after assistant, expect user
                if prev_role == role and role != "user":
                    # Two consecutive assistant messages — corruption
                    print(f"[mira] History validation: consecutive {role} messages at index {i} — truncating")
                    break
                if prev_role == "user" and role == "user":
                    # Two consecutive user messages — corruption (unless first is tool_result)
                    # A tool_result user message followed by a regular user message is invalid
                    print(f"[mira] History validation: consecutive user messages at index {i} — truncating")
                    break

            # If this is an assistant message with tool_use, verify next message has tool_results
            if role == "assistant":
                content = msg.get("content", [])
                has_tool_use = False
                if isinstance(content, list):
                    has_tool_use = any(
                        (getattr(block, "type", None) == "tool_use")
                        or (isinstance(block, dict) and block.get("type") == "tool_use")
                        for block in content
                    )

                if has_tool_use:
                    # Must be followed by a user message with tool_result blocks
                    if i + 1 >= len(history):
                        print(f"[mira] History validation: tool_use at index {i} with no following tool_result — truncating")
                        break
                    next_msg = history[i + 1]
                    if next_msg.get("role") != "user":
                        print(f"[mira] History validation: tool_use at index {i} followed by {next_msg.get('role')} — truncating")
                        break
                    next_content = next_msg.get("content", [])
                    has_tool_result = isinstance(next_content, list) and any(
                        isinstance(block, dict) and block.get("type") == "tool_result"
                        for block in next_content
                    )
                    if not has_tool_result:
                        print(f"[mira] History validation: tool_use at index {i} followed by user message without tool_result — truncating")
                        break

            # Check for empty text content blocks in assistant messages
            if role == "assistant":
                content = msg.get("content", [])
                if not isinstance(content, list):
                    content = []
                has_empty_text = any(
                    isinstance(block, dict)
                    and block.get("type") == "text"
                    and not block.get("text", "").strip()
                    for block in content
                )
                if has_empty_text:
                    print(f"[mira] History validation: empty text block at index {i} — truncating")
                    break

            valid_up_to = i + 1
            i += 1

        if valid_up_to < len(history):
            removed = len(history) - valid_up_to
            session.conversation_history = history[:valid_up_to]
            print(f"[mira] History validation: removed {removed} messages, kept {valid_up_to} for {session.user_id}")

    def _compact_history(self, session: SessionState) -> None:
        """Compact older history entries to stay under the 200k token context limit.

        Base64 images (~50-100k tokens each) and large tool-result JSON are the
        main culprits. Strategy: keep the last KEEP_RECENT messages intact and
        replace images / truncate tool results in everything before that.
        """
        KEEP_RECENT = 6   # last ~3 turns untouched
        MAX_TOOL_RESULT_CHARS = 400  # truncate older tool result strings

        history = session.conversation_history
        if len(history) <= KEEP_RECENT:
            return

        compact_boundary = len(history) - KEEP_RECENT
        compacted_images = 0
        compacted_tool_results = 0

        for idx in range(compact_boundary):
            msg = history[idx]
            content = msg.get("content")
            if not isinstance(content, list):
                continue

            new_content = []
            for block in content:
                # --- dict blocks (user messages, tool_result) ---
                if isinstance(block, dict):
                    btype = block.get("type")

                    # Replace base64 images with a lightweight placeholder
                    if btype == "image":
                        new_content.append({
                            "type": "text",
                            "text": "[image removed — earlier in conversation]",
                        })
                        compacted_images += 1
                        continue

                    # Truncate large tool_result content strings
                    if btype == "tool_result":
                        rc = block.get("content", "")
                        if isinstance(rc, str) and len(rc) > MAX_TOOL_RESULT_CHARS:
                            block = {**block, "content": rc[:MAX_TOOL_RESULT_CHARS] + " ...[truncated]"}
                            compacted_tool_results += 1
                        # tool_result content can also be a list (take_photo returns list with image)
                        elif isinstance(rc, list):
                            new_rc = []
                            for sub in rc:
                                if isinstance(sub, dict) and sub.get("type") == "image":
                                    new_rc.append({"type": "text", "text": "[image removed — earlier in conversation]"})
                                    compacted_images += 1
                                else:
                                    new_rc.append(sub)
                            block = {**block, "content": new_rc}

                    new_content.append(block)
                    continue

                # --- SDK ContentBlock objects (assistant messages) ---
                if hasattr(block, "type") and block.type == "image":
                    new_content.append({
                        "type": "text",
                        "text": "[image removed — earlier in conversation]",
                    })
                    compacted_images += 1
                    continue

                new_content.append(block)

            history[idx]["content"] = new_content

        if compacted_images or compacted_tool_results:
            print(
                f"[mira] History compacted for {session.user_id}: "
                f"removed {compacted_images} images, truncated {compacted_tool_results} tool results "
                f"(kept last {KEEP_RECENT} messages intact)"
            )

    @staticmethod
    def _strip_data_urls(obj):
        """Recursively replace base64 data: URLs with a short placeholder.

        Used to sanitize tool results before storing in conversation history.
        Returns a new object — does not mutate the original.
        """
        if isinstance(obj, dict):
            return {k: MiraOrchestrator._strip_data_urls(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [MiraOrchestrator._strip_data_urls(item) for item in obj]
        if isinstance(obj, str) and obj.startswith("data:image/"):
            return "[image]"
        return obj

    @staticmethod
    def _count_chars_recursive(obj, depth: int = 0) -> int:
        """Count total string characters in a nested structure (dicts, lists, SDK objects)."""
        if depth > 10:
            return 0
        if isinstance(obj, str):
            return len(obj)
        if isinstance(obj, dict):
            return sum(MiraOrchestrator._count_chars_recursive(v, depth + 1) for v in obj.values())
        if isinstance(obj, list):
            return sum(MiraOrchestrator._count_chars_recursive(item, depth + 1) for item in obj)
        # SDK ContentBlock objects (TextBlock, ToolUseBlock, etc.)
        if hasattr(obj, "text"):
            total = len(obj.text)
            if hasattr(obj, "input"):
                total += MiraOrchestrator._count_chars_recursive(obj.input, depth + 1)
            return total
        if hasattr(obj, "input"):
            return MiraOrchestrator._count_chars_recursive(obj.input, depth + 1)
        return 0

    def _estimate_history_tokens(self, session: SessionState) -> int:
        """Rough token estimate for conversation history + system prompt.

        Uses chars / 4 heuristic. Counts ALL nested content including list-valued
        tool_result blocks, SDK ContentBlock objects, and deeply nested dicts.
        """
        total_chars = len(session.system_prompt)
        for msg in session.conversation_history:
            content = msg.get("content", "")
            total_chars += self._count_chars_recursive(content)
        return total_chars // 4

    def _emergency_compact(self, session: SessionState) -> None:
        """Aggressive compaction when estimated tokens exceed safety threshold.

        Keeps only the last 2 messages intact, truncates tool results to 200 chars,
        and strips ALL images and tool results outside the keep window.
        """
        KEEP_RECENT = 2
        MAX_CHARS = 200

        history = session.conversation_history
        if len(history) <= KEEP_RECENT:
            return

        compact_boundary = len(history) - KEEP_RECENT

        for idx in range(compact_boundary):
            msg = history[idx]
            content = msg.get("content")
            if not isinstance(content, list):
                continue

            new_content = []
            for block in content:
                if isinstance(block, dict):
                    btype = block.get("type")
                    if btype == "image":
                        new_content.append({
                            "type": "text",
                            "text": "[image removed]",
                        })
                        continue
                    if btype == "tool_result":
                        rc = block.get("content", "")
                        if isinstance(rc, str) and len(rc) > MAX_CHARS:
                            block = {**block, "content": rc[:MAX_CHARS] + " ...[truncated]"}
                        elif isinstance(rc, list):
                            new_rc = []
                            for sub in rc:
                                if isinstance(sub, dict) and sub.get("type") == "image":
                                    new_rc.append({"type": "text", "text": "[image removed]"})
                                else:
                                    new_rc.append(sub)
                            block = {**block, "content": new_rc}
                    new_content.append(block)
                    continue

                if hasattr(block, "type") and block.type == "image":
                    new_content.append({
                        "type": "text",
                        "text": "[image removed]",
                    })
                    continue

                new_content.append(block)

            history[idx]["content"] = new_content

        print(f"[mira] Emergency compaction done for {session.user_id} (kept last {KEEP_RECENT})")

    def _prepare_messages(self, session: SessionState) -> list:
        """Create a sanitized copy of conversation history for the API call."""
        sanitized = [{"role": "system", "content": session.system_prompt}]
        for msg in session.conversation_history:
            # We assume history is already stored in OpenAI compatible format
            sanitized.append(msg)
        return sanitized

    @staticmethod
    def _strip_data_urls_in_string(s: str) -> str:
        return s

    async def _call_llm(self, session: SessionState, tool_depth: int = 0) -> None:
        """Make a streaming Groq API call with tool use."""
        if session.wrapping_up:
            return

        if tool_depth >= 3:
            print(f"[mira] Tool depth limit reached ({tool_depth}) for {session.user_id}, stopping")
            return

        session.api_calls += 1
        model, max_tokens = self._select_model(session)
        print(f"[mira] Using {model} (max_tokens={max_tokens}) for {session.user_id}")

        api_messages = self._prepare_messages(session)

        collected_text = ""
        tool_calls_dict = {}
        interrupted = False

        try:
            stream = await self.client.chat.completions.create(
                model=model,
                max_tokens=max_tokens,
                messages=api_messages,
                tools=TOOL_DEFINITIONS,
                stream=True
            )

            stream_buffer = ""
            in_tag = False
            import re

            async for chunk in stream:
                if session._interrupted:
                    interrupted = True
                    break

                if not chunk.choices:
                    continue

                delta = chunk.choices[0].delta

                if delta.content:
                    # XML Leaking Interceptor
                    # We buffer the stream to ensure we don't send <function=...> to TTS
                    stream_buffer += delta.content

                    while stream_buffer:
                        if not in_tag:
                            tag_start = stream_buffer.find("<")
                            if tag_start == -1:
                                # Safe to stream
                                collected_text += stream_buffer
                                await self._stream_text(session.user_id, stream_buffer)
                                stream_buffer = ""
                            else:
                                if tag_start > 0:
                                    # Stream the safe prefix
                                    safe_part = stream_buffer[:tag_start]
                                    collected_text += safe_part
                                    await self._stream_text(session.user_id, safe_part)
                                    stream_buffer = stream_buffer[tag_start:]

                                # Buffer starts with <
                                if len(stream_buffer) < len("<function"):
                                    if "<function".startswith(stream_buffer):
                                        break  # Wait for more chunks to be sure
                                    else:
                                        # False alarm, pop the < and continue
                                        collected_text += stream_buffer[0]
                                        await self._stream_text(session.user_id, stream_buffer[0])
                                        stream_buffer = stream_buffer[1:]
                                else:
                                    if stream_buffer.startswith("<function"):
                                        in_tag = True
                                    else:
                                        # False alarm
                                        collected_text += stream_buffer[0]
                                        await self._stream_text(session.user_id, stream_buffer[0])
                                        stream_buffer = stream_buffer[1:]
                        else:
                            # Inside <function... wait for </function>
                            tag_end = stream_buffer.find("</function>")
                            if tag_end != -1:
                                full_tag = stream_buffer[:tag_end + 11]
                                stream_buffer = stream_buffer[tag_end + 11:]
                                in_tag = False
                                
                                # Parse and inject into tool_calls_dict
                                match = re.search(r'<function=(\w+)>(.*?)</function>', full_tag, re.DOTALL)
                                if match:
                                    func_name = match.group(1)
                                    func_args = match.group(2)
                                    idx = len(tool_calls_dict)
                                    tool_calls_dict[idx] = {
                                        "id": f"call_intercept_{idx}",
                                        "type": "function",
                                        "function": {"name": func_name, "arguments": func_args}
                                    }
                                    print(f"[mira] INTERCEPTED LEAKED XML: {func_name}")
                            else:
                                break  # Wait for more chunks

                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        idx = tc.index
                        if idx not in tool_calls_dict:
                            tool_calls_dict[idx] = {
                                "id": tc.id,
                                "type": "function",
                                "function": {"name": tc.function.name, "arguments": ""}
                            }
                        if tc.function.arguments:
                            tool_calls_dict[idx]["function"]["arguments"] += tc.function.arguments

            if interrupted:
                # Flush buffer if interrupted
                if stream_buffer and not in_tag:
                    collected_text += stream_buffer
                    await self._stream_text(session.user_id, stream_buffer)
                
                stub = collected_text.strip()
                if stub:
                    session.conversation_history.append({
                        "role": "assistant",
                        "content": stub,
                    })
                else:
                    if session.conversation_history and session.conversation_history[-1]["role"] == "user":
                        session.conversation_history.pop()
                await self._stream_text(session.user_id, "", end_of_message=True)
                session._interrupted = False
                return

            # Stream finished, flush remaining buffer
            if stream_buffer and not in_tag:
                collected_text += stream_buffer
                await self._stream_text(session.user_id, stream_buffer)
            
            if collected_text:
                await self._stream_text(session.user_id, "", end_of_message=True)

        except Exception as e:
            print(f"[mira] Groq API call failed for {session.user_id}: {e}")
            if session.conversation_history and session.conversation_history[-1]["role"] == "user":
                session.conversation_history.pop()
            if session.conversation_history and session.conversation_history[-1].get("role") == "assistant":
                if "tool_calls" in session.conversation_history[-1]:
                    session.conversation_history.pop()
            fallback = "Hmm, my brain glitched for a second. What were we talking about?"
            await self._stream_text(session.user_id, fallback)
            await self._stream_text(session.user_id, "", end_of_message=True)
            return

        tool_uses = list(tool_calls_dict.values())
        
        assistant_msg = {"role": "assistant", "content": collected_text or None}
        if tool_uses:
            assistant_msg["tool_calls"] = tool_uses
        session.conversation_history.append(assistant_msg)

        if tool_uses:
            await self._handle_tool_calls(session, tool_uses, tool_depth)

    async def _handle_tool_calls(self, session: SessionState, tool_uses: list, tool_depth: int = 0) -> None:
        session_ending = False

        for tc in tool_uses:
            tool_name = tc["function"]["name"]
            tool_id = tc["id"]
            try:
                tool_input = json.loads(tc["function"]["arguments"]) if tc["function"]["arguments"] else {}
            except Exception:
                tool_input = {}
            
            print(f"[mira] Tool call: {tool_name}")

            if tool_name == "take_photo":
                result = await self._handle_take_photo(session)
                session.conversation_history.append({
                    "role": "tool",
                    "tool_call_id": tool_id,
                    "content": result
                })
                continue

            if tool_name == "end_session":
                session.conversation_history.append({
                    "role": "tool",
                    "tool_call_id": tool_id,
                    "content": "Session ended."
                })
                session_ending = True
                break

            try:
                result_dict = await execute_tool(
                    tool_name=tool_name,
                    tool_input=tool_input,
                    user_context={
                        "user_id": session.user_id,
                        "session_id": session.session_id,
                        "oauth_token": session.user_context.get("oauth_token"),
                    },
                )
            except Exception as e:
                result_dict = {"error": f"Tool execution failed: {str(e)}"}

            frontend_payload = result_dict.pop("frontend_payload", None)
            if frontend_payload and self.sio:
                await self.sio.emit("tool_result", frontend_payload, room=session.user_id)

            if tool_name == "display_product" and result_dict.get("items"):
                session.items_shown += len(result_dict["items"])
                if result_dict["items"]:
                    session._last_shown_item = result_dict["items"][0]

            stripped_json = json.dumps(result_dict)
            if len(stripped_json) > 10000:
                stripped_json = stripped_json[:10000] + ' ...[truncated]'

            session.conversation_history.append({
                "role": "tool",
                "tool_call_id": tool_id,
                "content": stripped_json
            })

        if session_ending:
            user_id = session.user_id
            await self.end_session(user_id)
            await self._advance_queue(user_id)
            return

        await self._call_llm(session, tool_depth=tool_depth + 1)

    async def _handle_take_photo(self, session: SessionState) -> str:
        if session._photo_taken:
            return "Photo already taken this session."
        if not self.sio:
            return "Camera not available."

        loop = asyncio.get_running_loop()
        session._snapshot_future = loop.create_future()
        await self.sio.emit("request_snapshot", {"user_id": session.user_id}, room=session.user_id)

        try:
            image_base64 = await asyncio.wait_for(session._snapshot_future, timeout=5.0)
        except asyncio.TimeoutError:
            session._snapshot_future = None
            return "Camera timed out."
        finally:
            session._snapshot_future = None

        session._photo_taken = True
        
        print("[mira] Sending photo to Groq Vision model...")
        try:
            vision_response = await self.client.chat.completions.create(
                model="llama-3.2-90b-vision-preview",
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "Describe this user's outfit in detail. What colors are they wearing? What style or fit? Be factual and concise."},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/jpeg;base64,{image_base64}"
                                }
                            }
                        ]
                    }
                ],
                max_tokens=200
            )
            analysis = vision_response.choices[0].message.content
            print(f"[mira] Vision analysis: {analysis}")
            return f"Photo taken successfully. Vision analysis: {analysis}"
        except Exception as e:
            print(f"[mira] Vision model failed: {e}")
            return "Photo taken successfully, but vision analysis failed. Proceed based on user preferences."

    async def end_session(self, user_id: str) -> dict | None:
        """End a session and save summary."""
        session = self.sessions.get(user_id)
        if not session:
            return None

        session.is_active = False
        self._cancel_silence_timer(user_id)

        # Generate session summary via Claude
        try:
            summary = await self._generate_summary(session)
        except Exception as e:
            print(f"[mira] Failed to generate summary for {user_id}: {e}")
            summary = "Session ended before summary could be generated."

        # Save to DB — wrapped in error handling so a DB failure
        # doesn't prevent the session_ended event from reaching the frontend
        db = NeonHTTPClient()
        try:
            await save_session_summary(
                db=db,
                session_id=session.session_id,
                summary=summary,
                liked_items=session.liked_items,
                reactions={
                    "likes": session.likes,
                    "dislikes": session.dislikes,
                    "items_shown": session.items_shown,
                },
            )
        except Exception as e:
            print(f"[mira] Failed to save session summary: {e}")
        finally:
            await db.close()

        # Emit session end to frontend
        if self.sio:
            await self.sio.emit(
                "session_ended",
                {
                    "session_id": session.session_id,
                    "summary": summary,
                    "liked_items": session.liked_items,
                    "stats": {
                        "items_shown": session.items_shown,
                        "likes": session.likes,
                        "dislikes": session.dislikes,
                    },
                    "user_name": session.user_context.get("profile", {}).get("name", ""),
                },
                room=user_id,
            )

        del self.sessions[user_id]
        return {"summary": summary, "liked_items": session.liked_items}

    async def _advance_queue(self, user_id: str) -> None:
        """Mark the user's queue entry as completed and advance the next user.

        Best-effort — a failure here shouldn't block session teardown.
        """
        try:
            from routers.queue import _try_advance_next, get_queue_snapshot
            db = NeonHTTPClient()
            try:
                await db.execute(
                    "UPDATE queue SET status = 'completed' WHERE user_id = $1::uuid AND status = 'active'",
                    [user_id],
                )
                await _try_advance_next(db)
                snapshot = await get_queue_snapshot(db)
                if self.sio:
                    await self.sio.emit("queue_updated", snapshot, room="mirror")
                print(f"[mira] Queue advanced after end_session for {user_id}")
            finally:
                await db.close()
        except Exception as e:
            print(f"[mira] Failed to advance queue after end_session for {user_id}: {e}")

    async def _generate_summary(self, session: SessionState) -> str:
        """Ask LLM to generate a short session summary for memory."""
        response = await self.client.chat.completions.create(
            model=HAIKU_MODEL,
            max_tokens=200,
            messages=[
                {"role": "system", "content": "Summarize this styling session in 2-3 sentences for future reference. Include key style preferences discovered, items liked, and overall vibe."},
                {
                    "role": "user",
                    "content": f"Session had {session.items_shown} items shown, {session.likes} liked, {session.dislikes} disliked. Liked items: {json.dumps(session.liked_items[:5])}",
                }
            ],
        )
        return response.choices[0].message.content

    async def _graceful_shutdown(self, session: SessionState) -> None:
        """Gracefully end a session when the API limit is reached.

        Generates a warm closing speech, streams it via TTS, then ends the session.
        """
        user_id = session.user_id
        self._cancel_silence_timer(user_id)

        # Generate and stream the closing speech so the user hears a goodbye
        closing_speech = await self._generate_closing_speech(session)
        await self._stream_text(user_id, closing_speech)
        await self._stream_text(user_id, "", end_of_message=True)

        # Brief pause to let TTS start playing before session teardown
        await asyncio.sleep(0.5)

        # Guard: session may have been force-ended during the sleep
        if user_id not in self.sessions:
            print(f"[mira] Session already ended for {user_id} during graceful shutdown")
            return

        # End session — saves summary, emits session_ended with recap payload
        await self.end_session(user_id)

    async def _generate_closing_speech(self, session: SessionState) -> str:
        """Generate a warm, in-character closing message from Mira."""
        liked_names = [item.get("title", "an item") for item in session.liked_items[:5]]
        liked_str = ", ".join(liked_names) if liked_names else "the styles we explored"

        try:
            response = await self.client.chat.completions.create(
                model=HAIKU_MODEL,
                max_tokens=200,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are Mira, a warm and stylish AI fashion advisor wrapping up a session. "
                            "Give a brief closing recap (2-3 sentences). Mention their favorites, give a confidence boost, "
                            "and let them know their picks are saved to their phone. "
                            "Keep it conversational — no markdown, no lists."
                        )
                    },
                    {
                        "role": "user",
                        "content": (
                            f"Session stats: {session.items_shown} items shown, "
                            f"{session.likes} liked, {session.dislikes} passed. "
                            f"Favorites: {liked_str}. Wrap up warmly."
                        ),
                    }
                ],
            )
            return response.choices[0].message.content
        except Exception as e:
            print(f"[mira] Closing speech generation failed, using fallback: {e}")
            return "That was a great session! Your favorites are saved to your phone. See you next time!"

    def _event_to_message(self, event: dict) -> str | list:
        """Convert an event dict to a Claude user message."""
        event_type = event.get("type")

        if event_type == "voice":
            transcript = event.get("transcript", "")
            print(f"[mira] USER SAID: {transcript}")
            return transcript

        elif event_type == "gesture":
            gesture = event.get("gesture", "unknown")
            gesture_descriptions = {
                "swipe_left": "The user swiped to see the next outfit.",
                "swipe_right": "The user swiped to go back to the previous outfit.",
                "thumbs_up": "The user gave a thumbs up (like this item).",
                "thumbs_down": "The user gave a thumbs down (dislike this item).",
                "end_of_outfits": "The user has swiped through all available outfits. They've seen everything you've shown so far.",
            }
            return gesture_descriptions.get(gesture, f"The user made a {gesture} gesture.")

        elif event_type == "pose":
            return [
                {"type": "text", "text": "The user struck a new pose. Here's what they look like:"},
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": event.get("image_base64", ""),
                    },
                },
            ]

        elif event_type == "snapshot":
            return [
                {"type": "text", "text": "Here's a snapshot of the user at the mirror:"},
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": event.get("image_base64", ""),
                    },
                },
            ]

        elif event_type == "silence":
            duration = event.get("duration_seconds", SILENCE_TIMEOUT_SECONDS)
            return f"The user has been silent for {duration} seconds. Say something to keep the conversation going."

        elif event_type == "session_start":
            return event.get("message", "Start the session.")

        return str(event)

    async def _stream_text(self, user_id: str, text_chunk: str, end_of_message: bool = False) -> None:
        """Stream a text chunk to the frontend.

        When end_of_message is True, emits is_chunk=false so the frontend's
        SentenceBuffer flushes any remaining text (the last sentence has no
        trailing delimiter to trigger a boundary).
        """
        if end_of_message:
            print(f"[mira] Stream end-of-message to {user_id}")
        if self.sio:
            await self.sio.emit(
                "mira_speech",
                {"text": text_chunk, "is_chunk": not end_of_message},
                room=user_id,
            )

    def _start_silence_timer(self, user_id: str) -> None:
        """Start or restart the silence detection timer."""
        self._cancel_silence_timer(user_id)

        async def _silence_callback():
            await asyncio.sleep(SILENCE_TIMEOUT_SECONDS)
            session = self.sessions.get(user_id)
            if session and session.is_active and not session.is_processing:
                await self.handle_event(user_id, {
                    "type": "silence",
                    "duration_seconds": SILENCE_TIMEOUT_SECONDS,
                })

        self._silence_tasks[user_id] = asyncio.create_task(_silence_callback())

    def _cancel_silence_timer(self, user_id: str) -> None:
        """Cancel the silence timer for a user."""
        task = self._silence_tasks.pop(user_id, None)
        if task and not task.done():
            task.cancel()


# --- Recommendation Pipeline (standalone functions for REST endpoints) ---


def _outfits_to_display_payloads(outfits: list) -> list[dict]:
    """Convert REST pipeline outfit format into display_product-style payloads.

    Matches the frontend_payload shape emitted by the _display_product tool,
    so the mirror's tool_result listener can handle both paths identically.
    Items without flat lay images are skipped (raw product photos look wrong on overlay).
    """
    payloads = []
    for outfit in outfits:
        items = []
        for oi in outfit.get("items", []):
            item = oi.get("item", {})
            if not item.get("cleaned_image_url") and not item.get("flat_image_url"):
                continue
            items.append({
                "title": item.get("title", ""),
                "price": item.get("price", ""),
                "image_url": item.get("image_url", ""),
                "product_id": item.get("product_id", ""),
                "type": oi.get("type", ""),
                "cleaned_image_url": item.get("cleaned_image_url"),
                "flat_image_url": item.get("flat_image_url"),
                "link": item.get("link", ""),
                "source": item.get("source", ""),
            })
        if items:
            payloads.append({
                "type": "display_product",
                "items": items,
                "outfit_name": outfit.get("outfit_name", ""),
            })
    return payloads


def _extract_json_from_text(text: str) -> Optional[dict]:
    """Extract JSON from text that may contain markdown code blocks."""
    try:
        if "```json" in text:
            json_start = text.find("```json") + 7
            json_end = text.find("```", json_start)
            return json.loads(text[json_start:json_end].strip())
        elif "```" in text:
            json_start = text.find("```") + 3
            json_end = text.find("```", json_start)
            return json.loads(text[json_start:json_end].strip())
        else:
            return json.loads(text.strip())
    except json.JSONDecodeError:
        try:
            start = text.find("{")
            end = text.rfind("}") + 1
            return json.loads(text[start:end])
        except (json.JSONDecodeError, ValueError):
            return None


async def generate_outfit_recommendations(
    user_id: str, session_id: str, db: NeonHTTPClient
) -> Dict:
    """
    Orchestrate the full recommendation flow.

    1. Fetch user data (profile + purchases + top brands)
    2. Handle new users (check if needs onboarding)
    3. Call Serper directly to fetch clothing items
    4. Send user context + clothing items to Claude in a single call
    5. Parse final JSON response
    6. Generate flat lay images + save to DB in parallel
    7. Return results
    """
    from agent.tools import execute_give_recommendation, _select_diverse_items
    from services.serper_cache import serper_cache

    start_time = time.time()

    try:
        # Step 1: Fetch user data
        user_data = await get_user_profile_and_purchases(db, user_id)
        if not user_data:
            return create_error_response("user_not_found", "Unknown User")

        # Step 2: Check if new user needs onboarding
        if await is_new_user(db, user_id):
            return {
                "status": "needs_onboarding",
                "message": "User needs to complete onboarding questionnaire",
            }

        # Step 3: Call Serper directly (no Claude tool loop)
        top_brands = user_data.get("top_brands", [])
        style_profile = user_data.get("style_profile")
        gender = "mens"
        if style_profile:
            gender = style_profile.get("gender", "mens")

        tool_input = {"brands": top_brands[:5] if top_brands else [], "gender": gender}
        print(f"[Mira] Fetching clothing from Serper (brands={tool_input['brands']}, gender={gender})")
        clothing_text = await execute_give_recommendation(tool_input, session_id)

        if clothing_text.startswith("Error:") or clothing_text.startswith("No clothing"):
            return create_error_response("no_results", user_data["user"]["name"])

        # Step 4: Single Claude call with clothing items already in the prompt
        cached_items = serper_cache.get(session_id) or []
        tops = [i for i in cached_items if i.get("clothing_category") == "top"]
        bottoms = [i for i in cached_items if i.get("clothing_category") == "bottom"]
        limited_items = _select_diverse_items(tops, 10) + _select_diverse_items(bottoms, 10)

        system_prompt = get_mira_system_prompt()
        user_prompt = build_recommendation_prompt(user_data, limited_items)

        # Step 4b: Pre-generate flat lays for ALL candidate items in parallel with Claude
        async def _pregenerate_flat_lays():
            """Generate flat lays for all candidate items while Claude thinks."""
            try:
                from services.gemini_flatlay import generate_flat_lays_batch
                items_for_flatlay = [
                    {"image_url": i["image_url"], "title": i["title"], "product_id": i["product_id"]}
                    for i in limited_items if i.get("image_url") and i.get("product_id")
                ]
                if items_for_flatlay:
                    print(f"[Mira] Generating flat lay images for {len(items_for_flatlay)} items...")
                    return await generate_flat_lays_batch(items_for_flatlay)
            except ImportError:
                print("[Mira] Gemini flat lay service not available, skipping")
            except Exception as e:
                print(f"[Mira] Flat lay generation failed (non-fatal): {e}")
            return {}

        # Run Groq + flat lays in parallel
        groq_response, flat_lay_map = await asyncio.gather(
            groq_client.chat.completions.create(
                model=HAIKU_MODEL,
                max_tokens=6144,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                response_format={"type": "json_object"}
            ),
            _pregenerate_flat_lays(),
        )

        # Extract JSON from Groq response
        recommendations = None
        if groq_response.choices and groq_response.choices[0].message.content:
            recommendations = _extract_json_from_text(groq_response.choices[0].message.content)

        if not recommendations:
            return create_error_response("api_error", user_data["user"]["name"])

        # Step 5: Map flat lays to selected outfit items + save to DB
        outfits = recommendations.get("outfits", [])

        # Attach flat lay images as both flat_image_url and cleaned_image_url
        for outfit in outfits:
            for outfit_item in outfit.get("items", []):
                item = outfit_item.get("item", {})
                pid = item.get("product_id", "")
                if pid in flat_lay_map:
                    item["flat_image_url"] = flat_lay_map[pid]
                    item["cleaned_image_url"] = flat_lay_map[pid]

        outfit_ids = await save_outfits_to_database(db, session_id, outfits)

        # Attach database IDs to each outfit in the response
        for outfit in outfits:
            name = outfit.get("outfit_name", "")
            if name in outfit_ids:
                outfit["id"] = outfit_ids[name]

        # Step 6: Return results
        generation_time_ms = int((time.time() - start_time) * 1000)

        return {
            "status": "success",
            "data": recommendations,
            "generation_time_ms": generation_time_ms,
        }

    except Exception as e:
        print(f"Error generating recommendations: {e}")
        return create_error_response("api_error", "there")


def create_error_response(error_type: str, user_name: str) -> Dict:
    """
    Generate in-character error messages from Mira.

    Types: "no_results", "new_user", "api_error", "no_brands", "user_not_found"
    """
    error_messages = {
        "no_results": {
            "status": "error",
            "error_type": "no_results",
            "message": f"Hey {user_name}! I tried searching for new pieces from your favorite brands, but I'm not finding much right now. This could be a temporary glitch with the shopping search. Want to try again in a minute?",
        },
        "new_user": {
            "status": "needs_onboarding",
            "message": f"Hi {user_name}! I'd love to help you pick out some outfits, but I don't know your style yet. Let's do a quick questionnaire so I can get to know your taste!",
        },
        "api_error": {
            "status": "error",
            "error_type": "api_error",
            "message": f"Oof, {user_name} — something went wrong on my end. Technical difficulties! Give me a sec and let's try again.",
        },
        "no_brands": {
            "status": "error",
            "error_type": "no_brands",
            "message": f"Hey {user_name}! I don't have any brands to search yet. Have you done any shopping recently, or want to tell me your favorite brands in the onboarding?",
        },
        "user_not_found": {
            "status": "error",
            "error_type": "user_not_found",
            "message": "I can't find your profile. Are you logged in?",
        },
    }

    return error_messages.get(error_type, error_messages["api_error"])


async def update_outfit_reaction(
    db: NeonHTTPClient, outfit_id: str, reaction: str
) -> Dict:
    """
    Update user reaction for an outfit.

    Args:
        db: Database client
        outfit_id: UUID of the outfit
        reaction: "liked", "disliked", or "skipped"
    """
    try:
        query = """
            UPDATE session_outfits
            SET reaction = $1
            WHERE id = $2
            RETURNING id
        """
        result = await db.execute(query, [reaction, outfit_id])

        if not result:
            return {"status": "error", "message": "Outfit not found"}

        return {"status": "success"}

    except Exception as e:
        print(f"Error updating outfit reaction: {e}")
        return {"status": "error", "message": "Failed to update reaction"}
