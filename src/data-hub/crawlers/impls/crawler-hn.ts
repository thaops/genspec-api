import { Injectable } from '@nestjs/common';
import { BaseCrawler } from '../base-crawler';
import { CrawlContext, CrawlResult } from '../crawler.interface';

/**
 * Sở Xây dựng Hà Nội — sxd.hanoi.gov.vn
 */
@Injectable()
export class CrawlerHN extends BaseCrawler {
  readonly key = 'CrawlerHN';

  private readonly PAGES = [
    'https://sxd.hanoi.gov.vn/van-ban-phap-quy',
    'https://sxd.hanoi.gov.vn/gia-vat-lieu',
  ];

  async crawl(ctx: CrawlContext): Promise<CrawlResult> {
    const allLinks: Array<{ url: string; text: string }> = [];
    const errors: string[] = [];

    for (const page of this.PAGES) {
      try {
        const html = await this.fetchHtml(page);
        const links = this.extractDocLinks(html, ctx.baseUrl ?? 'https://sxd.hanoi.gov.vn');
        allLinks.push(...links);
        this.logger.log(`HN: found ${links.length} links on ${page}`);
      } catch (err) {
        errors.push(`${page}: ${(err as Error).message}`);
      }
    }

    const { files, errors: dlErrors } = await this.crawlLinks(allLinks, 20);
    files.forEach((f) => { (f as any).province = 'HN'; });
    return { files, errors: [...errors, ...dlErrors] };
  }
}
