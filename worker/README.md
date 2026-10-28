# Cloudflare Worker CORS Proxy for MyAnimeList

When running this web app on **GitHub Pages**, browser CORS restrictions prevent direct client-side requests to `myanimelist.net`.

This Cloudflare Worker provides a fast, free, and secure CORS proxy.

## 🚀 1-Click Free Setup

1. Sign up or log into [Cloudflare Dashboard](https://dash.cloudflare.com/) (100,000 free requests per day).
2. Go to **Workers & Pages** -> **Create application** -> **Create Worker**.
3. Replace the code in the Cloudflare editor with the contents of [`worker.js`](worker.js).
4. Click **Deploy**.
5. Copy your worker URL (e.g., `https://mal-cors-proxy.yourname.workers.dev`).
6. In the MAL Affinity Explorer UI, select **Custom Cloudflare Worker Proxy** and enter your URL:
   ```text
   https://mal-cors-proxy.yourname.workers.dev/?url=
   ```

That's it! Your GitHub Pages app can now query MyAnimeList from anywhere in the world.
