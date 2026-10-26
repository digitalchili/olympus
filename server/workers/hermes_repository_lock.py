"""An OS-owned writer fence. A restart or elapsed time never steals this lock."""
import os
from pathlib import Path


def acquire_repository_lock(path):
    if not path:
        return None
    import fcntl  # Unsupported hosts fail closed instead of admitting two writers.
    target = Path(path)
    if not target.is_absolute():
        raise ValueError('Repository lock path must be absolute')
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(target, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    handle = os.fdopen(fd, 'r+')
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except BaseException:
        handle.close()
        raise


def repository_locked(path):
    try:
        handle = acquire_repository_lock(path)
    except BlockingIOError:
        return True
    if handle:
        handle.close()
    return False
