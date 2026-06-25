export interface CrawlContext {
  sourceId: string;
  crawlerKey: string;
  baseUrl?: string;
  jobId: string;
}

export interface CrawlResult {
  files: CrawledFile[];
  errors: string[];
}

export interface CrawledFile {
  filename: string;
  url: string;
  mimeType: string;
  sizeBytes?: number;
  buffer?: Buffer;
  detectedAt: Date;
  documentType?: 'thong_tu' | 'nghi_dinh' | 'quyet_dinh' | 'qcvn' | 'tcvn' | 'bang_gia' | 'dinh_muc' | 'other';
}

/** Every crawler must implement this interface */
export interface ICrawler {
  readonly key: string;
  crawl(ctx: CrawlContext): Promise<CrawlResult>;
}
