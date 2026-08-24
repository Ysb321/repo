// ==MiruExtension==
// @name         YoMovies
// @version      v0.0.8
// @author       OshekharO
// @lang         hi
// @license      MIT
// @package      yomovies
// @type         bangumi
// @icon         https://dl.memuplay.com/new_market/img/com.wYoMovies_7822289.sc1.2024-05-21-17-59-43.jpg
// @webSite      https://yomovies.energy
// @nsfw         false
// ==/MiruExtension==

export default class extends Extension {

  async latest() {
    const res = await this.request("/");
    const bsxList = await this.querySelectorAll(res, "div.ml-item");
    const novel = [];

    for (const element of bsxList) {
      const html = await element.content;
  
      const url = await this.getAttributeText(html, "a", "href");
      const title = await this.querySelector(html, "div.qtip-title").text;
      const cover = await this
        .querySelector(html, "img")
        .getAttributeText("data-original");

      novel.push({
        title: title.trim(),
        url,
        cover,
      });
    }

    return novel;
  }

  async search(kw) {
    const res = await this.request(`/?s=${encodeURIComponent(kw)}`);
    const bsxList = await this.querySelectorAll(res, "div.ml-item");
    const novel = [];

    for (const element of bsxList) {
      const html = await element.content;

      const url = await this.getAttributeText(html, "a", "href");
      const title = await this.querySelector(html, "div.qtip-title").text;
      const cover = await this
        .querySelector(html, "img")
        .getAttributeText("data-original");

      novel.push({
        title: title.trim(),
        url,
        cover,
      });
    }

    return novel;
  }

  async detail(url) {
    const res = await this.request("", {
      headers: { "Miru-Url": url },
    });

    const titleElement = await this.querySelector(res, "meta[property='og:title']");
    const imageElement = await this.querySelector(res, "img[itemprop='image']");

    const descElement = await this.querySelector(res, "p.f-desc");
    
    const title = titleElement
      ? await titleElement.getAttributeText("content")
      : "";

    const cover = imageElement
      ? await imageElement.getAttributeText("src")
      : "";

    const desc = descElement
      ? await descElement.text
      : "";

    /*
     * Locate the player URL.
     */
    const episodeUrlMatch = res.match(/https:\/\/minoplres\.[^\s'"<>]+/i);
    const episodeUrl = episodeUrlMatch
      ? episodeUrlMatch[0]
      : "";

    return {
      title: title.trim(),
      cover,
      description: desc, // Renamed to follow consistent naming conventions
      episodes: [
        {
          title: "Directory",
          urls: [
            {
              name: title.trim(), 
              url: episodeUrl,
            },
          ],
        },
      ],
    };
  }

  async watch(url) {
    const res = await this.request("", {
      headers: { 
        "Miru-Url": url, 
        "Referer": "https://yomovies.energy/" 
      },
    });

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
          "Referer": "https://yomovies.energy/",
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
          "Referer": "https://yomovies.energy/",
        },
      };
    }

    throw new Error("No valid stream URL found.");
  }
}
