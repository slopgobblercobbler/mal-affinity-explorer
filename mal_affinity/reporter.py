import os
import json
import csv
from typing import List, Dict, Any, Optional
from rich.console import Console
from rich.table import Table
from rich.panel import Panel

from mal_affinity.models import AffinityResult


console = Console()


def print_leaderboard(results: List[AffinityResult], target_user: str, min_shared: int = 10, limit: int = 25):
    """Prints a styled terminal table of top affinity results."""
    filtered = [r for r in results if r.shared_count >= min_shared]

    table = Table(
        title=f"Top Anime Soulmates for @{target_user} (Min {min_shared} Shared Anime)",
        header_style="bold magenta",
        border_style="dim",
    )

    table.add_column("Rank", justify="center", style="dim", width=6)
    table.add_column("Candidate", style="bold cyan", width=18)
    table.add_column("Affinity (%)", justify="right", width=14)
    table.add_column("Weighted (%)", justify="right", width=14)
    table.add_column("Shared", justify="right", width=10)
    table.add_column("Avg Diff", justify="right", width=12)
    table.add_column("Mutual Top Anime", style="italic green", width=30)

    for idx, r in enumerate(filtered[:limit], 1):
        # Color coding affinity
        if r.affinity >= 70:
            aff_str = f"[bold green]+{r.affinity:.1f}%[/bold green]"
        elif r.affinity >= 40:
            aff_str = f"[green]+{r.affinity:.1f}%[/green]"
        elif r.affinity >= 15:
            aff_str = f"[cyan]+{r.affinity:.1f}%[/cyan]"
        elif r.affinity >= 0:
            aff_str = f"[yellow]+{r.affinity:.1f}%[/yellow]"
        else:
            aff_str = f"[red]{r.affinity:.1f}%[/red]"

        w_str = f"[purple]+{r.weighted_affinity:.1f}%[/purple]" if r.weighted_affinity > 0 else f"{r.weighted_affinity:.1f}%"

        top_fav = ""
        if r.shared_favorites:
            top_fav = r.shared_favorites[0].title
            if len(top_fav) > 28:
                top_fav = top_fav[:25] + "..."

        table.add_row(
            f"#{idx}",
            r.candidate_user,
            aff_str,
            w_str,
            str(r.shared_count),
            f"{r.mean_abs_diff:.2f} pts",
            top_fav or "-",
        )

    console.print()
    console.print(table)
    console.print(f"[dim]Showing top {min(len(filtered), limit)} of {len(filtered)} matches[/dim]\n")


def print_deep_comparison(r: AffinityResult):
    """Prints a deep comparison breakdown between two users."""
    console.print()
    console.print(Panel(
        f"[bold cyan]@{r.target_user}[/bold cyan] vs [bold yellow]@{r.candidate_user}[/bold yellow]\n\n"
        f"  - Official Affinity: [bold green]{r.affinity:+.2f}%[/bold green]\n"
        f"  - Weighted Match Score: [purple]{r.weighted_affinity:+.2f}%[/purple]\n"
        f"  - Mutual Rated Anime: [bold]{r.shared_count}[/bold]\n"
        f"  - Mean Absolute Score Diff: [bold]{r.mean_abs_diff:.2f} points[/bold]",
        title="Anime Taste Comparison",
        border_style="blue",
    ))

    # Shared Favorites
    if r.shared_favorites:
        fav_table = Table(title="Mutual Favorites (Both Rated >= 8)", border_style="green")
        fav_table.add_column("Anime Title", style="white")
        fav_table.add_column(f"@{r.target_user}", justify="center", style="cyan")
        fav_table.add_column(f"@{r.candidate_user}", justify="center", style="yellow")
        for item in r.shared_favorites[:8]:
            fav_table.add_row(item.title, str(item.target_score), str(item.candidate_score))
        console.print(fav_table)

    # Disagreements
    if r.disagreements:
        dis_table = Table(title="Major Disagreements (Score Difference >= 2)", border_style="red")
        dis_table.add_column("Anime Title", style="white")
        dis_table.add_column(f"@{r.target_user}", justify="center", style="cyan")
        dis_table.add_column(f"@{r.candidate_user}", justify="center", style="yellow")
        dis_table.add_column("Difference", justify="center", style="bold red")
        for item in r.disagreements[:8]:
            dis_table.add_row(item.title, str(item.target_score), str(item.candidate_score), f"-{item.diff}" if item.target_score < item.candidate_score else f"+{item.diff}")
        console.print(dis_table)

    # Recommendations
    if r.recommendations:
        rec_table = Table(title=f"Recommendations for @{r.target_user} (Their top anime you haven't rated)", border_style="magenta")
        rec_table.add_column("Anime Title", style="white")
        rec_table.add_column(f"Score by @{r.candidate_user}", justify="center", style="bold green")
        for item in r.recommendations[:8]:
            rec_table.add_row(item["title"], f"{item['candidate_score']}/10")
        console.print(rec_table)


def export_results_json(results: List[AffinityResult], filepath: str):
    """Exports results to a JSON file."""
    data = [r.to_dict() for r in results]
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    console.print(f"[green]Saved {len(results)} results to JSON:[/green] {filepath}")


def export_results_csv(results: List[AffinityResult], filepath: str):
    """Exports results to a CSV file."""
    fieldnames = [
        "rank", "candidate_user", "affinity", "weighted_affinity",
        "shared_count", "mean_abs_diff"
    ]
    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for i, r in enumerate(results, 1):
            writer.writerow({
                "rank": i,
                "candidate_user": r.candidate_user,
                "affinity": round(r.affinity, 2),
                "weighted_affinity": round(r.weighted_affinity, 2),
                "shared_count": r.shared_count,
                "mean_abs_diff": round(r.mean_abs_diff, 2),
            })
    console.print(f"[green]Saved {len(results)} results to CSV:[/green] {filepath}")
