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
    console.print(f"Max candidates: [bold]{args.max_users}[/bold] | Min shared: [bold]{args.min_shared}[/bold]\n")

    # Step 1: Fetch target user profile
    with console.status(f"[cyan]Fetching list for @{target_user}...[/cyan]"):
        target_profile = scraper.fetch_user_profile(target_user, force_refresh=args.refresh)

    if not target_profile or target_profile.scored_count == 0:
        console.print(f"[bold red]Failed to fetch list for @{target_user}.[/bold red]")
        console.print("Ensure the list is public and the username is spelled correctly.")
        sys.exit(1)

    console.print(f"[green]Loaded @{target_user}:[/green] {target_profile.scored_count} scored anime.")

    # Step 2: Discover candidate users
    candidates: List[str] = []
    if args.candidates:
        candidates.extend([c.strip() for c in args.candidates.split(",") if c.strip()])

    with console.status("[yellow]Discovering candidate users...[/yellow]"):
        if "friends" in args.sources and len(candidates) < args.max_users:
            friends = scraper.discover_from_friends(target_user, max_friends=args.max_users)
            candidates.extend(friends)

        if "top-anime" in args.sources and len(candidates) < args.max_users:
            fans = scraper.discover_from_top_anime(target_profile, top_n_anime=5, max_per_anime=50)
            candidates.extend(fans)

        if "online" in args.sources and len(candidates) < args.max_users:
            online = scraper.discover_from_online_users()
            candidates.extend(online)

    # Deduplicate and remove self
    unique_candidates = [
        c for c in dict.fromkeys(candidates)
        if c.lower() != target_user.lower()
    ][:args.max_users]

    if not unique_candidates:
        console.print("[yellow]No candidate users found to evaluate.[/yellow]")
        return

    console.print(f"[green]Discovered {len(unique_candidates)} unique candidate users.[/green]\n")

    # Step 3: Evaluate candidates
    results: List[AffinityResult] = []

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
                    results.append(result)
                    db.save_affinity_result(result)
            progress.advance(task)

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
    p_find.add_argument("--sources", type=str, default="friends,top-anime,online", help="Sources: friends,top-anime,online")
    p_find.add_argument("--candidates", "-c", type=str, help="Comma-separated custom candidates")
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

    # Command: serve
    p_serve = subparsers.add_parser("serve", help="Run local web server & CORS proxy")
    p_serve.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
    p_serve.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to")

    args = parser.parse_args()

    if args.command == "find":
        handle_find(args)
    elif args.command == "compare":
        handle_compare(args)
    elif args.command == "serve":
        run_server(port=args.port, host=args.host)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
