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
        Returns None if user does not exist or list is private. Caches results to prevent re-lookups.
        """
        username = username.strip()
        if not username:
            return None

        # Check database cache first
        if not force_refresh:
            cached = self.db.get_user_profile(username, list_type=list_type)
            if cached is not None:
                if getattr(cached, "is_private", False):
                    return None  # already known to be private/invalid
                return cached

        profile = UserProfile(username=username, list_type=list_type)
        offset = 0
        endpoint_name = "animelist" if list_type == "anime" else "mangalist"

        while True:
            url = f"{self.BASE_URL}/{endpoint_name}/{quote(username)}/load.json?offset={offset}&status={status}"
            resp = self._get_with_retry(url, is_json=True)

            if resp is None:
                # Connection or network failure, do not permanently mark private
                return None

            if resp.status_code in (400, 404):
                # Private list or user does not exist: remember so we don't look up again!
                self.db.mark_user_private_or_invalid(username, list_type=list_type)
                return None

            try:
                data = resp.json()
            except ValueError:
                self.db.mark_user_private_or_invalid(username, list_type=list_type)
                return None

            if not isinstance(data, list) or len(data) == 0:
                if offset == 0:
                    # User has an empty list
                    self.db.mark_user_private_or_invalid(username, list_type=list_type)
                    return None
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

    def discover_from_friends(
        self, username: str, max_friends: int = 200, is_valid_fn: Optional[Callable[[str], bool]] = None
    ) -> List[str]:
        """Scrapes friends of a given user, paginating offset=0, 100, 200..."""
        discovered: Set[str] = set()
        offset = 0

        while len(discovered) < max_friends:
            url = f"{self.BASE_URL}/profile/{quote(username)}/friends?offset={offset}"
            resp = self._get_with_retry(url)
            if not resp or resp.status_code != 200:
                break

            found = re.findall(r'/profile/([a-zA-Z0-9_-]+)', resp.text)
            if not found:
                break

            for u in found:
                if u.lower() != username.lower() and u.lower() not in SYSTEM_EXCLUDED_USERNAMES:
                    if is_valid_fn is None or is_valid_fn(u):
                        discovered.add(u)
                        if len(discovered) >= max_friends:
                            break

            offset += 100
            if len(found) < 30:
                break

        friends_list = list(discovered)[:max_friends]
        self.db.add_candidates(friends_list, source=f"friends:{username}")
        return friends_list

    def discover_from_friends_of_friends(
        self, username: str, max_friends: int = 15, max_fof: int = 200, is_valid_fn: Optional[Callable[[str], bool]] = None
    ) -> List[str]:
        """
        Discovers 2nd-degree social network users (friends of the user's friends).
        """
        friends = self.discover_from_friends(username, max_friends=max_friends)
        discovered: Set[str] = set()

        for friend in friends:
            if len(discovered) >= max_fof:
                break
            offset = 0
            while offset <= 100 and len(discovered) < max_fof:
                url = f"{self.BASE_URL}/profile/{quote(friend)}/friends?offset={offset}"
                resp = self._get_with_retry(url)
                if not resp or resp.status_code != 200:
                    break
                found = re.findall(r'/profile/([a-zA-Z0-9_-]+)', resp.text)
                if not found:
                    break
                for u in found:
                    if (
                        u.lower() != username.lower()
                        and u.lower() != friend.lower()
                        and u.lower() not in SYSTEM_EXCLUDED_USERNAMES
                    ):
                        if is_valid_fn is None or is_valid_fn(u):
                            discovered.add(u)
                            if len(discovered) >= max_fof:
                                break
                offset += 100

        fof_list = list(discovered)[:max_fof]
        self.db.add_candidates(fof_list, source=f"fof:{username}")
        return fof_list

    def discover_from_top_anime(
        self, target_profile: UserProfile, max_users: int = 200, is_valid_fn: Optional[Callable[[str], bool]] = None
    ) -> List[str]:
        """
        Discovers candidates from fans of the user's highest rated anime (rated >= 8), paginating reviews.
        """
        top_entries = [e for e in target_profile.entries.values() if e.score >= 8]
        top_entries.sort(key=lambda e: e.score, reverse=True)

        discovered: Set[str] = set()
        for entry in top_entries:
            if len(discovered) >= max_users:
                break
            slug = re.sub(r'[^a-zA-Z0-9_]+', '_', entry.title).strip('_') or "anime"

            # 1. Recommendations
            url_recs = f"{self.BASE_URL}/anime/{entry.anime_id}/{quote(slug)}/userrecs"
            resp_recs = self._get_with_retry(url_recs)
            if resp_recs and resp_recs.status_code == 200:
                found = re.findall(r'/profile/([a-zA-Z0-9_-]+)', resp_recs.text)
                for u in found:
                    if u.lower() != target_profile.username.lower() and u.lower() not in SYSTEM_EXCLUDED_USERNAMES:
                        if is_valid_fn is None or is_valid_fn(u):
                            discovered.add(u)
                            if len(discovered) >= max_users:
                                break

            # 2. Reviews pages (p=1, 2)
            for p in range(1, 3):
                if len(discovered) >= max_users:
                    break
                url_rev = f"{self.BASE_URL}/anime/{entry.anime_id}/{quote(slug)}/reviews?p={p}"
                resp_rev = self._get_with_retry(url_rev)
                if resp_rev and resp_rev.status_code == 200:
                    found = re.findall(r'/profile/([a-zA-Z0-9_-]+)', resp_rev.text)
                    for u in found:
                        if u.lower() != target_profile.username.lower() and u.lower() not in SYSTEM_EXCLUDED_USERNAMES:
                            if is_valid_fn is None or is_valid_fn(u):
                                discovered.add(u)
                                if len(discovered) >= max_users:
                                    break

        results = list(discovered)[:max_users]
        self.db.add_candidates(results, source="top_anime")
        return results

    def discover_from_seasonal(
        self, max_users: int = 150, is_valid_fn: Optional[Callable[[str], bool]] = None
    ) -> List[str]:
        """
        Scrapes reviewers and recommenders of current seasonal airing anime.
        """
        discovered: Set[str] = set()
        url = f"{self.BASE_URL}/anime/season"
        resp = self._get_with_retry(url)
        if not resp or resp.status_code != 200:
            return []

        anime_ids = list(dict.fromkeys(re.findall(r'/anime/(\d+)/', resp.text)))
        for aid in anime_ids:
            if len(discovered) >= max_users:
                break
            for p in range(1, 3):
                if len(discovered) >= max_users:
                    break
                rev_url = f"{self.BASE_URL}/anime/{aid}/_/reviews?p={p}"
                rev_resp = self._get_with_retry(rev_url)
                if rev_resp and rev_resp.status_code == 200:
                    found = re.findall(r'/profile/([a-zA-Z0-9_-]+)', rev_resp.text)
                    for u in found:
                        if u.lower() not in SYSTEM_EXCLUDED_USERNAMES:
                            if is_valid_fn is None or is_valid_fn(u):
                                discovered.add(u)
                                if len(discovered) >= max_users:
                                    break

        seasonal_list = list(discovered)[:max_users]
        self.db.add_candidates(seasonal_list, source="seasonal")
        return seasonal_list

    def discover_from_forum(
        self, board_ids: Optional[List[int]] = None, max_users: int = 200, is_valid_fn: Optional[Callable[[str], bool]] = None
    ) -> List[str]:
        """
        Scrapes active users from MAL forum boards with pagination show=0, 50, 100...
        """
        board_ids = board_ids or [16, 1, 4, 7, 3]
        discovered: Set[str] = set()

        for bid in board_ids:
            if len(discovered) >= max_users:
                break
            show = 0
            while show <= 200 and len(discovered) < max_users:
                url = f"{self.BASE_URL}/forum/?board={bid}&show={show}"
                resp = self._get_with_retry(url)
                if not resp or resp.status_code != 200:
                    break
                found = re.findall(r'/profile/([a-zA-Z0-9_-]+)', resp.text)
                if not found:
                    break
                for u in found:
                    if u.lower() not in SYSTEM_EXCLUDED_USERNAMES:
                        if is_valid_fn is None or is_valid_fn(u):
                            discovered.add(u)
                            if len(discovered) >= max_users:
                                break
                show += 50

        users = list(discovered)[:max_users]
        self.db.add_candidates(users, source="forum")
        return users

    def discover_from_clubs(
        self, club_ids: Optional[List[int]] = None, max_users: int = 200, is_valid_fn: Optional[Callable[[str], bool]] = None
    ) -> List[str]:
        """
        Scrapes members of prominent active MAL clubs with pagination p=1, 2, 3...
        """
        club_ids = club_ids or [1, 77, 3538, 169, 66]
        discovered: Set[str] = set()

        for cid in club_ids:
            if len(discovered) >= max_users:
                break
            p = 1
            while p <= 6 and len(discovered) < max_users:
                url = f"{self.BASE_URL}/clubs.php?cid={cid}&action=members&p={p}"
                resp = self._get_with_retry(url)
                if not resp or resp.status_code != 200:
                    break
                found = re.findall(r'/profile/([a-zA-Z0-9_-]+)', resp.text)
                if not found:
                    break
                for u in found:
                    if u.lower() not in SYSTEM_EXCLUDED_USERNAMES:
                        if is_valid_fn is None or is_valid_fn(u):
                            discovered.add(u)
                            if len(discovered) >= max_users:
                                break
                p += 1

        users = list(discovered)[:max_users]
        self.db.add_candidates(users, source="clubs")
        return users
