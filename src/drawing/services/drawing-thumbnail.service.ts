import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Drawing, DrawingDocument } from '../schemas/drawing.schema';

/**
 * Lưu thumbnail bản vẽ (data-URI PNG/JPEG do FE render từ scene). Không raster
 * phía server (không có node-canvas/sharp) — FE vẽ scene ra canvas nhỏ rồi gửi lên.
 * Read-side (estimate.list → card home) đã nối sẵn field Drawing.thumbnail.
 */
@Injectable()
export class DrawingThumbnailService {
  private readonly logger = new Logger(DrawingThumbnailService.name);

  constructor(@InjectModel(Drawing.name) private readonly drawingModel: Model<DrawingDocument>) {}

  async save(estimateId: string, drawingId: string, dataUrl: string) {
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg);base64,/.test(dataUrl)) {
      throw new BadRequestException('dataUrl không hợp lệ (cần data:image/png|jpeg;base64,…)');
    }
    // Chặn phình document: thumbnail phải nhỏ (~<200KB base64). list() có projection
    // thumbnail nên ảnh lớn sẽ nặng feed home.
    if (dataUrl.length > 200_000) {
      throw new BadRequestException('Thumbnail quá lớn — giảm kích thước/chất lượng ở FE');
    }
    const res = await this.drawingModel
      .updateOne({ _id: drawingId, estimateId }, { $set: { thumbnail: dataUrl } })
      .catch((e) => {
        this.logger.warn(`save thumbnail failed: ${(e as Error).message}`);
        throw new BadRequestException('drawingId không hợp lệ');
      });
    if (res.matchedCount === 0) throw new NotFoundException('Không tìm thấy bản vẽ');
    return { ok: true };
  }
}
