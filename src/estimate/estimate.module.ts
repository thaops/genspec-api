import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AiModule } from '../ai/ai.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CopilotService } from './copilot.service';
import { EstimateController } from './estimate.controller';
import { Estimate, EstimateSchema } from './estimate.schema';
import { EstimateService } from './estimate.service';
import { ExportF1Service } from './export-f1.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Estimate.name, schema: EstimateSchema }]),
    AiModule,
    CatalogModule,
  ],
  controllers: [EstimateController],
  providers: [EstimateService, CopilotService, ExportF1Service],
  exports: [EstimateService],
})
export class EstimateModule {}
