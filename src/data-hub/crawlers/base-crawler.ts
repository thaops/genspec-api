import { Logger } from '@nestjs/common';
import { ICrawler, CrawlContext, CrawlResult, CrawledFile } from './crawler.interface';

const USER_AGENT = 'Mozilla/5.0 (compatible; GenSpec-Bot/1.0; +https://genspec.dev)';
const DEFAULT_TIMEOUT = 30_000;

export abstract class BaseCrawler implements ICrawler {
  abstract readonly key: string;
  protected readonly logger = new Logger(this.constructor.name);

  abstract crawl(ctx: CrawlContext): Promise<CrawlResult>;

  protected async fetchHtml(url: string): Promise<string> {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.text();
  }

  protected async fetchBuffer(url: string): Promise<Buffer> {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }

  /** Extract all absolute PDF/Excel links from an HTML page */
  protected extractDocLinks(html: string, baseUrl: string): Array<{ url: string; text: string }> {
    const links: Array<{ url: string; text: string }> = [];
    const anchorRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(html)) !== null) {
      const href = m[1].trim();
      const text = m[2].replace(/<[^>]+>/g, '').trim();
      if (!this.isDocLink(href)) continue;
      const abs = this.toAbsoluteUrl(href, baseUrl);
      if (abs) links.push({ url: abs, text });
    }
    return links;
  }

  private isDocLink(href: string): boolean {
    return /\.(pdf|xlsx?|docx?|zip)(\?.*)?$/i.test(href);
  }

  protected toAbsoluteUrl(href: string, base: string): string | null {
    try {
      return new URL(href, base).toString();
    } catch {
      return null;
    }
  }

  protected mimeFromUrl(url: string): string {
    const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      pdf: 'application/pdf',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls: 'application/vnd.ms-excel',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      zip: 'application/zip',
    };
    return map[ext] ?? 'application/octet-stream';
  }

  protected filenameFromUrl(url: string): string {
    return decodeURIComponent(url.split('?')[0].split('/').pop() ?? 'file');
  }

  protected detectDocumentType(filename: string, linkText: string): CrawledFile['documentType'] {
    const s = (filename + ' ' + linkText).toLowerCase();
    if (s.includes('thông tư') || s.includes('thong tu')) return 'thong_tu';
    if (s.includes('nghị định') || s.includes('nghi dinh')) return 'nghi_dinh';
    if (s.includes('quyết định') || s.includes('quyet dinh')) return 'quyet_dinh';
    if (s.includes('qcvn')) return 'qcvn';
    if (s.includes('tcvn')) return 'tcvn';
    if (s.includes('bảng giá') || s.includes('bang gia') || s.includes('don gia') || s.includes('đơn giá')) return 'bang_gia';
    if (s.includes('định mức') || s.includes('dinh muc')) return 'dinh_muc';
    return 'other';
  }

  protected async crawlLinks(
    links: Array<{ url: string; text: string }>,
    maxFiles = 50,
  ): Promise<{ files: CrawledFile[]; errors: string[] }> {
    const files: CrawledFile[] = [];
    const errors: string[] = [];
    for (const link of links.slice(0, maxFiles)) {
      try {
        const buffer = await this.fetchBuffer(link.url);
        const filename = this.filenameFromUrl(link.url);
        files.push({
          filename,
          url: link.url,
          mimeType: this.mimeFromUrl(link.url),
          sizeBytes: buffer.length,
          buffer,
          detectedAt: new Date(),
          documentType: this.detectDocumentType(filename, link.text),
        });
        this.logger.debug(`Downloaded: ${filename} (${buffer.length} bytes)`);
      } catch (err) {
        errors.push(`${link.url}: ${(err as Error).message}`);
      }
    }
    return { files, errors };
  }
}
