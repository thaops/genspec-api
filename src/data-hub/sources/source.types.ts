export type SourceType = 'official' | 'reference';
export type SourceStatus = 'active' | 'paused' | 'error';

export interface SourceDefinition {
  id: string;
  name: string;
  type: SourceType;
  priority: number;       // 0–100, higher = more trusted
  schedule: string;       // cron expression e.g. "0 2 * * *"
  status: SourceStatus;
  crawlerKey: string;     // maps to a registered ICrawler
  baseUrl?: string;
  metadata?: Record<string, string>;
}
