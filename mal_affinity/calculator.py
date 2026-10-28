import math
from typing import Dict, List, Tuple
from mal_affinity.models import UserProfile, ComparisonItem, AffinityResult, AnimeEntry


def calculate_pearson(x: List[int], y: List[int]) -> float:
    """
    Computes Pearson Correlation Coefficient r between two lists of integers.
    Returns r in range [-1.0, 1.0], or 0.0 if variance is zero or length < 2.
    """
    n = len(x)
    if n < 2:
        return 0.0

    mean_x = sum(x) / n
    mean_y = sum(y) / n

    num = sum((x[i] - mean_x) * (y[i] - mean_y) for i in range(n))
    den_x = sum((x[i] - mean_x) ** 2 for i in range(n))
    den_y = sum((y[i] - mean_y) ** 2 for i in range(n))

    if den_x <= 0 or den_y <= 0:
        return 0.0

    r = num / math.sqrt(den_x * den_y)
    # Clamp due to floating point inaccuracies
    return max(-1.0, min(1.0, r))


def compute_affinity(
    target: UserProfile,
    candidate: UserProfile,
    min_shared: int = 1,
    shrinkage_k: float = 15.0,
) -> AffinityResult:
    """
    Calculates affinity, shared anime metrics, favorites, disagreements,
    and recommendations between target and candidate users.
    """
    target_scores = target.get_score_map()
    cand_scores = candidate.get_score_map()

    shared_ids = sorted(set(target_scores.keys()) & set(cand_scores.keys()))
    shared_count = len(shared_ids)

    if shared_count < 2:
        return AffinityResult(
            target_user=target.username,
            candidate_user=candidate.username,
            affinity=0.0,
            shared_count=shared_count,
            mean_abs_diff=0.0,
            weighted_affinity=0.0,
        )

    x = [target_scores[aid] for aid in shared_ids]
    y = [cand_scores[aid] for aid in shared_ids]

    r = calculate_pearson(x, y)
    affinity_pct = r * 100.0

    mean_diff = sum(abs(x[i] - y[i]) for i in range(shared_count)) / shared_count

    # Weighted affinity using shrinkage: dampens correlations with low sample sizes
    # Weight approaches 1.0 as shared_count >> shrinkage_k
    weight = shared_count / (shared_count + shrinkage_k)
    weighted_affinity = affinity_pct * weight

    all_shared: List[ComparisonItem] = []
    shared_favorites: List[ComparisonItem] = []
    disagreements: List[ComparisonItem] = []

    for aid in shared_ids:
        t_score = target_scores[aid]
        c_score = cand_scores[aid]
        diff = abs(t_score - c_score)
        entry = target.entries.get(aid) or candidate.entries.get(aid)
        title = entry.title if entry else f"Anime #{aid}"

        item = ComparisonItem(
            anime_id=aid,
            title=title,
            target_score=t_score,
            candidate_score=c_score,
            diff=diff,
        )
        all_shared.append(item)

        if t_score >= 8 and c_score >= 8:
            shared_favorites.append(item)

        if diff >= 2:
            disagreements.append(item)

    # Sort favorites by sum of scores descending
    shared_favorites.sort(key=lambda item: (item.target_score + item.candidate_score, -item.diff), reverse=True)
    # Sort disagreements by diff descending
    disagreements.sort(key=lambda item: item.diff, reverse=True)
    # Sort all shared by difference ascending, then score descending
    all_shared.sort(key=lambda item: (item.diff, -(item.target_score + item.candidate_score)))

    # Discover recommendations: candidate scored >= 8, target hasn't scored
    recommendations = []
    for aid, entry in candidate.entries.items():
        if entry.score >= 8 and (aid not in target_scores or target_scores[aid] == 0):
            recommendations.append({
                "anime_id": aid,
                "title": entry.title,
                "title_eng": entry.title_eng,
                "candidate_score": entry.score,
                "status": entry.status,
                "image_url": entry.image_url,
            })

    recommendations.sort(key=lambda r: r["candidate_score"], reverse=True)

    return AffinityResult(
        target_user=target.username,
        candidate_user=candidate.username,
        affinity=affinity_pct,
        shared_count=shared_count,
        mean_abs_diff=mean_diff,
        weighted_affinity=weighted_affinity,
        shared_favorites=shared_favorites,
        disagreements=disagreements,
        recommendations=recommendations,
        all_shared=all_shared,
    )
