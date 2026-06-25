import { Injectable } from '@nestjs/common';
import { BaseCrawler } from '../base-crawler';
import { CrawlContext, CrawlResult } from '../crawler.interface';

/** Sở Xây dựng Bình Dương */
@Injectable()
export class CrawlerBinhDuong extends BaseCrawler {
  readonly key = 'CrawlerBinhDuong';

  async crawl(ctx: CrawlContext): Promise<CrawlResult> {
    const errors: string[] = [];
    const allLinks: Array<{ url: string; text: string }> = [];
    const pages = [
      'https://sxd.binhduong.gov.vn/van-ban',
      'https://sxd.binhduong.gov.vn/gia-vat-lieu-xay-dung',
    ];
    for (const page of pages) {
      try {
        const html = await this.fetchHtml(page);
        allLinks.push(...this.extractDocLinks(html, 'https://sxd.binhduong.gov.vn'));
      } catch (err) {
        errors.push(`${page}: ${(err as Error).message}`);
      }
    }
    const { files, errors: dlErrors } = await this.crawlLinks(allLinks, 20);
    files.forEach((f) => { (f as any).province = 'BD'; });
    return { files, errors: [...errors, ...dlErrors] };
  }
}
