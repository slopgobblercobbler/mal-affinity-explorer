import time
import random
import re
import requests
from typing import Optional, List, Set, Dict, Any, Callable
from urllib.parse import quote

from mal_affinity.models import UserProfile, AnimeEntry
from mal_affinity.db import MALDatabase


SYSTEM_EXCLUDED_USERNAMES = {
    "login", "register", "logout", "about", "terms", "privacy", "help",
    "support", "contact", "forum", "news", "clubs", "search", "api", "edit"
}


class MALScraper:
    """
    Robust scraper for MyAnimeList with caching, rate limiting, and candidate discovery.
    """

    BASE_URL = "https://myanimelist.net"

    def __init__(
        self,
        db: Optional[MALDatabase] = None,
        request_delay: float = 0.4,
        max_retries: int = 3,
        user_agent: Optional[str] = None,
    ):
        self.db = db or MALDatabase()
        self.request_delay = request_delay
        self.max_retries = max_retries

        self.session = requests.Session()
        ua = user_agent or (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        )
        self.session.headers.update({
            "User-Agent": ua,
            "Accept": "application/json, text/html, */*",
            "Accept-Language": "en-US,en;q=0.9",
        })

    def _sleep_delay(self):
        # Add jitter to delay to be polite and avoid detection
        jitter = random.uniform(0.8, 1.2)
        time.sleep(self.request_delay * jitter)

    def _get_with_retry(self, url: str, is_json: bool = False, timeout: float = 12.0) -> Optional[requests.Response]:
        for attempt in range(self.max_retries):
            try:
                self._sleep_delay()
                resp = self.session.get(url, timeout=timeout)

                if resp.status_code == 200:
                    return resp
                elif resp.status_code in (400, 404):
                    # 400 usually means user list is private or user doesn't exist
                    return resp
                elif resp.status_code == 429:
                    wait_time = (2 ** attempt) + random.uniform(1.0, 3.0)
                    time.sleep(wait_time)
                elif resp.status_code >= 500:
                    time.sleep(1.5 * (attempt + 1))
            except (requests.RequestException, TimeoutError) as e:
                time.sleep(1.0 * (attempt + 1))
        return None

    def fetch_user_profile(
        self,
        username: str,
        list_type: str = "anime",
        force_refresh: bool = False,
        status: int = 7,  # 7 = all anime
    ) -> Optional[UserProfile]:
        """
        Fetches full anime or manga list for a username using MAL's load.json endpoint.
        Returns None if user does not exist or list is private.
        """
        username = username.strip()
        if not username:
            return None

        # Check database cache first
        if not force_refresh:
            cached = self.db.get_user_profile(username, list_type=list_type)
            if cached is not None:
                return cached

        profile = UserProfile(username=username, list_type=list_type)
        offset = 0
        endpoint_name = "animelist" if list_type == "anime" else "mangalist"

        while True:
            url = f"{self.BASE_URL}/{endpoint_name}/{quote(username)}/load.json?offset={offset}&status={status}"
            resp = self._get_with_retry(url, is_json=True)

            if resp is None:
                return None

            if resp.status_code in (400, 404):
                # Private list or not found
                return None

            try:
                data = resp.json()
            except ValueError:
                return None

            if not isinstance(data, list) or len(data) == 0:
                break

            for item in data:
                entry = AnimeEntry.from_dict(item)
                profile.entries[entry.anime_id] = entry

            offset += len(data)
            if len(data) < 300:
                # Last page reached
                break

        # Save to database
        self.db.save_user_profile(profile)
        return profile

    def discover_from_friends(self, username: str, max_friends: int = 200) -> List[str]:
        """Scrapes friends of a given user."""
        discovered: Set[str] = set()
        offset = 0

        while len(discovered) < max_friends:
            url = f"{self.BASE_URL}/profile/{quote(username)}/friends?offset={offset}"
            resp = self._get_with_retry(url)
            if not resp or resp.status_code != 200:
                break

            found = re.findall(r'/profile/([a-zA-Z0-9_-]+)', resp.text)
            new_users = {
                u for u in found
                if u.lower() != username.lower() and u.lower() not in SYSTEM_EXCLUDED_USERNAMES
            }

            if not new_users or new_users.issubset(discovered):
                break

            discovered.update(new_users)
            offset += 100
            if len(new_users) < 100:
                break

        friends_list = list(discovered)[:max_friends]
        self.db.add_candidates(friends_list, source=f"friends:{username}")
        return friends_list

    def discover_from_anime_recs_and_reviews(
        self, anime_id: int, anime_slug: str = "anime", max_users: int = 200
    ) -> List[str]:
        """
        Scrapes reviewers and recommenders of a specific anime.
        Users who love the same anime are strong candidates for high affinity!
        """
        discovered: Set[str] = set()

        # 1. User Recommendations
        url_recs = f"{self.BASE_URL}/anime/{anime_id}/{quote(anime_slug)}/userrecs"
        resp_recs = self._get_with_retry(url_recs)
        if resp_recs and resp_recs.status_code == 200:
            found = re.findall(r'/profile/([a-zA-Z0-9_-]+)', resp_recs.text)
            discovered.update(
                u for u in found if u.lower() not in SYSTEM_EXCLUDED_USERNAMES
            )

        # 2. Reviews
        if len(discovered) < max_users:
            url_rev = f"{self.BASE_URL}/anime/{anime_id}/{quote(anime_slug)}/reviews"
            resp_rev = self._get_with_retry(url_rev)
            if resp_rev and resp_rev.status_code == 200:
                found = re.findall(r'/profile/([a-zA-Z0-9_-]+)', resp_rev.text)
                discovered.update(
                    u for u in found if u.lower() not in SYSTEM_EXCLUDED_USERNAMES
                )

        results = list(discovered)[:max_users]
        self.db.add_candidates(results, source=f"anime:{anime_id}")
        return results

    def discover_from_top_anime(
        self, target_profile: UserProfile, top_n_anime: int = 5, max_per_anime: int = 150
    ) -> List[str]:
        """
        Discovers candidates from fans of the user's highest rated anime (rated 9 or 10).
        """
        top_entries = [e for e in target_profile.entries.values() if e.score >= 9]
        top_entries.sort(key=lambda e: e.score, reverse=True)

        discovered: Set[str] = set()
        for entry in top_entries[:top_n_anime]:
            slug = re.sub(r'[^a-zA-Z0-9_]+', '_', entry.title).strip('_') or "anime"
            users = self.discover_from_anime_recs_and_reviews(
                entry.anime_id, anime_slug=slug, max_users=max_per_anime
            )
            discovered.update(users)

        return list(discovered)

    def discover_from_online_users(self) -> List[str]:
        """Scrapes currently online / active users from users.php."""
        url = f"{self.BASE_URL}/users.php"
        resp = self._get_with_retry(url)
        if not resp or resp.status_code != 200:
            return []

        found = re.findall(r'/profile/([a-zA-Z0-9_-]+)', resp.text)
        users = [
            u for u in set(found)
            if u.lower() not in SYSTEM_EXCLUDED_USERNAMES
        ]
        self.db.add_candidates(users, source="online_users")
        return users

    def discover_from_forum(self, board_ids: Optional[List[int]] = None) -> List[str]:
        """Scrapes active users from MAL forum boards."""
        board_ids = board_ids or [1, 2, 3]  # Anime Series Discussion, Manga, General
        discovered: Set[str] = set()

        for bid in board_ids:
            url = f"{self.BASE_URL}/forum/?board={bid}"
            resp = self._get_with_retry(url)
            if resp and resp.status_code == 200:
                found = re.findall(r'/profile/([a-zA-Z0-9_-]+)', resp.text)
                discovered.update(
                    u for u in found if u.lower() not in SYSTEM_EXCLUDED_USERNAMES
                )

        users = list(discovered)
        self.db.add_candidates(users, source="forum")
        return users

    def discover_from_club(self, club_id: int) -> List[str]:
        """Scrapes members of a MAL club."""
        url = f"{self.BASE_URL}/clubs.php?cid={club_id}&action=members"
        resp = self._get_with_retry(url)
        if not resp or resp.status_code != 200:
            return []

        found = re.findall(r'/profile/([a-zA-Z0-9_-]+)', resp.text)
        users = [
            u for u in set(found)
            if u.lower() not in SYSTEM_EXCLUDED_USERNAMES
        ]
        self.db.add_candidates(users, source=f"club:{club_id}")
        return users
