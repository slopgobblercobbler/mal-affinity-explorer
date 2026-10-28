# 🌌 MAL Affinity Explorer

[![GitHub Pages Deployment](https://img.shields.io/badge/GitHub%20Pages-Live%20Demo-blue?style=for-the-badge&logo=github)](https://slopggobblercobbler81.github.io/mal-affinity-explorer/)
[![Python 3.9+](https://img.shields.io/badge/Python-3.9+-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://python.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

An intelligent anime taste soulmate finder for **MyAnimeList (MAL)**. Input your username, and it automatically scrapes candidates across your social graph and discovers the users with the highest taste affinity to you.

Includes both a **GitHub Pages Single-Page Application (SPA)** and a **Python CLI / Local Server**.

---

## ✨ Features

- **🌐 GitHub Pages Ready**: Zero build steps required (`index.html` + `app.js` + `style.css`). Deploy directly to GitHub Pages with the included GitHub Actions workflow.
- **📐 Mathematical Precision**: Implements the official Pearson correlation coefficient ($r \times 100\%$) across mutually rated anime ($score > 0$).
- **⚖️ Weighted Affinity (Bayesian Smoothing)**: Applies shrinkage ($k = 15$) so a fluke match with 2 shared anime won't outrank someone with 85% affinity across 200 shared anime.
- **🔍 Multi-Channel Candidate Discovery**:
  - **Friends Network**: Scrapes your friends list.
  - **Taste Twins**: Scrapes users who reviewed or recommended your 9/10 and 10/10 rated anime.
  - **Online / Active Users**: Discovers currently active members on MAL.
  - **Custom Usernames**: Evaluate any custom list of candidates.
- **🎯 Deep Taste Breakdown**:
  - **Mutual Favorites**: Anime both users rated 8–10.
  - **Score Disagreements**: Anime where ratings differed significantly ($\Delta \ge 2$).
  - **Personalized Recommendations**: Top anime the candidate rated 9–10 that you haven't watched yet!
- **⚡ Multiple Proxy Options**: Built-in support for a 1-click Cloudflare Worker proxy, local Python server proxy, or direct browser extension mode.
- **📊 Export Options**: One-click export of rankings to **JSON** and **CSV**.

---

## 🚀 Quick Start (Web App on GitHub Pages)

### Option A: Use the Live GitHub Pages Site
1. Open the [MAL Affinity Explorer](https://slopggobblercobbler81.github.io/mal-affinity-explorer/).
2. Enter your MAL username (e.g. `Xinil`).
3. Select how many users ($N$) to evaluate (15, 30, 60, 120).
4. Click **Find Soulmates**!

> **Note on Browser CORS**: Because MyAnimeList does not enable browser CORS headers, client-side requests from GitHub Pages require a proxy:
> - **Recommended**: Deploy our 1-click free Cloudflare Worker (see [`worker/README.md`](worker/README.md)).
> - **Or**: Run locally with `python server.py`.
> - **Or**: Use a browser CORS extension (e.g., "Allow CORS: Access-Control-Allow-Origin").

---

## 💻 Local Server (Zero Dependencies)

If you prefer running locally without setting up any external proxies:

```bash
# Clone the repository
git clone https://github.com/slopggobblercobbler81/mal-affinity-explorer.git
cd mal-affinity-explorer

# Start the local server (pure Python standard library - no pip install needed!)
python server.py
```

Open your browser to:
```text
http://localhost:8000
```
The local server automatically serves the web UI and transparently handles MAL requests without any CORS blocks!

---

## 🖥️ Command Line Interface (CLI)

For terminal power users, a high-performance Python CLI is included:

```bash
# Install CLI dependencies
pip install -r requirements.txt

# Find top affinity users for your profile
python mal_affinity_cli.py find --user YourUsername -n 30 -m 10

# Compare two specific users in depth
python mal_affinity_cli.py compare --user YourUsername --candidate TargetUser

# Export results to JSON or CSV
python mal_affinity_cli.py find --user YourUsername -n 50 --json results.json --csv results.csv
```

### CLI Arguments
| Flag | Description | Default |
|------|-------------|---------|
| `--user`, `-u` | Your MyAnimeList username (required) | — |
| `--max-users`, `-n` | Maximum candidates to evaluate | `30` |
| `--min-shared`, `-m` | Minimum mutually rated anime to display | `10` |
| `--sources` | Discovery channels: `friends,top-anime,online` | all |
| `--sort` | Sort order: `weighted`, `affinity`, `shared`, `diff` | `weighted` |
| `--delay` | Politeness delay between requests (seconds) | `0.4` |
| `--refresh` | Bypass SQLite cache and force re-fetch | `False` |

---

## 📐 How Affinity is Calculated

### 1. Pearson Correlation Coefficient
For all anime $i \in \{1 \dots n\}$ where **both** users provided a rating $> 0$:

$$r = \frac{\sum_{i=1}^n (x_i - \bar{x})(y_i - \bar{y})}{\sqrt{\sum_{i=1}^n (x_i - \bar{x})^2} \sqrt{\sum_{i=1}^n (y_i - \bar{y})^2}}$$

$$\text{Affinity \%} = r \times 100\%$$

- **$+100\%$**: Identical taste shifts (when you like something more, they do too).
- **$0\%$**: Completely independent taste.
- **$-100\%$**: Completely inverted taste.

### 2. Weighted Affinity (Bayesian Shrinkage)
To reward statistical confidence with larger sample sizes:

$$\text{Weight} = \frac{n}{n + k} \quad (\text{with } k = 15)$$

$$\text{Weighted Affinity} = \text{Affinity \%} \times \text{Weight}$$

---

## 📁 Repository Structure

```text
├── index.html                  # GitHub Pages web app
├── app.js                      # Client-side scraping & Pearson calculation
├── style.css                   # Glassmorphic UI styles
├── server.py                   # Local zero-dependency server & CORS proxy
├── mal_affinity_cli.py         # CLI entry point
├── mal_affinity/               # Core Python library
│   ├── calculator.py           # Pearson correlation & ranking logic
│   ├── db.py                   # SQLite caching layer
│   ├── models.py               # Data structures
│   ├── reporter.py             # Rich terminal tables & file exporter
│   └── scraper.py              # MAL scraper & discovery channels
├── worker/                     # Free Cloudflare Worker CORS proxy
│   ├── worker.js               # Worker source code
│   ├── wrangler.toml           # Wrangler config
│   └── README.md               # 1-minute setup guide
├── .github/workflows/          # Automated GitHub Pages deployment
│   └── deploy.yml
├── tests/                      # Automated unit tests
│   └── test_affinity.py
├── requirements.txt            # Python dependencies
└── LICENSE                     # MIT License
```

---

## 🧪 Testing

```bash
python -m pytest tests/
```

---

## 📜 License

Distributed under the [MIT License](LICENSE).
