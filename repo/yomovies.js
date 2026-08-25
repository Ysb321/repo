// ==MiruExtension==
// @name         YoMovies
// @version      v0.0.9
// @author       OshekharO
// @lang         hi
// @license      MIT
// @package      yomovies
// @type         bangumi
// @icon         https://dl.memuplay.com/new_market/img/com.wYoMovies_7822289.sc1.2024-05-21-17-59-43.jpg
// @webSite      https://yomovies.energy
// @nsfw         false
// ==/MiruExtension==

const SITE_URL = "https://yomovies.energy";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export default class extends Extension {
  async latest(page = 1) {
    const path = Number(page) > 1 ? `/page/${page}/` : "/";
    return this.getMovies(await this.request(path));
  }

  async search(kw, page = 1) {
    const query = encodeURIComponent(String(kw || "").trim());
    const suffix = Number(page) > 1 ? `&paged=${page}` : "";
    return this.getMovies(await this.request(`/?s=${query}${suffix}`));
  }

  async detail(url) {
    const pageUrl = this.resolveUrl(url);
    const res = await this.requestPage(pageUrl, SITE_URL);

    const h1 = await this.textOf(res, "h1");
    const ogTitle = await this.attributeOf(
      res,
      "meta[property='og:title']",
      "content"
    );
    const pageTitle = await this.textOf(res, "title");
    const title = this.cleanText(h1 || ogTitle || pageTitle || "YoMovies");

    const cover = await this.firstAttribute(res, [
      ["img[itemprop='image']", "src"],
      ["img[itemprop='image']", "data-src"],
      ["meta[property='og:image']", "content"],
      ["meta[name='twitter:image']", "content"],
    ]);

    const desc = await this.firstText(res, [
      "p.f-desc",
      ".f-desc",
      ".desc",
      ".description",
    ]);

    // The playable server tabs use embedded SpeedoStream pages. Prefer
    // those over the site's download links: download links can expire while
    // the embedded player is still available.
    const playerUrls = await this.getEmbeddedPlayerUrls(res, pageUrl);
    const downloadUrls = await this.getDownloadUrls(res, title);
    const fallbackUrls = this.extractMediaUrls(res, pageUrl).concat(
      this.extractPlayerUrls(res, pageUrl).filter(
        (playerUrl) =>
          !/youtube|youtu\.be|premium|facebook|twitter|telegram/i.test(playerUrl)
      )
    );
    const urls = playerUrls.length
      ? playerUrls.map((playerUrl, index) => ({
          name: `Server ${index + 1}`,
          url: playerUrl,
        }))
      : downloadUrls.length
        ? downloadUrls
        : fallbackUrls.map((streamUrl, index) => ({
            name: `Server ${index + 1}`,
            url: streamUrl,
          }));

    return {
      title,
      cover: this.resolveUrl(cover, pageUrl),
      desc,
      episodes: [
        {
          title: urls.length ? "Download / Watch" : "Server",
          urls,
        },
      ],
    };
  }

  async watch(url) {
    let currentUrl = this.resolveUrl(url);
    let referer = SITE_URL;
    const visited = [];

    for (let attempt = 0; attempt < 4 && currentUrl; attempt += 1) {
      const directUrl = this.extractMediaUrls(currentUrl)[0];
      if (directUrl) return this.mediaResult(directUrl, referer);

      if (visited.includes(currentUrl)) break;
      visited.push(currentUrl);

      const res = await this.requestPage(currentUrl, referer);
      const mediaUrls = this.extractMediaUrls(res, currentUrl);
      if (mediaUrls.length) {
        return this.mediaResult(mediaUrls[0], currentUrl);
      }

      const playerUrls = this.extractPlayerUrls(res, currentUrl);
      const nextUrl = playerUrls.find(
        (candidate) =>
          !visited.includes(candidate) &&
          !/youtube|youtu\.be|premium|facebook|twitter|telegram/i.test(candidate)
      );

      if (!nextUrl) break;
      referer = currentUrl;
      currentUrl = nextUrl;
    }

    throw new Error(
      "YoMovies: no playable MP4 or HLS stream was found. The download link may have expired."
    );
  }

  async getMovies(res) {
    let cards = await this.querySelectorAll(res, "div.ml-item");
    if (!cards.length) cards = await this.querySelectorAll(res, ".ml-item");

    const movies = [];
    const seen = new Set();

    for (const card of cards) {
      const html = await card.content;
      const url = await this.firstAttribute(html, [
        ["a", "href"],
        ["a", "data-href"],
      ]);
      const title = this.cleanText(
        (await this.firstText(html, [
          "div.qtip-title",
          ".qtip-title",
          "h2",
          "h3",
          ".title",
        ])) ||
          (await this.attributeOf(html, "a", "title")) ||
          (await this.attributeOf(html, "img", "alt"))
      );
      const cover = await this.firstAttribute(html, [
        ["img", "data-original"],
        ["img", "data-src"],
        ["img", "src"],
      ]);
      const absoluteUrl = this.resolveUrl(url);

      if (!absoluteUrl || !title || seen.has(absoluteUrl)) continue;
      seen.add(absoluteUrl);
      movies.push({
        title,
        url: absoluteUrl,
        cover: this.resolveUrl(cover),
      });
    }

    return movies;
  }

  async getEmbeddedPlayerUrls(res, baseUrl) {
    const urls = [];
    const seen = new Set();
    const addUrl = (value) => {
      const url = this.resolveUrl(value, baseUrl);
      if (
        !url ||
        seen.has(url) ||
        !/^https?:\/\//i.test(url) ||
        /youtube|youtu\.be|premium|facebook|twitter|telegram/i.test(url) ||
        !/speedostream|movembed|minoplres/i.test(url) ||
        (/speedostream/i.test(url) && !/embed-/i.test(url))
      ) {
        return;
      }
      seen.add(url);
      urls.push(url);
    };

    // Current PsyPlay markup puts one iframe inside each server tab:
    // div[id*=tab] > div.movieplay > iframe.
    let iframes = await this.querySelectorAll(
      res,
      "div[id*=tab] div.movieplay > iframe"
    );
    if (!iframes.length) {
      iframes = await this.querySelectorAll(res, "div.movieplay > iframe");
    }
    if (!iframes.length) {
      iframes = await this.querySelectorAll(res, "#player2 iframe");
    }

    for (const iframe of iframes) {
      const html = await iframe.content;
      const src = await this.firstAttribute(html, [
        ["iframe", "src"],
        ["iframe", "data-src"],
      ]);
      addUrl(src);
    }

    // Keep a raw-HTML fallback for parser/runtime versions that do not
    // support the :has or attribute selectors used by newer PsyPlay pages.
    if (!urls.length) {
      const candidates = this.extractPlayerUrls(res, baseUrl);
      candidates.forEach((candidate) => addUrl(candidate));
    }

    return urls;
  }

  async getDownloadUrls(res, title) {
    const urls = [];
    const seen = new Set();

    const addUrl = (url, name) => {
      const absoluteUrl = this.resolveUrl(url);
      if (
        !absoluteUrl ||
        !/^https?:\/\//i.test(absoluteUrl) ||
        seen.has(absoluteUrl) ||
        /#|javascript:|mailto:/i.test(absoluteUrl)
      ) {
        return;
      }
      seen.add(absoluteUrl);
      urls.push({
        name: this.cleanText(name) || `${title} Server ${urls.length + 1}`,
        url: absoluteUrl,
      });
    };

    const rows = await this.querySelectorAll(res, "#list-dl tr");
    for (const row of rows) {
      const html = await row.content;
      const href = await this.firstAttribute(html, [
        ["a", "href"],
        ["a", "data-href"],
      ]);
      if (!href) continue;

      const rowText = this.cleanText(html)
        .replace(/\bdownload\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      addUrl(href, rowText);
    }

    // Some revisions of the theme do not wrap the download table in <tr>.
    if (!urls.length) {
      const links = await this.querySelectorAll(res, "#list-dl a");
      for (const link of links) {
        const html = await link.content;
        const href = await this.attributeOf(html, "a", "href");
        const name = await this.textOf(html, "a");
        addUrl(href, name);
      }
    }

    // Keep a fallback for minor theme changes where the list id is removed.
    if (!urls.length) {
      const html = this.asText(res);
      const hrefs = [];
      const hrefRegex = /<a\b[^>]+href=["']([^"']+)["'][^>]*>/gi;
      let match;
      while ((match = hrefRegex.exec(html)) !== null) {
        const href = this.decodeEntities(match[1]);
        if (
          /^https?:\/\//i.test(href) &&
          !/yomovies\.energy/i.test(href) &&
          /(?:speedostream|stream|download|\.mp4(?:$|[?#])|\.m3u8(?:$|[?#]))/i.test(
            href
          )
        ) {
          hrefs.push(href);
        }
      }
      hrefs.forEach((href, index) => addUrl(href, `Server ${index + 1}`));
    }

    return urls;
  }

  async requestPage(url, referer) {
    return this.request("", {
      headers: {
        "Miru-Url": this.resolveUrl(url),
        Referer: referer || SITE_URL,
        "User-Agent": USER_AGENT,
      },
    });
  }

  async textOf(html, selector) {
    try {
      const element = await this.querySelector(html, selector);
      if (!element) return "";
      return this.cleanText(await element.text);
    } catch (_) {
      return "";
    }
  }

  async firstText(html, selectors) {
    for (const selector of selectors) {
      const value = await this.textOf(html, selector);
      if (value) return value;
    }
    return "";
  }

  async attributeOf(html, selector, attribute) {
    try {
      const value = await this.getAttributeText(html, selector, attribute);
      return this.decodeEntities(value || "").trim();
    } catch (_) {
      return "";
    }
  }

  async firstAttribute(html, candidates) {
    for (const [selector, attribute] of candidates) {
      const value = await this.attributeOf(html, selector, attribute);
      if (value) return value;
    }
    return "";
  }

  extractMediaUrls(value, baseUrl = SITE_URL) {
    const html = this.asText(value);
    // Player configuration is often JSON-escaped (https:\\/\\/host\\/file.mp4).
    // Normalising the searchable copy first keeps both HTML and JSON formats
    // covered by the same URL expressions.
    const searchable = html.replace(/\\\//g, "/");
    const urls = [];
    const seen = new Set();
    const add = (candidate, allowExtensionless = false) => {
      const url = this.resolveUrl(this.normaliseUrl(candidate), baseUrl);
      const isMediaFile = /\.(?:m3u8|mp4)(?:$|[?#])/i.test(url);
      if (
        !url ||
        seen.has(url) ||
        !/^https?:\/\//i.test(url) ||
        (!isMediaFile && !allowExtensionless)
      ) {
        return;
      }
      seen.add(url);
      urls.push(url);
    };

    const mediaRegex =
      /https?:\/\/[^"'<>\s]+?\.(?:m3u8|mp4)(?:\?[^"'<>\s]*)?/gi;
    let match;
    while ((match = mediaRegex.exec(searchable)) !== null) add(match[0]);

    // Speedostream exposes its HLS URL in a JWPlayer config, commonly as
    // sources: [{file: "https://.../playlist"}]. The file URL does not
    // always have a .m3u8 suffix, so accept extensionless values here.
    const assignedMediaRegex =
      /["']?(file|src|source|url|hls|manifest)["']?\s*[:=]\s*["']([^"']+)["']/gi;
    while ((match = assignedMediaRegex.exec(searchable)) !== null) {
      const key = match[1].toLowerCase();
      const candidate = match[2];
      const extensionless = /^(?:file|hls|manifest)$/i.test(key);
      if (
        /^(?:https?:|\/\/|\/)/i.test(candidate) &&
        (/\.(?:m3u8|mp4)(?:$|[?#])/i.test(candidate) || extensionless)
      ) {
        add(candidate, extensionless);
      }
    }

    return urls;
  }

  extractPlayerUrls(value, baseUrl) {
    const html = this.asText(value);
    const searchable = html.replace(/\\\//g, "/");
    const urls = [];
    const seen = new Set();
    const add = (candidate) => {
      const url = this.resolveUrl(this.normaliseUrl(candidate), baseUrl);
      if (
        !url ||
        seen.has(url) ||
        !/^https?:\/\//i.test(url) ||
        /\.(?:m3u8|mp4)(?:$|[?#])/i.test(url)
      ) {
        return;
      }
      seen.add(url);
      urls.push(url);
    };

    const tagRegex =
      /<(?:iframe|video|source)[^>]+(?:src|data-src|data-url|data-video)=["']([^"']+)["']/gi;
    let match;
    while ((match = tagRegex.exec(html)) !== null) add(match[1]);

    // Speedostream and similar hosts sometimes put the next player in a JS
    // string rather than in an iframe element.
    const linkRegex = /https?:\/\/[^"'<>\s]+/gi;
    while ((match = linkRegex.exec(searchable)) !== null) {
      const candidate = this.normaliseUrl(match[0]);
      if (/\.(?:html?|php)(?:$|[?#])/i.test(candidate)) add(candidate);
    }

    return urls;
  }

  mediaResult(url, referer) {
    const mediaUrl = this.normaliseUrl(url);
    // Speedostream's JWPlayer source is HLS even when its URL has no
    // extension. Treat unknown stream endpoints as HLS; explicit MP4 URLs
    // still use Miru's MP4 player.
    const isMp4 = /\.(?:mp4|webm)(?:$|[?#])/i.test(mediaUrl);
    return {
      type: isMp4 ? "mp4" : "hls",
      url: mediaUrl,
      headers: {
        "User-Agent": USER_AGENT,
        Referer: referer || SITE_URL,
      },
    };
  }

  resolveUrl(value, base = SITE_URL) {
    const url = this.normaliseUrl(value);
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith("//")) return `https:${url}`;

    const baseText = String(base || SITE_URL);
    const baseMatch = baseText.match(/^(https?:\/\/[^/]+)(\/.*)?$/i);
    const origin = baseMatch ? baseMatch[1] : SITE_URL;
    if (url.startsWith("/")) return `${origin}${url}`;

    const basePath = (baseMatch && baseMatch[2]) || "/";
    const directory = basePath.endsWith("/")
      ? basePath
      : basePath.replace(/[^/]*$/, "");
    return `${origin}${directory}${url}`;
  }

  normaliseUrl(value) {
    return this.decodeEntities(String(value || ""))
      .trim()
      .replace(/\\\//g, "/")
      .replace(/[),;]+$/g, "");
  }

  asText(value) {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value || "");
    } catch (_) {
      return String(value || "");
    }
  }

  cleanText(value) {
    return this.decodeEntities(String(value || ""))
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  decodeEntities(value) {
    return String(value || "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#x2F;|&#47;/gi, "/");
  }
}
