import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CatalogImportService } from './catalog-import.service';
import { UnitPriceService } from './unit-price.service';

@UseGuards(JwtAuthGuard)
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly importer: CatalogImportService,
    private readonly unitPrices: UnitPriceService,
  ) {}

  /** Tra ĐƠN GIÁ CÔNG TÁC theo từ khóa tên/mã hiệu + tỉnh. Kết quả kèm nguồn (sourceDoc). */
  @Get('unit-price/search')
  searchUnitPrice(@Query('q') q?: string, @Query('province') province?: string, @Query('limit') limit?: string) {
    return this.unitPrices.search(q ?? '', province, limit ? Math.min(+limit || 20, 50) : 20);
  }

  /** Tra 1 đơn giá công tác theo mã hiệu (prefix) — dùng cho phân tích đơn giá. */
  @Get('unit-price/:code')
  unitPriceByCode(@Param('code') code: string, @Query('province') province?: string) {
    return this.unitPrices.byCode(code, province);
  }

  /** Tra GIÁ TÀI NGUYÊN (VL/NC/ca máy) trong material_prices — category: material|labor|equipment. */
  @Get('resource-price/search')
  searchResourcePrice(
    @Query('q') q?: string,
    @Query('province') province?: string,
    @Query('category') category?: string,
    @Query('limit') limit?: string,
  ) {
    return this.unitPrices.searchResources(q, province, category, limit ? +limit || 20 : 20);
  }

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
