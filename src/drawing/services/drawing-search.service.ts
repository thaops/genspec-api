import { Injectable } from '@nestjs/common';
import { DrawingIndexerService } from './drawing-indexer.service';

@Injectable()
export class DrawingSearchService {
  constructor(private readonly indexer: DrawingIndexerService) {}

  search(drawingId: string, query: string) {
    return this.indexer.search(drawingId, query ?? '');
  }
}
