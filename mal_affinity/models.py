from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any


@dataclass
class AnimeEntry:
    anime_id: int
    title: str
    score: int  # 1-10, 0 means unscored
    title_eng: str = ""
    status: int = 0  # 1: watching, 2: completed, 3: on hold, 4: dropped, 6: plan to watch
    image_url: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "anime_id": self.anime_id,
            "title": self.title,
            "title_eng": self.title_eng,
            "score": self.score,
            "status": self.status,
            "image_url": self.image_url,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AnimeEntry":
        return cls(
            anime_id=int(data.get("anime_id", 0)),
            title=str(data.get("anime_title") or data.get("title", "")),
            score=int(data.get("score", 0)),
            title_eng=str(data.get("anime_title_eng") or data.get("title_eng", "")),
            status=int(data.get("status", 0)),
            image_url=str(data.get("anime_image_path") or data.get("image_url", "")),
        )


@dataclass
class UserProfile:
    username: str
    list_type: str = "anime"
    entries: Dict[int, AnimeEntry] = field(default_factory=dict)

    @property
    def scored_entries(self) -> Dict[int, AnimeEntry]:
        return {k: v for k, v in self.entries.items() if v.score > 0}

    @property
    def scored_count(self) -> int:
        return len(self.scored_entries)

    def get_score_map(self) -> Dict[int, int]:
        return {k: v.score for k, v in self.entries.items() if v.score > 0}


@dataclass
class ComparisonItem:
    anime_id: int
    title: str
    target_score: int
    candidate_score: int
    diff: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "anime_id": self.anime_id,
            "title": self.title,
            "target_score": self.target_score,
            "candidate_score": self.candidate_score,
            "diff": self.diff,
        }


@dataclass
class AffinityResult:
    target_user: str
    candidate_user: str
    affinity: float  # Pearson correlation percentage: -100.0 to +100.0
    shared_count: int
    mean_abs_diff: float
    weighted_affinity: float
    shared_favorites: List[ComparisonItem] = field(default_factory=list)
    disagreements: List[ComparisonItem] = field(default_factory=list)
    recommendations: List[Dict[str, Any]] = field(default_factory=list)
    all_shared: List[ComparisonItem] = field(default_factory=list)

    def to_dict(self, include_all_shared: bool = False) -> Dict[str, Any]:
        d = {
            "target_user": self.target_user,
            "candidate_user": self.candidate_user,
            "affinity": round(self.affinity, 2),
            "shared_count": self.shared_count,
            "mean_abs_diff": round(self.mean_abs_diff, 2),
            "weighted_affinity": round(self.weighted_affinity, 2),
            "shared_favorites": [item.to_dict() for item in self.shared_favorites],
            "disagreements": [item.to_dict() for item in self.disagreements],
            "recommendations": self.recommendations,
        }
        if include_all_shared:
            d["all_shared"] = [item.to_dict() for item in self.all_shared]
        return d
