import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  NormItem,
  NormItemSchema,
  PriceItem,
  PriceItemSchema,
  PriceSet,
  PriceSetSchema,
} from './catalog-db.schemas';
import { CatalogController } from './catalog.controller';
import { CatalogImportService } from './catalog-import.service';
import { CatalogService } from './catalog.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: NormItem.name, schema: NormItemSchema },
      { name: PriceSet.name, schema: PriceSetSchema },
      { name: PriceItem.name, schema: PriceItemSchema },
    ]),
  ],
  controllers: [CatalogController],
  providers: [CatalogService, CatalogImportService],
  exports: [CatalogService],
})
export class CatalogModule {}
