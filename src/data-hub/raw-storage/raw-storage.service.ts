import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

export interface RawFileSaveInput {
  sourceId: string;
  filename: string;
  buffer: Buffer;
  mimeType: string;
  url: string;
  documentType?: string;
}

export interface RawFileRef {
  storagePath: string;
  sourceId: string;
  filename: string;
  mimeType: string;
  url: string;
  sizeBytes: number;
  savedAt: Date;
  documentType?: string;
}

/**
 * Saves raw downloaded files to local disk (dev) or S3 (prod).
 * Layout: {root}/{YYYY}/{MM}/{sourceId}/{filename}
 */
@Injectable()
export class RawStorageService {
  private readonly logger = new Logger(RawStorageService.name);
  private readonly rootDir: string;

  constructor(private readonly config: ConfigService) {
    this.rootDir = config.get<string>('RAW_STORAGE_DIR') ?? path.join(process.cwd(), 'storage', 'raw');
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  async save(input: RawFileSaveInput): Promise<RawFileRef> {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');

    const dir = path.join(this.rootDir, yyyy, mm, input.sourceId);
    fs.mkdirSync(dir, { recursive: true });

    const dest = path.join(dir, input.filename);
    fs.writeFileSync(dest, input.buffer);

    this.logger.debug(`Saved raw file: ${dest} (${input.buffer.length} bytes)`);

    return {
      storagePath: dest,
      sourceId: input.sourceId,
      filename: input.filename,
      mimeType: input.mimeType,
      url: input.url,
      sizeBytes: input.buffer.length,
      savedAt: now,
      documentType: input.documentType,
    };
  }

  async exists(sourceId: string, filename: string): Promise<boolean> {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dest = path.join(this.rootDir, yyyy, mm, sourceId, filename);
    return fs.existsSync(dest);
  }
}
