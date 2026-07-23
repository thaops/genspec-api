import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import * as https from 'https';
import * as http from 'http';

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);
  private configured = false;

  constructor(private readonly config: ConfigService) {
    const cloud_name = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    const api_key = this.config.get<string>('CLOUDINARY_API_KEY');
    const api_secret = this.config.get<string>('CLOUDINARY_API_SECRET');
    if (cloud_name && api_key && api_secret) {
      cloudinary.config({ cloud_name, api_key, api_secret });
      this.configured = true;
    } else {
      this.logger.warn('Cloudinary not fully configured — uploads will fail');
    }
  }

  /**
   * Download a Cloudinary raw file.
   * Uses private_download_url (api.cloudinary.com) to bypass CDN-level ACL deny rules.
   */
  async downloadBuffer(cloudinaryUrl: string): Promise<Buffer> {
    const match = cloudinaryUrl.match(/\/raw\/upload\/(?:v\d+\/)?(.+?)(?:\?.*)?$/);
    if (!match || !this.configured) {
      return this.httpGet(cloudinaryUrl);
    }
    const publicId = decodeURIComponent(match[1]);
    const ext = publicId.split('.').pop()?.split('?')[0] ?? 'pdf';
    // private_download_url goes through api.cloudinary.com (not CDN), bypasses ACL
    const privateUrl = (cloudinary.utils as any).private_download_url(publicId, ext, {
      resource_type: 'raw',
      type: 'upload',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    return this.httpGet(privateUrl);
  }

  private httpGet(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const chunks: Buffer[] = [];
      client.get(url, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        }
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  /**
   * Upload a raw file buffer. Returns the secure URL.
   * Explicitly marks the asset public after upload to bypass account-level restrictions.
   */
  async uploadBuffer(
    buffer: Buffer,
    options: { folder: string; fileName: string },
  ): Promise<{ url: string; publicId: string; bytes: number }> {
    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          type: 'upload',
          access_mode: 'public',
          folder: options.folder,
          public_id: options.fileName,
          use_filename: true,
          unique_filename: true,
          overwrite: false,
        },
        (error, res?: UploadApiResponse) => {
          if (error || !res) return reject(error ?? new Error('Cloudinary upload failed'));
          resolve(res);
        },
      );
      stream.end(buffer);
    });

    return { url: result.secure_url, publicId: result.public_id, bytes: result.bytes };
  }

  /** Generate a short-lived private download URL that bypasses CDN ACL rules. */
  privateDownloadUrl(publicId: string, ext = 'pdf', expiresInSeconds = 3600): string {
    return (cloudinary.utils as any).private_download_url(publicId, ext, {
      resource_type: 'raw',
      type: 'upload',
      expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
    });
  }

  /** Admin API usage stats (storage/bandwidth/credits) — for Admin Dashboard. */
  async usage(): Promise<{ storageBytes: number; bandwidthBytes: number; credits: number } | null> {
    if (!this.configured) return null;
    try {
      const res = await (cloudinary.api as any).usage();
      return {
        storageBytes: res.storage?.usage ?? 0,
        bandwidthBytes: res.bandwidth?.usage ?? 0,
        credits: res.credits?.usage ?? 0,
      };
    } catch (err) {
      this.logger.warn(`Cloudinary usage() failed: ${(err as Error).message}`);
      return null;
    }
  }
}
