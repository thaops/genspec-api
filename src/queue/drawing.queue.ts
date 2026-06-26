export const DRAWING_QUEUE = 'drawing';

export type DrawingJobStep =
  | 'queued'
  | 'downloading'
  | 'converting'
  | 'parsing'
  | 'detecting'
  | 'indexing'
  | 'graph'
  | 'ready'
  | 'failed';

export interface DrawingJobData {
  drawingId: string;
  estimateId: string;
  fileType: 'pdf' | 'dwg' | 'dxf' | 'image';
  storageUrl: string;   // Cloudinary URL — worker downloads from here
  tmpPath?: string;     // local tmp path if still available
}

export interface DrawingJobProgress {
  step: DrawingJobStep;
  message: string;
  percent: number;
}
