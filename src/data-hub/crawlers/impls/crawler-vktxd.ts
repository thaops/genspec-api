import { Injectable } from '@nestjs/common';
import { BaseCrawler } from '../base-crawler';
import { CrawlContext, CrawlResult } from '../crawler.interface';

/**
 * Viện Kinh tế Xây dựng — vktxd.vn
 * Crawls định mức, đơn giá xây dựng
 */
@Injectable()
export class CrawlerVKTXD extends BaseCrawler {
  readonly key = 'CrawlerVKTXD';

  private readonly PAGES = [
    'https://vktxd.vn/dinh-muc-xay-dung',
    'https://vktxd.vn/don-gia-xay-dung',
    'https://vktxd.vn/van-ban-phap-quy',
  ];

  async crawl(ctx: CrawlContext): Promise<CrawlResult> {
    const allLinks: Array<{ url: string; text: string }> = [];
    const errors: string[] = [];

    for (const page of this.PAGES) {
      try {
        const html = await this.fetchHtml(page);
        const links = this.extractDocLinks(html, ctx.baseUrl ?? 'https://vktxd.vn');
        allLinks.push(...links);
        this.logger.log(`VKTXD: found ${links.length} links on ${page}`);
      } catch (err) {
        errors.push(`${page}: ${(err as Error).message}`);
      }
    }

    const { files, errors: dlErrors } = await this.crawlLinks(allLinks, 30);
    return { files, errors: [...errors, ...dlErrors] };
  }
}
