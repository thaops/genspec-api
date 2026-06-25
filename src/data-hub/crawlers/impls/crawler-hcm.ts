import { Injectable } from '@nestjs/common';
import { BaseCrawler } from '../base-crawler';
import { CrawlContext, CrawlResult } from '../crawler.interface';

/**
 * Sở Xây dựng TP.HCM — hochiminhcity.gov.vn
 * Crawls bảng giá vật liệu xây dựng, nhân công, ca máy
 */
@Injectable()
export class CrawlerHCM extends BaseCrawler {
  readonly key = 'CrawlerHCM';

  private readonly PAGES = [
    'https://sxd.hochiminhcity.gov.vn/vanban/Lists/VanBanPhapLuat/AllItems.aspx',
    'https://sxd.hochiminhcity.gov.vn/banggia',
  ];

  async crawl(ctx: CrawlContext): Promise<CrawlResult> {
    const allLinks: Array<{ url: string; text: string }> = [];
    const errors: string[] = [];

    for (const page of this.PAGES) {
      try {
        const html = await this.fetchHtml(page);
        const links = this.extractDocLinks(html, ctx.baseUrl ?? 'https://sxd.hochiminhcity.gov.vn');
        // HCM publishes price lists as Excel/PDF — filter for those
        const priceLinks = links.filter((l) =>
          l.text.toLowerCase().includes('giá') ||
          l.text.toLowerCase().includes('vat lieu') ||
          l.url.toLowerCase().includes('bang-gia'),
        );
        allLinks.push(...priceLinks);
        this.logger.log(`HCM: found ${priceLinks.length} price links on ${page}`);
      } catch (err) {
        errors.push(`${page}: ${(err as Error).message}`);
      }
    }

    const { files, errors: dlErrors } = await this.crawlLinks(allLinks, 20);
    // Tag all HCM files with province
    files.forEach((f) => { (f as any).province = 'HCM'; });
    return { files, errors: [...errors, ...dlErrors] };
  }
}
