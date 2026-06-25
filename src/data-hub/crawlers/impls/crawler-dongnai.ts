import { Injectable } from '@nestjs/common';
import { BaseCrawler } from '../base-crawler';
import { CrawlContext, CrawlResult } from '../crawler.interface';

/** Sở Xây dựng Đồng Nai */
@Injectable()
export class CrawlerDongNai extends BaseCrawler {
  readonly key = 'CrawlerDongNai';

  async crawl(ctx: CrawlContext): Promise<CrawlResult> {
    const errors: string[] = [];
    const allLinks: Array<{ url: string; text: string }> = [];
    const pages = [
      'https://sxd.dongnai.gov.vn/Pages/VanBan.aspx',
      'https://sxd.dongnai.gov.vn/Pages/GiaVatLieu.aspx',
    ];
    for (const page of pages) {
      try {
        const html = await this.fetchHtml(page);
        allLinks.push(...this.extractDocLinks(html, 'https://sxd.dongnai.gov.vn'));
      } catch (err) {
        errors.push(`${page}: ${(err as Error).message}`);
      }
    }
    const { files, errors: dlErrors } = await this.crawlLinks(allLinks, 20);
    files.forEach((f) => { (f as any).province = 'DN'; });
    return { files, errors: [...errors, ...dlErrors] };
  }
}
