/**
 * Domain Events — decouples Drawing modules via NestJS EventEmitter.
 *
 * Flow (example):
 *   DrawingUploadService → emits DrawingUploadedEvent
 *   ├── DrawingParserService   listens → parse pages/layers/index
 *   ├── ThumbnailService       listens → generate thumbnail
 *   ├── NotificationService   listens → notify user
 *   └── DrawingHistoryService  listens → log "Uploaded"
 *
 * No controller calls services directly. Sequence is determined by listeners.
 *
 * Register in app.module.ts:
 *   EventEmitterModule.forRoot({ wildcard: false, delimiter: '.' })
 */

// ---------- Drawing Domain Events ----------

export class DrawingUploadedEvent {
  static readonly EVENT = 'drawing.uploaded';
  constructor(
    public readonly drawingId: string,
    public readonly estimateId: string,
    public readonly fileType: 'pdf' | 'dwg' | 'dxf' | 'image',
    public readonly storagePath: string,
    public readonly uploadedBy: string,
  ) {}
}

export class DrawingConvertedEvent {
  static readonly EVENT = 'drawing.converted';
  constructor(
    public readonly drawingId: string,
    public readonly dxfPath: string,   // output from DWG→DXF converter
  ) {}
}

export class DrawingParsedEvent {
  static readonly EVENT = 'drawing.parsed';
  constructor(
    public readonly drawingId: string,
    public readonly pageCount: number,
    public readonly layerCount: number,
    public readonly indexEntryCount: number,
  ) {}
}

export class DrawingThumbnailReadyEvent {
  static readonly EVENT = 'drawing.thumbnail.ready';
  constructor(
    public readonly drawingId: string,
    public readonly thumbnailUrl: string,
  ) {}
}

export class DrawingDetectedEvent {
  static readonly EVENT = 'drawing.detected';
  constructor(
    public readonly drawingId: string,
    public readonly estimateId: string,
    public readonly objectCount: number,
  ) {}
}

export class DrawingGraphBuiltEvent {
  static readonly EVENT = 'drawing.graph.built';
  constructor(
    public readonly drawingId: string,
    public readonly nodeCount: number,
    public readonly edgeCount: number,
  ) {}
}

export class DrawingRevisionUploadedEvent {
  static readonly EVENT = 'drawing.revision.uploaded';
  constructor(
    public readonly drawingId: string,
    public readonly estimateId: string,
    public readonly revisionId: string,
    public readonly version: number,
  ) {}
}

export class DrawingComparedEvent {
  static readonly EVENT = 'drawing.compared';
  constructor(
    public readonly drawingId: string,
    public readonly estimateId: string,
    public readonly addedCount: number,
    public readonly removedCount: number,
    public readonly changedCount: number,
  ) {}
}

// ---------- Agent Domain Events ----------

export class AgentRunStartedEvent {
  static readonly EVENT = 'agent.run.started';
  constructor(
    public readonly agentRunId: string,
    public readonly estimateId: string,
    public readonly action: string,
  ) {}
}

export class AgentRunCompletedEvent {
  static readonly EVENT = 'agent.run.completed';
  constructor(
    public readonly agentRunId: string,
    public readonly estimateId: string,
    public readonly action: string,
    public readonly durationMs: number,
    public readonly tokensUsed: number,
  ) {}
}

export class AgentRunFailedEvent {
  static readonly EVENT = 'agent.run.failed';
  constructor(
    public readonly agentRunId: string,
    public readonly estimateId: string,
    public readonly error: string,
  ) {}
}

// ---------- Job Domain Events ----------

export class JobCompletedEvent {
  static readonly EVENT = 'job.completed';
  constructor(
    public readonly jobId: string,
    public readonly type: string,
    public readonly estimateId: string | undefined,
    public readonly durationMs: number,
  ) {}
}

export class JobFailedEvent {
  static readonly EVENT = 'job.failed';
  constructor(
    public readonly jobId: string,
    public readonly type: string,
    public readonly estimateId: string | undefined,
    public readonly error: string,
    public readonly canRetry: boolean,
  ) {}
}
