import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CatalogImportService } from './catalog-import.service';

@UseGuards(JwtAuthGuard)
@Controller('catalog')
export class CatalogController {
  constructor(private readonly importer: CatalogImportService) {}

  /** Import file Excel định mức (vd TT12/2021). ?dryRun=true → preview mapping 100 dòng đầu. */
  @Post('import-norms')
  @UseInterceptors(FileInterceptor('file'))
  importNorms(
    @UploadedFile() file: Express.Multer.File,
    @Query('dryRun') dryRun?: string,
    @Body('sourceDoc') sourceDoc?: string,
  ) {
    if (!file?.buffer) throw new BadRequestException('Thiếu file Excel (field "file")');
    return this.importer.importNorms(file.buffer, sourceDoc ?? 'TT12/2021', dryRun === 'true');
  }

  /**
   * Import công bố giá tỉnh. Body: province, effectiveDate (ISO), sourceDoc.
   * ?dryRun=true → preview. Trùng (province, effectiveDate) → 409 {conflict, existing};
   * ?overwrite=true (hoặc body overwrite) mới thực sự replace.
   */
  @Post('import-prices')
  @UseInterceptors(FileInterceptor('file'))
  importPrices(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { province: string; effectiveDate: string; sourceDoc?: string; overwrite?: string | boolean },
    @Query('dryRun') dryRun?: string,
    @Query('overwrite') overwrite?: string,
  ) {
    if (!file?.buffer) throw new BadRequestException('Thiếu file Excel (field "file")');
    const doOverwrite = overwrite === 'true' || body.overwrite === true || body.overwrite === 'true';
    return this.importer.importPrices(file.buffer, body, dryRun === 'true', doOverwrite);
  }
}
