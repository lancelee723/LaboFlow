"""Unit tests for app.services.doc_parser."""

from pathlib import Path

import pytest

from app.services.doc_parser import doc_read, DocParseError


FIX = Path(__file__).parent / "fixtures"


class TestDocRead:
    def test_md(self):
        res = doc_read(str(FIX / "sample.md"))
        assert res["format"] == "md"
        assert "Title" in res["text"]
        assert "bullet 1" in res["text"]

    def test_csv(self):
        res = doc_read(str(FIX / "sample.csv"))
        assert res["format"] == "csv"
        assert "alice" in res["text"]

    def test_pdf(self):
        res = doc_read(str(FIX / "sample.pdf"))
        assert res["format"] == "pdf"
        assert res["page_count"] >= 1

    def test_docx(self):
        res = doc_read(str(FIX / "sample.docx"))
        assert res["format"] == "docx"
        assert "docx world" in res["text"]

    def test_xlsx(self):
        res = doc_read(str(FIX / "sample.xlsx"))
        assert res["format"] == "xlsx"
        assert "Sheet1" in res["text"]
        assert "Sheet2" in res["text"]

    def test_pptx(self):
        res = doc_read(str(FIX / "sample.pptx"))
        assert res["format"] == "pptx"
        assert "Slide One Title" in res["text"]
        assert "Slide Two Title" in res["text"]

    def test_truncation(self):
        res = doc_read(str(FIX / "sample.md"), max_chars=10)
        assert res["truncated"] is True
        assert len(res["text"]) == 10

    def test_page_range_pdf(self):
        res_full = doc_read(str(FIX / "sample.pdf"))
        res_first = doc_read(str(FIX / "sample.pdf"), page_range="1")
        assert len(res_first["text"]) <= len(res_full["text"])

    def test_corrupt_pdf(self):
        with pytest.raises(DocParseError):
            doc_read(str(FIX / "corrupt.pdf"))

    def test_max_chars_hard_cap(self):
        res = doc_read(str(FIX / "sample.md"), max_chars=999999)
        assert res["max_chars_applied"] == 200000


from app.services.doc_parser import doc_extract_tables


class TestDocExtractTables:
    def test_xlsx_tables(self):
        res = doc_extract_tables(str(FIX / "sample.xlsx"))
        assert len(res["tables"]) == 2  # two sheets
        t1 = res["tables"][0]
        assert t1[0] == ["A", "B", "C"]
        assert t1[1] == ["1", "2", "3"]

    def test_pdf_tables_empty_ok(self):
        res = doc_extract_tables(str(FIX / "sample.pdf"))
        assert "tables" in res
        assert isinstance(res["tables"], list)

    def test_unsupported_format(self):
        with pytest.raises(DocParseError):
            doc_extract_tables(str(FIX / "sample.md"))


# ── workspace-relative path resolution (doc_read/doc_extract_tables dispatcher) ──
import json
from uuid import uuid4

from app.services import agent_tools
from app.services.storage_runtime import facade as storage_facade
from app.services.storage_runtime.local import LocalStorageBackend


@pytest.fixture
def isolated_local_storage(tmp_path, monkeypatch):
    """Force the global storage backend and WORKSPACE_ROOT to a clean tmp directory."""
    backend = LocalStorageBackend(str(tmp_path))
    monkeypatch.setattr(storage_facade, "_storage_backend", backend)
    monkeypatch.setattr(agent_tools, "WORKSPACE_ROOT", tmp_path)
    return tmp_path


@pytest.fixture
def no_tenant(monkeypatch):
    async def _none(_agent_id):
        return None
    monkeypatch.setattr(agent_tools, "_get_agent_tenant_id", _none)


def _seed_uploaded_xlsx(root, agent_id):
    upload_dir = root / str(agent_id) / "workspace" / "uploads"
    upload_dir.mkdir(parents=True)
    target = upload_dir / "sample.xlsx"
    target.write_bytes((FIX / "sample.xlsx").read_bytes())
    return target


class TestResolveDocPath:
    async def test_absolute_path_passthrough(self, isolated_local_storage, no_tenant):
        absolute = str(FIX / "sample.xlsx")
        resolved = await agent_tools._resolve_doc_path(uuid4(), absolute)
        assert resolved == absolute

    async def test_workspace_relative_resolves_to_local(self, isolated_local_storage, no_tenant):
        agent_id = uuid4()
        target = _seed_uploaded_xlsx(isolated_local_storage, agent_id)

        resolved = await agent_tools._resolve_doc_path(agent_id, "workspace/uploads/sample.xlsx")
        assert Path(resolved).is_absolute()
        assert Path(resolved).read_bytes() == target.read_bytes()

    async def test_missing_relative_path_passes_through(self, isolated_local_storage, no_tenant):
        original = "workspace/uploads/does-not-exist.xlsx"
        resolved = await agent_tools._resolve_doc_path(uuid4(), original)
        assert resolved == original


class TestDocReadToolWithWorkspacePath:
    async def test_doc_read_via_workspace_path(self, isolated_local_storage, no_tenant):
        agent_id = uuid4()
        _seed_uploaded_xlsx(isolated_local_storage, agent_id)

        out = await agent_tools._doc_read_tool(
            agent_id, {"file_id_or_path": "workspace/uploads/sample.xlsx"}
        )
        assert "❌" not in out
        assert "Sheet1" in out

    async def test_doc_extract_tables_via_workspace_path(self, isolated_local_storage, no_tenant):
        agent_id = uuid4()
        _seed_uploaded_xlsx(isolated_local_storage, agent_id)

        out = await agent_tools._doc_extract_tables_tool(
            agent_id, {"file_id_or_path": "workspace/uploads/sample.xlsx"}
        )
        assert "❌" not in out
        data = json.loads(out)
        assert data["count"] == 2

    async def test_doc_read_missing_workspace_path_reports_not_found(self, isolated_local_storage, no_tenant):
        out = await agent_tools._doc_read_tool(
            uuid4(), {"file_id_or_path": "workspace/uploads/missing.xlsx"}
        )
        assert "file not found" in out
