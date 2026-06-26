import { Controller, Get, Param, Sse, MessageEvent } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Observable, interval, from, switchMap, map, takeWhile, startWith } from 'rxjs';
import { DRAWING_QUEUE, DrawingJobProgress } from './drawing.queue';

@Controller('jobs')
export class JobStatusController {
  constructor(@InjectQueue(DRAWING_QUEUE) private queue: Queue) {}

  /** REST poll: GET /jobs/:jobId */
  @Get(':jobId')
  async getJob(@Param('jobId') jobId: string) {
    const job = await this.queue.getJob(jobId);
    if (!job) return { status: 'not_found' };

    const state    = await job.getState();
    const progress = job.progress as DrawingJobProgress | number | undefined;

    return {
      jobId,
      state,
      progress: typeof progress === 'object' ? progress : { step: state, percent: 0 },
      failedReason: job.failedReason,
    };
  }

  /** SSE stream: GET /jobs/:jobId/stream — pushes updates until done/failed */
  @Sse(':jobId/stream')
  stream(@Param('jobId') jobId: string): Observable<MessageEvent> {
    return interval(1500).pipe(
      startWith(0),
      switchMap(() => from(this.getJob(jobId))),
      takeWhile(
        (data) => {
          const s = data.state as string;
          return s !== 'completed' && s !== 'failed' && s !== 'not_found';
        },
        true,
      ),
      map((data) => ({ data } as MessageEvent)),
    );
  }
}
