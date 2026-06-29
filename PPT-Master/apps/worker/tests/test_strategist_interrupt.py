import json
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from pptmaster.agent import coordinator
from pptmaster.agent.strategist import build_strategist_subgraph
from pptmaster.api import orchestrate


class FakeChatResponse:
    def __init__(self, content: str):
        self.content = content


class FakeChatModel:
    async def ainvoke(self, prompt: str) -> FakeChatResponse:
        return FakeChatResponse("Proposed outline ready for review.")


async def _fake_get_chat_model(role: str) -> FakeChatModel:
    return FakeChatModel()


def build_base_state() -> dict:
    return {
        "project_id": "project-1",
        "session_id": "session-1",
        "user_id": "user-1",
        "source_files": [],
        "converted_markdown": [],
        "outline": None,
        "design_spec_path": None,
        "spec_lock_path": None,
        "confirmation_progress": {},
        "image_manifest_path": None,
        "generated_images": [],
        "svg_pages": [],
        "quality_results": [],
        "pptx_path": None,
        "current_step": 4,
        "completed_steps": [],
        "messages": [],
    }


@pytest.mark.asyncio
async def test_strategist_subgraph_interrupts_for_canvas_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("pptmaster.agent.strategist.get_chat_model", _fake_get_chat_model)

    compiled_graph = build_strategist_subgraph().compile(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": str(uuid.uuid4())}}

    first_chunks = []
    async for chunk in compiled_graph.astream(build_base_state(), config):
        first_chunks.append(chunk)

    interrupt_chunk = next((chunk["__interrupt__"][0].value for chunk in first_chunks if "__interrupt__" in chunk), None)

    assert interrupt_chunk is not None
    assert interrupt_chunk["gate"] == "canvas"
    assert interrupt_chunk["question_form"]["id"] == "gate_canvas"

    async for _ in compiled_graph.astream(Command(resume={"answers": {"decision": "approve"}}), config):
        pass

    state_snapshot = await compiled_graph.aget_state(config)
    assert state_snapshot.values["confirmation_progress"]["canvas"] == "approved"


class FakeEventGraph:
    def __init__(self) -> None:
        self.inputs = []

    async def astream_events(self, graph_input, config=None, version=None):
        self.inputs.append(graph_input)
        if False:
            yield {}


class FakeGraphContextManager:
    """Async context manager wrapping FakeEventGraph for compiled_coordinator patch."""

    def __init__(self, graph: "FakeEventGraph") -> None:
        self.graph = graph

    async def __aenter__(self) -> "FakeEventGraph":
        return self.graph

    async def __aexit__(self, *args) -> None:
        pass


class FakeDbSession:
    async def execute(self, *args, **kwargs):
        class FakeResult:
            def scalar_one_or_none(self):
                return None
        return FakeResult()

    async def commit(self):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


@asynccontextmanager
async def fake_open_db_session():
    yield FakeDbSession()


@pytest.mark.asyncio
async def test_run_pipeline_resume_uses_command_resume(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_graph = FakeEventGraph()

    def fake_compiled_coordinator():
        return FakeGraphContextManager(fake_graph)

    async def fake_aget_state(*args, **kwargs):
        class FakeSnapshot:
            tasks = ()
        return FakeSnapshot()

    async def fake_broadcast_agent_message(*args, **kwargs):
        return None

    monkeypatch.setattr(orchestrate, "compiled_coordinator", fake_compiled_coordinator)
    monkeypatch.setattr(orchestrate.ws_manager, "broadcast_agent_message", fake_broadcast_agent_message)
    monkeypatch.setattr(orchestrate, "open_db_session", fake_open_db_session)

    # Patch aget_state on the fake graph so _handle_pending_interrupt returns False
    fake_graph.aget_state = fake_aget_state

    await orchestrate._run_pipeline_resume(
        session_id="session-1",
        thread_id="thread-1",
        user_response={"answers": {"decision": "approve"}},
        config={"configurable": {"thread_id": "thread-1"}},
    )

    assert isinstance(fake_graph.inputs[0], Command)
    assert fake_graph.inputs[0].resume == {"answers": {"decision": "approve"}}


@pytest.mark.asyncio
async def test_coordinator_step_4_uses_interrupting_strategist_subgraph(monkeypatch: pytest.MonkeyPatch) -> None:
    async def passthrough_step(state: dict) -> dict:
        return {"current_step": state.get("current_step", 1)}

    monkeypatch.setattr(coordinator, "step_1_source_processing", passthrough_step)
    monkeypatch.setattr(coordinator, "step_2_create_project", passthrough_step)
    monkeypatch.setattr(coordinator, "step_3_template_selection", passthrough_step)
    monkeypatch.setattr(coordinator, "step_5_image_generator", passthrough_step)
    monkeypatch.setattr(coordinator, "step_6_executor", passthrough_step)
    monkeypatch.setattr(coordinator, "step_7_post_processing", passthrough_step)
    monkeypatch.setattr("pptmaster.agent.coordinator.get_chat_model", _fake_get_chat_model)
    monkeypatch.setattr("pptmaster.agent.strategist.get_chat_model", _fake_get_chat_model)

    compiled_graph = coordinator.create_coordinator_graph().compile(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": str(uuid.uuid4())}}

    streamed_chunks = []
    state = build_base_state()
    state["current_step"] = 1

    async for chunk in compiled_graph.astream(state, config):
        streamed_chunks.append(chunk)

    interrupt_chunk = next((chunk["__interrupt__"][0].value for chunk in streamed_chunks if "__interrupt__" in chunk), None)

    assert interrupt_chunk is not None
    assert interrupt_chunk["gate"] == "canvas"


@pytest.mark.asyncio
async def test_page_count_gate_records_explicit_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("pptmaster.agent.strategist.get_chat_model", _fake_get_chat_model)

    compiled_graph = build_strategist_subgraph().compile(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": str(uuid.uuid4())}}

    # Drive past canvas gate to reach page_count gate
    async for _ in compiled_graph.astream(build_base_state(), config):
        pass
    async for _ in compiled_graph.astream(Command(resume={"answers": {"decision": "approve"}}), config):
        pass

    # Now at page_count gate; submit explicit mode with value 15
    async for _ in compiled_graph.astream(
        Command(resume={"answers": {"decision": "approve", "page_count_mode": "explicit", "page_count": 15}}),
        config,
    ):
        pass

    snapshot = await compiled_graph.aget_state(config)
    assert snapshot.values["confirmation_progress"]["page_count"] == "approved"
    assert snapshot.values["page_count_mode"] == "explicit"
    assert snapshot.values["page_count"] == 15


@pytest.mark.asyncio
async def test_page_count_gate_accepts_minimum_of_one(monkeypatch: pytest.MonkeyPatch) -> None:
    """page_count=1 is the new lower bound; ensures users can request a single-page deck."""
    monkeypatch.setattr("pptmaster.agent.strategist.get_chat_model", _fake_get_chat_model)

    compiled_graph = build_strategist_subgraph().compile(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": str(uuid.uuid4())}}

    async for _ in compiled_graph.astream(build_base_state(), config):
        pass
    async for _ in compiled_graph.astream(Command(resume={"answers": {"decision": "approve"}}), config):
        pass

    async for _ in compiled_graph.astream(
        Command(resume={"answers": {"decision": "approve", "page_count_mode": "explicit", "page_count": 1}}),
        config,
    ):
        pass

    snapshot = await compiled_graph.aget_state(config)
    assert snapshot.values["confirmation_progress"]["page_count"] == "approved"
    assert snapshot.values["page_count"] == 1


@pytest.mark.asyncio
async def test_page_count_gate_records_ai_decide_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("pptmaster.agent.strategist.get_chat_model", _fake_get_chat_model)

    compiled_graph = build_strategist_subgraph().compile(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": str(uuid.uuid4())}}

    async for _ in compiled_graph.astream(build_base_state(), config):
        pass
    async for _ in compiled_graph.astream(Command(resume={"answers": {"decision": "approve"}}), config):
        pass

    async for _ in compiled_graph.astream(
        Command(resume={"answers": {"decision": "approve", "page_count_mode": "ai_decide"}}),
        config,
    ):
        pass

    snapshot = await compiled_graph.aget_state(config)
    assert snapshot.values["confirmation_progress"]["page_count"] == "approved"
    assert snapshot.values["page_count_mode"] == "ai_decide"
    assert snapshot.values["page_count"] is None


@pytest.mark.asyncio
async def test_page_count_gate_backward_compat_numeric_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    """Old frontend that sends {answer: '12'} without page_count_mode must still advance."""
    monkeypatch.setattr("pptmaster.agent.strategist.get_chat_model", _fake_get_chat_model)

    compiled_graph = build_strategist_subgraph().compile(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": str(uuid.uuid4())}}

    async for _ in compiled_graph.astream(build_base_state(), config):
        pass
    async for _ in compiled_graph.astream(Command(resume={"answers": {"decision": "approve"}}), config):
        pass

    async for _ in compiled_graph.astream(
        Command(resume={"answers": {"decision": "approve"}, "answer": "12"}),
        config,
    ):
        pass

    snapshot = await compiled_graph.aget_state(config)
    assert snapshot.values["confirmation_progress"]["page_count"] == "approved"
    assert snapshot.values["page_count_mode"] == "explicit"
    assert snapshot.values["page_count"] == 12


class FakeFinalizeModel:
    """Returns a deterministic three-section finalize response with a
    pages-array of variable length so the test asserts truncation/padding."""

    def __init__(self, n_pages_in_output: int):
        self._n = n_pages_in_output

    async def ainvoke(self, prompt):
        outline_pages = [
            {
                "index": i,
                "name": f"page_{i:02d}",
                "title": f"Title {i}",
                "type": "content",
                "layout_basename": None,
                "rhythm": "dense",
                "chart_basename": None,
                "content": ["bullet"],
            }
            for i in range(1, self._n + 1)
        ]
        body = (
            "===DESIGN_SPEC===\n# Spec\n"
            "===SPEC_LOCK===\n## canvas\n- format: ppt169\n"
            "===OUTLINE_JSON===\n```json\n"
            + json.dumps({"canvas": {"format": "ppt169"}, "pages": outline_pages})
            + "\n```\n"
        )

        class _R:
            pass

        r = _R()
        r.content = body
        return r


@pytest.mark.asyncio
async def test_finalize_truncates_to_state_page_count(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
):
    from pptmaster.agent.strategist import _strategist_finalize

    async def _fake_get_chat_model_truncate(role):
        return FakeFinalizeModel(n_pages_in_output=25)

    monkeypatch.setattr(
        "pptmaster.agent.strategist.get_chat_model",
        _fake_get_chat_model_truncate,
    )
    # Redirect storage to tmp_path
    monkeypatch.setattr(
        "pptmaster.agent.strategist.get_settings",
        lambda: type("S", (), {"storage_root": str(tmp_path)})(),
    )

    state = {
        "project_id": "proj-x",
        "messages": [],
        "user_brief": "",
        "converted_markdown": [],
        "confirmation_progress": {g: "approved" for g in (
            "canvas", "page_count", "audience", "style",
            "colors", "icons", "typography", "images",
        )},
        "page_count_mode": "explicit",
        "page_count": 12,
        "page_count_reasoning": None,
    }

    result = await _strategist_finalize(state)
    outline_path = Path(result["outline_path"])
    outline = json.loads(outline_path.read_text(encoding="utf-8"))
    assert len(outline["pages"]) == 12