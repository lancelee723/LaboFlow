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
