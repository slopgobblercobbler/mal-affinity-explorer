import sqlite3
import json
import time
from typing import Optional, List, Dict, Any
from mal_affinity.models import UserProfile, AnimeEntry, AffinityResult


class MALDatabase:
    def __init__(self, db_path: str = "mal_affinity.db"):
        self.db_path = db_path
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            # Table to cache user anime/manga lists
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS user_lists (
                    username TEXT,
                    list_type TEXT,
                    entries_json TEXT,
                    scored_count INTEGER,
                    updated_at REAL,
                    PRIMARY KEY (username, list_type)
                )
            """)

            # Table for candidate queue
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS candidate_queue (
                    username TEXT PRIMARY KEY,
                    source TEXT,
                    discovered_at REAL,
                    scanned INTEGER DEFAULT 0,
                    error_msg TEXT DEFAULT NULL
                )
            """)

            # Table for cached affinity results
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS affinity_cache (
                    target_user TEXT,
                    candidate_user TEXT,
                    affinity REAL,
                    shared_count INTEGER,
                    mean_diff REAL,
                    weighted_affinity REAL,
                    details_json TEXT,
                    calculated_at REAL,
                    PRIMARY KEY (target_user, candidate_user)
                )
            """)
            conn.commit()

    def get_user_profile(
        self, username: str, list_type: str = "anime", max_age_days: float = 7.0
    ) -> Optional[UserProfile]:
        username_clean = username.strip().lower()
        cutoff = time.time() - (max_age_days * 86400)
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT entries_json, updated_at FROM user_lists WHERE LOWER(username) = ? AND list_type = ?",
                (username_clean, list_type),
            )
            row = cursor.fetchone()
            if not row:
                return None
            if row["updated_at"] < cutoff:
                return None  # expired

            raw_entries = json.loads(row["entries_json"])
            profile = UserProfile(username=username, list_type=list_type)
            for item in raw_entries:
                entry = AnimeEntry.from_dict(item)
                profile.entries[entry.anime_id] = entry
            return profile

    def save_user_profile(self, profile: UserProfile):
        username_clean = profile.username.strip()
        entries_data = [e.to_dict() for e in profile.entries.values()]
        entries_json = json.dumps(entries_data)
        now = time.time()
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO user_lists (username, list_type, entries_json, scored_count, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(username, list_type) DO UPDATE SET
                    entries_json = excluded.entries_json,
                    scored_count = excluded.scored_count,
                    updated_at = excluded.updated_at
                """,
                (username_clean, profile.list_type, entries_json, profile.scored_count, now),
            )
            conn.commit()

    def add_candidates(self, candidates: List[str], source: str = "general") -> int:
        now = time.time()
        added = 0
        with self._get_connection() as conn:
            cursor = conn.cursor()
            for cand in candidates:
                cand_clean = cand.strip()
                if not cand_clean:
                    continue
                try:
                    cursor.execute(
                        """
                        INSERT INTO candidate_queue (username, source, discovered_at, scanned)
                        VALUES (?, ?, ?, 0)
                        ON CONFLICT(username) DO NOTHING
                        """,
                        (cand_clean, source, now),
                    )
                    if cursor.rowcount > 0:
                        added += 1
                except sqlite3.Error:
                    pass
            conn.commit()
        return added

    def get_pending_candidates(self, limit: int = 100) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT username, source FROM candidate_queue WHERE scanned = 0 ORDER BY discovered_at ASC LIMIT ?",
                (limit,),
            )
            rows = cursor.fetchall()
            return [{"username": row["username"], "source": row["source"]} for row in rows]

    def mark_candidate_scanned(self, username: str, error_msg: Optional[str] = None):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE candidate_queue SET scanned = 1, error_msg = ? WHERE LOWER(username) = ?",
                (error_msg, username.strip().lower()),
            )
            conn.commit()

    def save_affinity_result(self, result: AffinityResult):
        now = time.time()
        details_json = json.dumps(result.to_dict(include_all_shared=True))
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO affinity_cache (
                    target_user, candidate_user, affinity, shared_count, mean_diff,
                    weighted_affinity, details_json, calculated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(target_user, candidate_user) DO UPDATE SET
                    affinity = excluded.affinity,
                    shared_count = excluded.shared_count,
                    mean_diff = excluded.mean_diff,
                    weighted_affinity = excluded.weighted_affinity,
                    details_json = excluded.details_json,
                    calculated_at = excluded.calculated_at
                """,
                (
                    result.target_user,
                    result.candidate_user,
                    result.affinity,
                    result.shared_count,
                    result.mean_abs_diff,
                    result.weighted_affinity,
                    details_json,
                    now,
                ),
            )
            conn.commit()

    def get_top_affinities(
        self,
        target_user: str,
        min_shared: int = 10,
        sort_by: str = "weighted",  # 'weighted', 'affinity', 'shared'
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            order_clause = "weighted_affinity DESC"
            if sort_by == "affinity":
                order_clause = "affinity DESC, shared_count DESC"
            elif sort_by == "shared":
                order_clause = "shared_count DESC, affinity DESC"

            cursor.execute(
                f"""
                SELECT target_user, candidate_user, affinity, shared_count, mean_diff,
                       weighted_affinity, details_json
                FROM affinity_cache
                WHERE LOWER(target_user) = ? AND shared_count >= ?
                ORDER BY {order_clause}
                LIMIT ?
                """,
                (target_user.strip().lower(), min_shared, limit),
            )
            rows = cursor.fetchall()
            results = []
            for row in rows:
                item = {
                    "target_user": row["target_user"],
                    "candidate_user": row["candidate_user"],
                    "affinity": row["affinity"],
                    "shared_count": row["shared_count"],
                    "mean_diff": row["mean_diff"],
                    "weighted_affinity": row["weighted_affinity"],
                }
                if row["details_json"]:
                    try:
                        item["details"] = json.loads(row["details_json"])
                    except json.JSONDecodeError:
                        item["details"] = {}
                results.append(item)
            return results

    def clear_cache(self):
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM user_lists")
            cursor.execute("DELETE FROM candidate_queue")
            cursor.execute("DELETE FROM affinity_cache")
            conn.commit()
