// ==MiruExtension==
// @name         HDGHaRTV
// @version      v0.1.0
// @author       OshekharO
// @lang         en
// @license      MIT
// @package      hdghartv
// @type         bangumi
// @icon         https://example.com/icon.png  // Update with actual icon URL
// @webSite      https://hdghartv.cc/
// @nsfw        false
// ==/MiruExtension==

export default class extends Extension {

  async latest() {
    const res = await this.request("/");
    
    const bsxList = await this.querySelectorAll(res, "div.media");
    const novel = [];

    for (const element of bsxList) {
      const html = await element.content;

      const url = await this.getAttributeText(html, ".post-title a", "href");
      const title = await this.querySelector(html, ".post-title").text;
      const cover = await this
        .querySelector(html, "img.lazyload")
        .getAttributeText("data-src");

      novel.push({
        title: title.trim(),
        url,
        cover: cover ?? "",
      });
    }

    return novel.slice(0, 15); // Limiting to top 15 for performance sake
  }

  async search(kw) {
    const res = await this.request(`/search/${encodeURIComponent(kw)}`);
    
    const bsxList = await this.querySelectorAll(res, "div.media");
    const novel = [];

    for (const element of bsxList) {
      const html = await element.content;

      const url = await this.getAttributeText(html, ".post-title a", "href");
      const title = await this.querySelector(html, ".post-title").text;
      const cover = await this
        .querySelector(html, "img.lazyload")
        .getAttributeText("data-src");

      novel.push({
        title: title.trim(),
        url,
        cover: cover ?? "",
      });
    }

    return novel.slice(0, 15); // Limiting to top 15 for performance sake
  }
  
  async detail(url) {
    const res = await this.request("", { headers: { "Miru-Url": url } });

    const titleElement = await this.querySelector(res, 'meta[property="og:title"]');
    const imageElement = await this.querySelector(res, 'img[itemprop="image"]');

    const title = titleElement ? await titleElement.getAttributeText("content") : "";
    const cover = imageElement ? await imageElement.getAttributeText("src") : "";

    let description = '';
    try {
      const descElement = await this.querySelector(res, "div.srpg");
      if (descElement) description = await descElement.text;
    } catch {}

    // Player URL extraction
    let playerUrl;

    const iframeRegex = /<iframe[^>]+src=["']([^"']+)["']/gi;
    let match = null;
    while ((match = iframeRegex.exec(res)) !== null) {
      if (playerUrl === undefined && !match[1].includes("youtube")) {
        playerUrl = match[1];
      }
    }

    return {
      title: title.trim(),
      cover,
      desc: description, // Renamed for consistency
      episodes: [
        { 
          title: "Server",
          urls: [{ name: title.trim(), url: playerUrl }]
        },
      ],
    };
  }

  async watch(url) {
    const res = await this.request("", { headers: { "Miru-Url": url } });

    /*
     * Find HLS .m3u8 URL.
     */
    const hlsMatch = /https:\/\/[^\"'\s]+\.m3u8(?:\?[^\s"<>]*)?/i;
    const hlsStreamUrl = res.match(hlsMatch);
    
    if (hlsStreamUrl) {
      return {
        type: "hls",
        url: hlsStreamUrl[0],
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.142.86 Safari/537.36",
          "Referer": "https://hdghartv.cc/",
        },
      };
    }

    /*
     * Direct link to stream.
     */
    if (url.match(hlsMatch)) {
      return {
        type: "hls",
        url,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.142.86 Safari/537.36",
        },
      };
    }

    /*
     * MP4 fallback.
     */
    const mp4Match = /https:\/\/[^\"'\s]+\.mp4(?:\?[^\s"<>]*)?/i;
    const mp4StreamUrl = res.match(mp4Match);

    if (mp4StreamUrl) {
      return {
        type: "mp4",
        url: mp4StreamUrl[0],
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.142.86 Safari/537.36",
        },
      };
    }

    throw new Error("No valid stream URL found.");
  }
}
