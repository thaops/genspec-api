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
import { MaterialPrice, MaterialPriceSchema } from '../data-hub/prices/material-price.schema';
import { UnitPrice, UnitPriceSchema } from './unit-price.schema';
import { CatalogController } from './catalog.controller';
import { CatalogImportService } from './catalog-import.service';
import { CatalogService } from './catalog.service';
import { UnitPriceService } from './unit-price.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: NormItem.name, schema: NormItemSchema },
      { name: PriceSet.name, schema: PriceSetSchema },
      { name: PriceItem.name, schema: PriceItemSchema },
      { name: MaterialPrice.name, schema: MaterialPriceSchema },
      { name: UnitPrice.name, schema: UnitPriceSchema },
    ]),
  ],
  controllers: [CatalogController],
  providers: [CatalogService, CatalogImportService, UnitPriceService],
  exports: [CatalogService, UnitPriceService],
})
export class CatalogModule {}
