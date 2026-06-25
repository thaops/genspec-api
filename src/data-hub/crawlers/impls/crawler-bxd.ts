import { Injectable } from '@nestjs/common';
import { BaseCrawler } from '../base-crawler';
import { CrawlContext, CrawlResult } from '../crawler.interface';

/**
 * Bộ Xây dựng — moc.gov.vn
 * Crawls the văn bản pháp quy section for Thông tư, Nghị định, Quyết định
 */
@Injectable()
export class CrawlerBXD extends BaseCrawler {
  readonly key = 'CrawlerBXD';

  private readonly PAGES = [
    'https://moc.gov.vn/vn/pages/vanbanphapquy.aspx?CateID=0',
    'https://moc.gov.vn/vn/pages/vanbanphapquy.aspx?CateID=2',  // Thông tư
    'https://moc.gov.vn/vn/pages/vanbanphapquy.aspx?CateID=3',  // Nghị định
  ];

  async crawl(ctx: CrawlContext): Promise<CrawlResult> {
    const allLinks: Array<{ url: string; text: string }> = [];
    const errors: string[] = [];

    for (const page of this.PAGES) {
      try {
        const html = await this.fetchHtml(page);
        const links = this.extractDocLinks(html, ctx.baseUrl ?? 'https://moc.gov.vn');
        allLinks.push(...links);
        this.logger.log(`BXD: found ${links.length} links on ${page}`);
      } catch (err) {
        errors.push(`${page}: ${(err as Error).message}`);
      }
    }

    const { files, errors: dlErrors } = await this.crawlLinks(allLinks, 30);
    return { files, errors: [...errors, ...dlErrors] };
  }
}
