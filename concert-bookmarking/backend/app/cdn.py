"""CDN cache invalidation simulation and hook manager."""
import logging
from typing import List, Callable, Dict, Any

logger = logging.getLogger(__name__)


class CDNManager:
    """Manages cache invalidation events and surrogate key purges."""

    def __init__(self):
        self._purged_keys: List[str] = []
        self._listeners: List[Callable[[str], None]] = []

    def register_listener(self, callback: Callable[[str], None]) -> None:
        self._listeners.append(callback)

    def purge_key(self, surrogate_key: str) -> Dict[str, Any]:
        """Dispatches cache purge for a specific surrogate key (e.g. video-{videoId})."""
        self._purged_keys.append(surrogate_key)
        logger.info(f"[CDN PURGE] Invalidation event dispatched for key: {surrogate_key}")

        for listener in self._listeners:
            try:
                listener(surrogate_key)
            except Exception as e:
                logger.error(f"[CDN PURGE ERROR] Listener failure: {e}")

        return {
            "status": "purged",
            "key": surrogate_key,
            "total_purges": len(self._purged_keys),
        }

    def get_purged_keys(self) -> List[str]:
        return list(self._purged_keys)

    def clear_purge_history(self) -> None:
        self._purged_keys.clear()


# Global singleton instance
cdn_manager = CDNManager()
