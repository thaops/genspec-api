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
   * Download a Cloudinary raw file using a signed URL (bypasses account-level access restrictions).
   */
  async downloadBuffer(cloudinaryUrl: string): Promise<Buffer> {
    // Extract public_id from URL: /.../raw/upload/v123/public/id.ext
    const match = cloudinaryUrl.match(/\/raw\/upload\/(?:v\d+\/)?(.+?)(?:\?.*)?$/);
    if (!match || !this.configured) {
      // Fallback: plain HTTP download
      return this.httpGet(cloudinaryUrl);
    }
    const publicId = decodeURIComponent(match[1]);
    const signedUrl = cloudinary.url(publicId, {
      resource_type: 'raw',
      type: 'upload',
      sign_url: true,
      secure: true,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    return this.httpGet(signedUrl);
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
  ): Promise<{ url: string; bytes: number }> {
    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          type: 'upload',
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

    // Force public access (overrides account-level raw restrictions)
    if (this.configured) {
      try {
        await cloudinary.uploader.explicit(result.public_id, {
          resource_type: 'raw',
          type: 'upload',
          access_mode: 'public',
        });
      } catch (e: any) {
        this.logger.warn(`Could not set public access on ${result.public_id}: ${e.message}`);
      }
    }

    return { url: result.secure_url, bytes: result.bytes };
  }
}
