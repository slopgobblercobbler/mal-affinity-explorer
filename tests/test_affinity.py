import os
import math
import pytest
from mal_affinity.models import UserProfile, AnimeEntry, ComparisonItem
from mal_affinity.calculator import calculate_pearson, compute_affinity
from mal_affinity.db import MALDatabase


def test_pearson_identical_scores():
    x = [10, 8, 6, 9, 7]
    y = [10, 8, 6, 9, 7]
    r = calculate_pearson(x, y)
    assert math.isclose(r, 1.0, rel_tol=1e-5)


def test_pearson_opposite_scores():
    x = [10, 8, 6, 4, 2]
    y = [2, 4, 6, 8, 10]
    r = calculate_pearson(x, y)
    assert math.isclose(r, -1.0, rel_tol=1e-5)


def test_pearson_zero_variance():
    # If all ratings are identical, variance is zero -> correlation is undefined / 0
    x = [8, 8, 8, 8]
    y = [6, 7, 8, 9]
    r = calculate_pearson(x, y)
    assert r == 0.0


def test_pearson_short_list():
    assert calculate_pearson([10], [10]) == 0.0
    assert calculate_pearson([], []) == 0.0


def test_compute_affinity_structure():
    p1 = UserProfile(username="Alice")
    p1.entries[1] = AnimeEntry(anime_id=1, title="Show A", score=10)
    p1.entries[2] = AnimeEntry(anime_id=2, title="Show B", score=8)
    p1.entries[3] = AnimeEntry(anime_id=3, title="Show C", score=6)

    p2 = UserProfile(username="Bob")
    p2.entries[1] = AnimeEntry(anime_id=1, title="Show A", score=9)
    p2.entries[2] = AnimeEntry(anime_id=2, title="Show B", score=8)
    p2.entries[3] = AnimeEntry(anime_id=3, title="Show C", score=7)
    p2.entries[4] = AnimeEntry(anime_id=4, title="Show D", score=10)  # unwatched by Alice

    res = compute_affinity(p1, p2, min_shared=1)
    assert res.target_user == "Alice"
    assert res.candidate_user == "Bob"
    assert res.shared_count == 3
    assert res.affinity > 90.0
    assert len(res.recommendations) == 1
    assert res.recommendations[0]["anime_id"] == 4
    assert res.recommendations[0]["candidate_score"] == 10


def test_database_caching(tmp_path):
    db_file = str(tmp_path / "test.db")
    db = MALDatabase(db_file)

    p = UserProfile(username="TestUser")
    p.entries[101] = AnimeEntry(anime_id=101, title="Test Anime", score=9)
    db.save_user_profile(p)

    loaded = db.get_user_profile("TestUser")
    assert loaded is not None
    assert loaded.username == "TestUser"
    assert 101 in loaded.entries
    assert loaded.entries[101].score == 9
