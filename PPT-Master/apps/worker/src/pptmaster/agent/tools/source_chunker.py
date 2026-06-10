"""Source document chunker for the PPT generation pipeline.

Handles two document types:
  - Pre-divided: contains explicit page markers (## 第N页 / ## Page N)
    → each page section becomes a chunk with page_marker=N
  - Undivided: normal reports/articles without page markers
    → split at heading/paragraph/sentence boundaries into ~8000-char chunks

Produces a compact SourceIndex (for LLM context) and full Chunk objects
(for per-page content injection in the executor).
"""

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ── Page marker regex ────────────────────────────────────────────────────────

PAGE_MARKER_RE = re.compile(
    r"^#{1,4}\s+(?:第(\d+)页|Page\s*(\d+))[:：]?\s*(.*)$",
    re.MULTILINE,
)

HEADING_RE = re.compile(r"^#{1,6}\s+", re.MULTILINE)
H2_RE = re.compile(r"^##\s+", re.MULTILINE)
H3_RE = re.compile(r"^###\s+", re.MULTILINE)
H4_RE = re.compile(r"^#{3,4}\s+", re.MULTILINE)


# ── Data structures ──────────────────────────────────────────────────────────

@dataclass
class Chunk:
    index: int                # 1-based chunk number
    title: str                # Heading text or "Section N"
    source_file: str          # Original filename
    page_marker: int | None   # For pre-divided: the page number (e.g. 3 for "## 第3页")
    text: str                 # Full chunk content
    summary: str              # First ~100 chars, cleaned

    def __post_init__(self):
        if not self.summary:
            self.summary = _make_summary(self.text)


@dataclass
class SourceIndex:
    """Compact representation of all source chunks — small enough for every LLM call."""
    source_type: str          # "pre_divided" | "undivided"
    total_chars: int
    total_chunks: int
    file_count: int
    entries: list[dict[str, Any]] = field(default_factory=list)

    def __str__(self) -> str:
        lines = [
            f"Source type: {self.source_type} | Files: {self.file_count} | "
            f"Chunks: {self.total_chunks} | Total chars: {self.total_chars}",
        ]
        for e in self.entries:
            lines.append(f"  [{e['i']}] {e['title']} ({e['chars']} chars): {e['summary']}")
        return "\n".join(lines)


@dataclass
class ChunkedSource:
    """Full result of chunking all source files."""
    index: SourceIndex
    chunks: list[Chunk]


# ── Helper ───────────────────────────────────────────────────────────────────

def _make_summary(text: str, max_len: int = 100) -> str:
    """Extract a one-line summary from text."""
    # Strip markdown formatting
    cleaned = re.sub(r"[*_`#|>\-]", " ", text)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:max_len] + ("..." if len(cleaned) > max_len else "")


def _split_at_boundaries(text: str, boundary_re: re.Pattern[str], max_chars: int) -> list[str]:
    """Split text at regex boundary positions, keeping each piece under max_chars."""
    boundaries = [0] + [m.start() for m in boundary_re.finditer(text)] + [len(text)]
    pieces: list[str] = []
    for i in range(len(boundaries) - 1):
        piece = text[boundaries[i]:boundaries[i + 1]]
        if piece.strip():
            pieces.append(piece)
    if not pieces:
        return [text] if text.strip() else []

    # Merge small pieces
    merged: list[str] = []
    current = pieces[0]
    for piece in pieces[1:]:
        if len(current) + len(piece) <= max_chars:
            current += piece
        else:
            merged.append(current)
            current = piece
    merged.append(current)

    # Hard-split any piece still over max_chars at paragraph boundaries
    result: list[str] = []
    for piece in merged:
        if len(piece) <= max_chars:
            result.append(piece)
        else:
            result.extend(_split_at_paragraphs(piece, max_chars))
    return result


def _split_at_paragraphs(text: str, max_chars: int) -> list[str]:
    """Split text at double-newline (paragraph) boundaries."""
    paras = re.split(r"\n\n+", text)
    merged: list[str] = []
    current = ""
    for para in paras:
        if not para.strip():
            continue
        if len(current) + len(para) + 2 <= max_chars:
            current = f"{current}\n\n{para}" if current else para
        else:
            if current:
                merged.append(current)
            if len(para) <= max_chars:
                current = para
            else:
                # Hard split at sentence boundaries
                merged.extend(_split_at_sentences(para, max_chars))
                current = ""
    if current:
        merged.append(current)
    return merged


def _split_at_sentences(text: str, max_chars: int) -> list[str]:
    """Split text at sentence boundaries (。.！!？?)."""
    parts = re.split(r"(?<=[。.！!？?])\s*", text)
    merged: list[str] = []
    current = ""
    for part in parts:
        if not part.strip():
            continue
        if len(current) + len(part) <= max_chars:
            current += part
        else:
            if current:
                merged.append(current)
            current = part
    if current:
        merged.append(current)

    # Last resort: hard char split
    result: list[str] = []
    for piece in merged:
        if len(piece) <= max_chars:
            result.append(piece)
        else:
            for i in range(0, len(piece), max_chars):
                result.append(piece[i:i + max_chars])
    return result


# ── Detection ────────────────────────────────────────────────────────────────

def detect_source_type(texts: list[str]) -> str:
    """Detect whether source documents are pre-divided or undivided.

    Returns "pre_divided" if any text has >= 2 page markers, else "undivided".
    """
    for text in texts:
        markers = PAGE_MARKER_RE.findall(text)
        if len(markers) >= 2:
            return "pre_divided"
    return "undivided"


# ── Pre-divided chunking ────────────────────────────────────────────────────

def chunk_pre_divided(
    text: str,
    filename: str,
    max_chars: int = 8000,
) -> list[Chunk]:
    """Split a pre-divided document at page marker boundaries."""
    matches = list(PAGE_MARKER_RE.finditer(text))
    if not matches:
        return []

    chunks: list[Chunk] = []
    chunk_idx = 1

    # Content before first page marker (preamble)
    if matches[0].start() > 0:
        preamble = text[:matches[0].start()].strip()
        if preamble:
            chunks.append(Chunk(
                index=chunk_idx,
                title="Preamble",
                source_file=filename,
                page_marker=None,
                text=preamble,
                summary=_make_summary(preamble),
            ))
            chunk_idx += 1

    for i, m in enumerate(matches):
        page_num_str = m.group(1) or m.group(2)
        title = m.group(3).strip() if m.group(3) else ""
        page_num = int(page_num_str) if page_num_str else None

        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        section = text[start:end].strip()

        if not section:
            section = f"(Page {page_num} — content to be filled from source)"

        # If section exceeds max_chars, sub-split at h3/paragraph boundaries
        if len(section) <= max_chars:
            chunks.append(Chunk(
                index=chunk_idx,
                title=title or f"Page {page_num}",
                source_file=filename,
                page_marker=page_num,
                text=section,
                summary=_make_summary(section),
            ))
            chunk_idx += 1
        else:
            sub_pieces = _split_at_boundaries(section, H3_RE, max_chars)
            for j, piece in enumerate(sub_pieces):
                sub_title = title or f"Page {page_num}"
                if len(sub_pieces) > 1:
                    sub_title += f" (part {j + 1}/{len(sub_pieces)})"
                chunks.append(Chunk(
                    index=chunk_idx,
                    title=sub_title,
                    source_file=filename,
                    page_marker=page_num,
                    text=piece,
                    summary=_make_summary(piece),
                ))
                chunk_idx += 1

    return chunks


# ── Undivided chunking ──────────────────────────────────────────────────────

def chunk_undivided(
    text: str,
    filename: str,
    max_chars: int = 8000,
) -> list[Chunk]:
    """Split an undivided document at heading/paragraph boundaries."""
    if not text.strip():
        return []

    # Try h2 boundaries first
    pieces = _split_at_boundaries(text, H2_RE, max_chars)

    chunks: list[Chunk] = []
    for i, piece in enumerate(pieces):
        # Extract title from first heading line
        title = f"Section {i + 1}"
        first_line = piece.strip().split("\n", 1)[0]
        if re.match(r"^#{1,6}\s+", first_line):
            title = re.sub(r"^#{1,6}\s+", "", first_line).strip()

        chunks.append(Chunk(
            index=i + 1,
            title=title,
            source_file=filename,
            page_marker=None,
            text=piece,
            summary=_make_summary(piece),
        ))

    return chunks


# ── Index builder ────────────────────────────────────────────────────────────

def build_source_index(
    source_type: str,
    chunks: list[Chunk],
    total_chars: int,
    file_count: int,
) -> SourceIndex:
    """Build a compact SourceIndex from chunks."""
    entries = [
        {
            "i": c.index,
            "title": c.title,
            "summary": c.summary,
            "chars": len(c.text),
        }
        for c in chunks
    ]
    return SourceIndex(
        source_type=source_type,
        total_chars=total_chars,
        total_chunks=len(chunks),
        file_count=file_count,
        entries=entries,
    )


# ── Chunk-to-page mapping ───────────────────────────────────────────────────

def map_chunks_to_pages(
    chunks: list[Chunk],
    pages: list[dict[str, Any]],
) -> dict[int, list[Chunk]]:
    """Map chunks to outline pages.

    For pre-divided documents, uses page_marker for direct mapping.
    For undivided documents, uses keyword-overlap heuristic.

    Returns page_index -> list of relevant chunks.
    """
    result: dict[int, list[Chunk]] = {}

    # Check if pre-divided (any chunk has page_marker)
    has_markers = any(c.page_marker is not None for c in chunks)

    if has_markers:
        for chunk in chunks:
            if chunk.page_marker is not None:
                result.setdefault(chunk.page_marker, []).append(chunk)
            else:
                # Preamble chunks: assign to page 1
                result.setdefault(1, []).append(chunk)
        return result

    # Undivided: keyword-overlap heuristic
    def _tokenize(text: str) -> set[str]:
        # Simple Chinese+English tokenization
        words = re.findall(r"[一-鿿]{2,}|[a-zA-Z]{3,}", text.lower())
        return set(words)

    page_tokens: dict[int, set[str]] = {}
    for page in pages:
        idx = page.get("index", 0)
        tokens = _tokenize(page.get("title", ""))
        for c in page.get("content", []):
            tokens |= _tokenize(str(c))
        page_tokens[idx] = tokens

    chunk_tokens: list[tuple[Chunk, set[str]]] = []
    for chunk in chunks:
        tokens = _tokenize(chunk.title) | _tokenize(chunk.summary)
        chunk_tokens.append((chunk, tokens))

    # Score each chunk against each page
    for chunk, c_tokens in chunk_tokens:
        best_page = None
        best_score = 0
        for page_idx, p_tokens in page_tokens.items():
            overlap = len(c_tokens & p_tokens)
            if overlap > best_score:
                best_score = overlap
                best_page = page_idx

        if best_page is not None and best_score > 0:
            result.setdefault(best_page, []).append(chunk)
        else:
            # Distribute evenly as fallback
            if pages:
                approx_page = pages[min(
                    chunk.index * len(pages) // max(len(chunks), 1),
                    len(pages) - 1,
                )].get("index", 1)
                result.setdefault(approx_page, []).append(chunk)

    return result


# ── Main entry point ────────────────────────────────────────────────────────

def chunk_sources(
    converted_markdown: list[str],
    max_chunk_chars: int = 8000,
) -> ChunkedSource:
    """Read all source files, detect type, chunk, and build index.

    Args:
        converted_markdown: List of file paths to converted markdown files.
        max_chunk_chars: Maximum chars per chunk (default 8000).

    Returns:
        ChunkedSource with index and chunks.
    """
    if not converted_markdown:
        return ChunkedSource(
            index=SourceIndex(
                source_type="undivided",
                total_chars=0,
                total_chunks=0,
                file_count=0,
            ),
            chunks=[],
        )

    # Read all files
    file_texts: list[tuple[str, str]] = []  # (filename, text)
    total_chars = 0
    for fpath in converted_markdown:
        try:
            text = Path(fpath).read_text(encoding="utf-8")
            file_texts.append((Path(fpath).name, text))
            total_chars += len(text)
        except OSError as e:
            logger.warning(f"Could not read source file {fpath}: {e}")

    if not file_texts:
        return ChunkedSource(
            index=SourceIndex(
                source_type="undivided",
                total_chars=0,
                total_chunks=0,
                file_count=0,
            ),
            chunks=[],
        )

    # Detect source type
    texts_only = [t for _, t in file_texts]
    source_type = detect_source_type(texts_only)

    # Chunk each file
    all_chunks: list[Chunk] = []
    for filename, text in file_texts:
        if source_type == "pre_divided":
            file_chunks = chunk_pre_divided(text, filename, max_chunk_chars)
        else:
            file_chunks = chunk_undivided(text, filename, max_chunk_chars)

        # Re-index globally
        for chunk in file_chunks:
            chunk.index = len(all_chunks) + 1
            all_chunks.append(chunk)

    # Build index
    index = build_source_index(
        source_type=source_type,
        chunks=all_chunks,
        total_chars=total_chars,
        file_count=len(file_texts),
    )

    return ChunkedSource(index=index, chunks=all_chunks)
