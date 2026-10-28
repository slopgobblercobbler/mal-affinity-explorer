/**
 * Cloudflare Worker CORS Proxy for MyAnimeList
 * Free, serverless, and executes globally with zero configuration.
 *
 * Deployment (Takes 1 minute):
 * 1. Go to https://dash.cloudflare.com/ -> Workers & Pages -> Create Worker
 * 2. Paste this code into the editor and click "Deploy"
 * 3. Copy your worker URL (e.g. https://mal-proxy.yourname.workers.dev)
 * 4. Paste it into the MAL Affinity Explorer settings on GitHub Pages!
 */

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight OPTIONS request
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    let target = url.searchParams.get("url");

    if (!target) {
      return new Response("Missing 'url' query parameter. Example: /?url=https://myanimelist.net/...", {
        status: 400,
        headers: {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    try {
      // Decode if double-encoded
      target = decodeURIComponent(target);
      const parsedTarget = new URL(target);

      if (!parsedTarget.hostname.includes("myanimelist.net")) {
        return new Response("Only requests to myanimelist.net are permitted.", {
          status: 403,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      // Fetch from MyAnimeList with modern browser headers
      const response = await fetch(target, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json, text/html, */*",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      // Clone response and attach open CORS headers
      const newHeaders = new Headers(response.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");
      newHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      newHeaders.set("Cache-Control", "public, max-age=300"); // 5 minute cache

      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });
    } catch (err) {
      return new Response(`Worker proxy error: ${err.message}`, {
        status: 500,
        headers: {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  },
};
