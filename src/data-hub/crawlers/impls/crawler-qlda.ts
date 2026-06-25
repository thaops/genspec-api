import { Injectable } from '@nestjs/common';
import { BaseCrawler } from '../base-crawler';
import { CrawlContext, CrawlResult } from '../crawler.interface';

/** QLDA GXD — gxd.vn (reference source) */
@Injectable()
export class CrawlerQLDA extends BaseCrawler {
  readonly key = 'CrawlerQLDA';

  async crawl(ctx: CrawlContext): Promise<CrawlResult> {
    const errors: string[] = [];
    const allLinks: Array<{ url: string; text: string }> = [];
    const pages = [
      'https://gxd.vn/dinh-muc-xay-dung',
      'https://gxd.vn/don-gia-xay-dung',
      'https://gxd.vn/van-ban-phap-luat-xay-dung',
    ];
    for (const page of pages) {
      try {
        const html = await this.fetchHtml(page);
        allLinks.push(...this.extractDocLinks(html, ctx.baseUrl ?? 'https://gxd.vn'));
      } catch (err) {
        errors.push(`${page}: ${(err as Error).message}`);
      }
    }
    const { files, errors: dlErrors } = await this.crawlLinks(allLinks, 30);
    return { files, errors: [...errors, ...dlErrors] };
  }
}
