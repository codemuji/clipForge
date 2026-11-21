"""Window input file cleanup utilities."""

import os
from pathlib import Path
from typing import Sequence


def cleanup_window_files(paths: Sequence[str]) -> list[str]:
    """Deletes frame and audio window files unless DEBUG_KEEP_WINDOWS=1.
    
    Returns list of deleted file paths.
    """
    if os.environ.get("DEBUG_KEEP_WINDOWS", "0") == "1":
        return []

    deleted: list[str] = []
    for raw_path in paths:
        if not raw_path:
            continue
        try:
            p = Path(raw_path)
            if p.exists() and p.is_file():
                p.unlink()
                deleted.append(str(p))
        except Exception:
            # File cleanup failures must not crash the detector or scorer
            pass

    return deleted
