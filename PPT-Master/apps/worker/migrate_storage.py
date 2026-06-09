"""One-off filesystem migration script: move project storage from
{storage_root}/projects/{org_id}/{project_id}/ to
{storage_root}/projects/{project_id}/.

Run once after applying the drop_org_id Alembic migration.

Usage:
    python migrate_storage.py [--dry-run] [--storage-root PATH]

    --dry-run        Print what would happen without moving anything.
    --storage-root   Override STORAGE_ROOT (default: .dev/data).

Each top-level directory under {storage_root}/projects/ that is NOT a UUID
project directory (i.e. it contains subdirectories that look like UUIDs) is
treated as an org_id scope and its children are moved up one level.

After all moves, empty org_id parent directories are removed.
"""

import argparse
import logging
import shutil
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

# A rough UUID check: 8-4-4-4-12 hex segments (project IDs are UUID4)
import re
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _looks_like_uuid(name: str) -> bool:
    return bool(_UUID_RE.match(name))


def migrate(storage_root: Path, dry_run: bool) -> int:
    """Walk storage_root/projects/ and flatten the org_id layer.

    Returns the number of project directories moved.
    """
    projects_dir = storage_root / "projects"
    if not projects_dir.is_dir():
        logger.warning("projects directory not found: %s", projects_dir)
        return 0

    moved = 0
    empty_org_dirs: list[Path] = []

    for entry in sorted(projects_dir.iterdir()):
        if not entry.is_dir():
            continue

        if _looks_like_uuid(entry.name):
            # Already at the new flat layout — nothing to do.
            logger.debug("Skipping %s (already top-level project dir)", entry.name)
            continue

        # Treat entry as an org_id directory.
        org_dir = entry
        org_id = org_dir.name
        children = sorted(org_dir.iterdir())

        if not children:
            # Empty org dir — queue for removal.
            empty_org_dirs.append(org_dir)
            continue

        all_moved = True
        for child in children:
            if not child.is_dir():
                logger.info("Skipping non-directory: %s", child)
                continue

            project_id = child.name
            target = projects_dir / project_id

            if target.exists():
                logger.warning(
                    "SKIP %s/%s → %s already exists",
                    org_id, project_id, target,
                )
                all_moved = False
                continue

            if dry_run:
                logger.info("[DRY-RUN] Would move %s → %s", child, target)
            else:
                logger.info("Moving %s → %s", child, target)
                shutil.move(str(child), str(target))

            moved += 1

        # Queue org_dir for removal if all children were moved
        if all_moved and not dry_run:
            # Check if org_dir is now empty after moves
            remaining = list(org_dir.iterdir())
            if not remaining:
                empty_org_dirs.append(org_dir)
            else:
                logger.warning(
                    "org dir %s still has contents after migration, not removing: %s",
                    org_dir, [r.name for r in remaining],
                )

    # Remove empty org dirs
    for org_dir in empty_org_dirs:
        if dry_run:
            logger.info("[DRY-RUN] Would remove empty org dir: %s", org_dir)
        else:
            try:
                org_dir.rmdir()
                logger.info("Removed empty org dir: %s", org_dir)
            except OSError as exc:
                logger.warning("Could not remove %s: %s", org_dir, exc)

    return moved


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print planned actions without moving anything.",
    )
    parser.add_argument(
        "--storage-root",
        default=".dev/data",
        metavar="PATH",
        help="Path to the storage root (default: .dev/data).",
    )
    args = parser.parse_args()

    storage_root = Path(args.storage_root).resolve()
    if not storage_root.exists():
        logger.warning("Storage root does not exist: %s (nothing to migrate)", storage_root)
        sys.exit(0)

    mode = "DRY-RUN" if args.dry_run else "LIVE"
    logger.info("=== migrate_storage [%s] ===", mode)
    logger.info("Storage root: %s", storage_root)

    n = migrate(storage_root, dry_run=args.dry_run)

    if args.dry_run:
        logger.info("DRY-RUN complete: %d project(s) would be moved.", n)
    else:
        logger.info("Migration complete: %d project(s) moved.", n)


if __name__ == "__main__":
    main()
