#!/usr/bin/env python3
"""
MAL Affinity Explorer CLI
Discover MyAnimeList users with the highest affinity to your anime taste.
"""

import sys
import argparse
from typing import List

from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TaskProgressColumn

from mal_affinity.models import UserProfile, AffinityResult
from mal_affinity.db import MALDatabase
from mal_affinity.scraper import MALScraper
from mal_affinity.calculator import compute_affinity
from mal_affinity.reporter import (
    print_leaderboard,
    print_deep_comparison,
    export_results_json,
    export_results_csv,
)
from server import run_server


console = Console()


def handle_find(args):
    target_user = args.user.strip()
    if not target_user:
        console.print("[bold red]Error:[/bold red] Username is required. Use --user <username>")
        sys.exit(1)

    db = MALDatabase(args.db)
    scraper = MALScraper(db=db, request_delay=args.delay)

    console.print(f"\n[bold blue]=== MAL Affinity Explorer ===[/bold blue]")
    console.print(f"Target User: [bold cyan]@{target_user}[/bold cyan]")
    console.print(f"Max new candidates to evaluate: [bold]{args.max_users}[/bold] | Min shared: [bold]{args.min_shared}[/bold]")
    console.print(f"Discovery sources: [dim]{args.sources}[/dim]\n")

    # Step 1: Fetch target user profile
    with console.status(f"[cyan]Fetching list for @{target_user}...[/cyan]"):
        target_profile = scraper.fetch_user_profile(target_user, force_refresh=args.refresh)

    if not target_profile or target_profile.scored_count == 0:
        console.print(f"[bold red]Failed to fetch list for @{target_user}.[/bold red]")
        console.print("Ensure the list is public and the username is spelled correctly.")
        sys.exit(1)

    console.print(f"[green]Loaded @{target_user}:[/green] {target_profile.scored_count} scored anime.")

    # Check already evaluated candidates in SQLite cache
    already_evaluated = set()
    results_map = {}

    if args.load_cached:
        cached_affinities = db.get_top_affinities(target_user, min_shared=1, limit=5000)
        for row in cached_affinities:
            details = row.get("details", {})
            cand = row["candidate_user"]
            res = AffinityResult(
                target_user=target_user,
                candidate_user=cand,
                affinity=row["affinity"],
                shared_count=row["shared_count"],
                mean_abs_diff=row["mean_diff"],
                weighted_affinity=row["weighted_affinity"],
            )
            # Reconstruct favorites/disagreements/recommendations if present in details
            if "shared_favorites" in details:
                from mal_affinity.models import ComparisonItem
                res.shared_favorites = [
                    ComparisonItem(
                        anime_id=f["anime_id"],
                        title=f["title"],
                        target_score=f["target_score"],
                        candidate_score=f["candidate_score"],
                        diff=f["diff"],
                    )
                    for f in details["shared_favorites"]
                ]
            if "recommendations" in details:
                res.recommendations = details["recommendations"]
            results_map[cand.lower()] = res

        if results_map:
            console.print(f"[dim]Loaded {len(results_map)} previously evaluated soulmates from cache.[/dim]")

    if args.skip_scanned:
        already_evaluated = db.get_evaluated_candidates(target_user)

    # Step 2: Discover candidate users from multiple channels
    candidate_set = set()
    if args.candidates:
        for c in args.candidates.split(","):
            c_clean = c.strip()
            if c_clean and c_clean.lower() != target_user.lower():
                if not args.skip_scanned or c_clean.lower() not in already_evaluated:
                    candidate_set.add(c_clean)

    sources = [s.strip().lower() for s in args.sources.split(",") if s.strip()]

    def is_valid_candidate(u: str) -> bool:
        u_clean = u.strip()
        u_lower = u_clean.lower()
        if not u_clean or u_lower == target_user.lower():
            return False
        if args.skip_scanned and u_lower in already_evaluated:
            return False
        if u_clean in candidate_set:
            return False
        return True

    with console.status("[yellow]Discovering fresh candidate users...[/yellow]"):
        # 1. Direct Friends
        if "friends" in sources and len(candidate_set) < args.max_users:
            needed = args.max_users - len(candidate_set)
            friends = scraper.discover_from_friends(target_user, max_friends=needed, is_valid_fn=is_valid_candidate)
            candidate_set.update(friends)

        # 2. Friends of Friends (2nd-degree network)
        if "fof" in sources and len(candidate_set) < args.max_users:
            needed = args.max_users - len(candidate_set)
            fof = scraper.discover_from_friends_of_friends(target_user, max_friends=15, max_fof=needed, is_valid_fn=is_valid_candidate)
            candidate_set.update(fof)

        # 3. Fans & Reviewers of Top Anime
        if "top-anime" in sources and len(candidate_set) < args.max_users:
            needed = args.max_users - len(candidate_set)
            fans = scraper.discover_from_top_anime(target_profile, max_users=needed, is_valid_fn=is_valid_candidate)
            candidate_set.update(fans)

        # 4. Seasonal Airing Anime Reviewers
        if "seasonal" in sources and len(candidate_set) < args.max_users:
            needed = args.max_users - len(candidate_set)
            seasonal = scraper.discover_from_seasonal(max_users=needed, is_valid_fn=is_valid_candidate)
            candidate_set.update(seasonal)

        # 5. Recommendation & Discussion Forums
        if "forums" in sources and len(candidate_set) < args.max_users:
            needed = args.max_users - len(candidate_set)
            forum_users = scraper.discover_from_forum(board_ids=[16, 1, 4, 7, 3], max_users=needed, is_valid_fn=is_valid_candidate)
            candidate_set.update(forum_users)

        # 6. Anime Clubs
        if "clubs" in sources and len(candidate_set) < args.max_users:
            needed = args.max_users - len(candidate_set)
            club_users = scraper.discover_from_clubs(club_ids=[1, 77, 3538, 169, 66], max_users=needed, is_valid_fn=is_valid_candidate)
            candidate_set.update(club_users)

        # 7. Online / Active Users
        if "online" in sources and len(candidate_set) < args.max_users:
            online = scraper.discover_from_online_users()
            for u in online:
                if is_valid_candidate(u):
                    candidate_set.add(u)
                    if len(candidate_set) >= args.max_users:
                        break

        # 8. Profile Comments
        if "comments" in sources and len(candidate_set) < args.max_users:
            commenters = scraper.discover_from_profile_comments(target_user, max_users=50)
            for u in commenters:
                if is_valid_candidate(u):
                    candidate_set.add(u)
                    if len(candidate_set) >= args.max_users:
                        break

    unique_candidates = list(candidate_set)[:args.max_users]

    if not unique_candidates:
        if results_map:
            console.print("[yellow]No new unscanned candidates found in selected sources. Displaying cached results.[/yellow]\n")
        else:
            console.print("[yellow]No candidate users found to evaluate.[/yellow]")
            return
    else:
        console.print(f"[green]Discovered {len(unique_candidates)} fresh candidate users to evaluate.[/green]\n")

        # Step 3: Evaluate fresh candidates
        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            console=console,
        ) as progress:
            task = progress.add_task("[cyan]Evaluating affinities...", total=len(unique_candidates))

            for cand_name in unique_candidates:
                progress.update(task, description=f"[cyan]Evaluating @{cand_name}...")
                cand_profile = scraper.fetch_user_profile(cand_name, force_refresh=args.refresh)
                if cand_profile and cand_profile.scored_count > 0:
                    result = compute_affinity(target_profile, cand_profile, min_shared=args.min_shared)
                    if result.shared_count >= 2:
                        results_map[cand_name.lower()] = result
                        db.save_affinity_result(result)
                progress.advance(task)

    results = list(results_map.values())

    # Step 4: Sort and Display
    if args.sort == "weighted":
        results.sort(key=lambda r: r.weighted_affinity, reverse=True)
    elif args.sort == "affinity":
        results.sort(key=lambda r: (r.affinity, r.shared_count), reverse=True)
    elif args.sort == "shared":
        results.sort(key=lambda r: (r.shared_count, r.affinity), reverse=True)
    elif args.sort == "diff":
        results.sort(key=lambda r: r.mean_abs_diff)

    print_leaderboard(results, target_user, min_shared=args.min_shared, limit=args.limit)

    # Export if requested
    if args.json:
        export_results_json(results, args.json)
    if args.csv:
        export_results_csv(results, args.csv)


def handle_compare(args):
    target_user = args.user.strip()
    candidate_user = args.candidate.strip()

    db = MALDatabase(args.db)
    scraper = MALScraper(db=db, request_delay=args.delay)

    with console.status(f"[cyan]Loading @{target_user} and @{candidate_user}...[/cyan]"):
        p1 = scraper.fetch_user_profile(target_user, force_refresh=args.refresh)
        p2 = scraper.fetch_user_profile(candidate_user, force_refresh=args.refresh)

    if not p1 or not p2:
        console.print("[bold red]Failed to load user lists for comparison.[/bold red]")
        sys.exit(1)

    result = compute_affinity(p1, p2, min_shared=1)
    print_deep_comparison(result)


def handle_stats(args):
    db = MALDatabase(args.db)
    stats = db.get_database_stats()
    console.print("\n[bold blue]=== MAL Affinity Database Cache Statistics ===[/bold blue]")
    console.print(f"Database File: [cyan]{args.db}[/cyan]")
    console.print(f"  - Valid Scraped User Profiles: [bold green]{stats['valid_profiles']}[/bold green]")
    console.print(f"  - Private / Invalid Profiles (Cached): [bold yellow]{stats['private_profiles']}[/bold yellow]")
    console.print(f"  - Total Affinity Comparisons Saved: [bold purple]{stats['affinities']}[/bold purple]")
    console.print(f"  - Queued Discovery Candidates: [bold]{stats['queued_candidates']}[/bold]\n")


def handle_clear(args):
    db = MALDatabase(args.db)
    db.clear_cache()
    console.print(f"[green]Successfully cleared cache database ({args.db}).[/green]")


def main():
    parser = argparse.ArgumentParser(
        description="MAL Affinity Explorer - Scrape & Rank MAL Users by Taste Affinity"
    )
    subparsers = parser.add_subparsers(dest="command", help="Subcommand to execute")

    # Command: find
    p_find = subparsers.add_parser("find", help="Find users with highest affinity to you")
    p_find.add_argument("--user", "-u", type=str, required=True, help="Your MyAnimeList username")
    p_find.add_argument("--max-users", "-n", type=int, default=30, help="Max candidates to evaluate (default: 30)")
    p_find.add_argument("--min-shared", "-m", type=int, default=10, help="Min shared anime to show (default: 10)")
    p_find.add_argument(
        "--sources",
        type=str,
        default="friends,fof,top-anime,seasonal,forums,clubs,online,comments",
        help="Sources: friends,fof,top-anime,seasonal,forums,clubs,online,comments",
    )
    p_find.add_argument("--candidates", "-c", type=str, help="Comma-separated custom candidates")
    p_find.add_argument("--skip-scanned", action="store_true", default=True, help="Skip already evaluated candidates (default: True)")
    p_find.add_argument("--no-skip-scanned", dest="skip_scanned", action="store_false", help="Do not skip already evaluated candidates")
    p_find.add_argument("--load-cached", action="store_true", default=True, help="Pre-load cached affinity results for this user (default: True)")
    p_find.add_argument("--no-load-cached", dest="load_cached", action="store_false", help="Only show results from current run")
    p_find.add_argument("--sort", type=str, choices=["weighted", "affinity", "shared", "diff"], default="weighted", help="Ranking sort metric")
    p_find.add_argument("--limit", type=int, default=25, help="Max rows to display in terminal")
    p_find.add_argument("--delay", type=float, default=0.4, help="Delay between requests in seconds")
    p_find.add_argument("--refresh", action="store_true", help="Force refresh cache")
    p_find.add_argument("--db", type=str, default="mal_affinity.db", help="SQLite database path")
    p_find.add_argument("--json", type=str, help="Export results to JSON file path")
    p_find.add_argument("--csv", type=str, help="Export results to CSV file path")

    # Command: compare
    p_compare = subparsers.add_parser("compare", help="Compare affinity with a specific user")
    p_compare.add_argument("--user", "-u", type=str, required=True, help="Your username")
    p_compare.add_argument("--candidate", "-c", type=str, required=True, help="Candidate username")
    p_compare.add_argument("--delay", type=float, default=0.4, help="Delay between requests")
    p_compare.add_argument("--refresh", action="store_true", help="Force refresh cache")
    p_compare.add_argument("--db", type=str, default="mal_affinity.db", help="SQLite database path")

    # Command: stats
    p_stats = subparsers.add_parser("stats", help="View database cache statistics")
    p_stats.add_argument("--db", type=str, default="mal_affinity.db", help="SQLite database path")

    # Command: clear
    p_clear = subparsers.add_parser("clear", help="Clear SQLite database cache")
    p_clear.add_argument("--db", type=str, default="mal_affinity.db", help="SQLite database path")

    # Command: serve
    p_serve = subparsers.add_parser("serve", help="Run local web server & CORS proxy")
    p_serve.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
    p_serve.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to")

    args = parser.parse_args()

    if args.command == "find":
        handle_find(args)
    elif args.command == "compare":
        handle_compare(args)
    elif args.command == "stats":
        handle_stats(args)
    elif args.command == "clear":
        handle_clear(args)
    elif args.command == "serve":
        run_server(port=args.port, host=args.host)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
