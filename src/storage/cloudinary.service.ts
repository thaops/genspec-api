import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';

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
   * Upload a raw file buffer (excel, zip). Returns the secure URL.
   */
  uploadBuffer(
    buffer: Buffer,
    options: { folder: string; fileName: string },
  ): Promise<{ url: string; bytes: number }> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          folder: options.folder,
          public_id: options.fileName,
          use_filename: true,
          unique_filename: true,
          overwrite: false,
        },
        (error, result?: UploadApiResponse) => {
          if (error || !result) {
            return reject(error ?? new Error('Cloudinary upload failed'));
          }
          resolve({ url: result.secure_url, bytes: result.bytes });
        },
      );
      stream.end(buffer);
    });
  }
}
