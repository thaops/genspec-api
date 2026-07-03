import { Action, Confidence, TraceItem, ValidationReport, ProposalPreview } from './estimate.types';

export type StreamEvent =
  | { event: 'token'; data: { text: string } }
  | { event: 'thinking'; data: { text: string } }
  | { event: 'step'; data: { text: string } }
  | {
      event: 'proposal';
      data: {
        thinking: string[];
        message: string;
        confidence?: Confidence;
        actions: Action[];
        // type: 'government' | 'supplier' | ... — FE dùng để render badge nguồn chính thống
        sources: { title?: string; uri?: string; type?: string }[];
        preview: ProposalPreview;
        validation: ValidationReport;
        trace: TraceItem[];
        findings?: any[];
      };
    }
  | { event: 'error'; data: { message: string } };
