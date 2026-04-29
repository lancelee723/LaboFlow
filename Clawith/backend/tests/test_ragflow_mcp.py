"""Tests for RAGFlow MCP integration formatting + seeder behavior."""

import json
import importlib

import pytest


# ── _format_ragflow_response ─────────────────────────────────


def test_format_ragflow_normal_chunk():
    from app.services.agent_tools import _format_ragflow_response
    raw = json.dumps({
        "chunks": [
            {
                "content": "Sales grew 23% YoY driven by new EV models.",
                "similarity": 0.85,
                "document_keyword": "Q3-Report.pdf",
                "positions": [[12, 80, 120, 500, 300]],
                "dataset_name": "Customer Interviews",
                "document_id": "d1",
                "dataset_id": "s1",
            }
        ],
        "pagination": {"total_chunks": 1, "page": 1, "page_size": 30},
    })
    out = _format_ragflow_response(raw)
    assert "Q3-Report.pdf" in out
    assert "p.12" in out
    assert "85%" in out
    assert "Customer Interviews" in out
    assert "doc_id=d1" in out
    assert "dataset_id=s1" in out
    assert "Sales grew" in out


def test_format_ragflow_empty_chunks():
    from app.services.agent_tools import _format_ragflow_response
    out = _format_ragflow_response(json.dumps({"chunks": [], "pagination": {}}))
    assert "no relevant results" in out.lower()


def test_format_ragflow_malformed_json_falls_back_to_raw():
    from app.services.agent_tools import _format_ragflow_response
    raw = "this is not json"
    out = _format_ragflow_response(raw)
    assert out == raw


def test_format_ragflow_truncates_long_content():
    from app.services.agent_tools import _format_ragflow_response
    chunk = {
        "content": "x" * 1000,
        "similarity": 0.5,
        "document_keyword": "X.pdf",
        "dataset_name": "DS",
        "document_id": "d2",
        "dataset_id": "s2",
        "positions": [],
    }
    out = _format_ragflow_response(json.dumps({"chunks": [chunk], "pagination": {"total_chunks": 1}}))
    assert "…" in out  # ellipsis indicates truncation
    # content is 1000 chars truncated to 400 + ellipsis; total output well under 1500
    assert len(out) < 1500


def test_format_ragflow_handles_missing_optional_fields():
    """Chunks may omit positions, dataset_name, document_keyword on edge cases."""
    from app.services.agent_tools import _format_ragflow_response
    chunk = {"content": "minimal", "similarity": 0.3}
    out = _format_ragflow_response(json.dumps({"chunks": [chunk], "pagination": {}}))
    assert "(unknown doc)" in out
    assert "(unknown dataset)" in out
    assert "p." not in out  # no page since positions empty


def test_format_ragflow_null_similarity_does_not_crash():
    from app.services.agent_tools import _format_ragflow_response
    chunk = {"content": "ok", "similarity": None, "document_keyword": "A.pdf",
             "dataset_name": "DS", "document_id": "d1", "dataset_id": "s1", "positions": []}
    out = _format_ragflow_response(json.dumps({"chunks": [chunk], "pagination": {}}))
    assert "A.pdf" in out  # must not raise
