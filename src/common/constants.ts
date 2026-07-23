export const COLLECTIONS = {
  users: 'users',
  projects: 'projects',
  generations: 'generations',
  schemas: 'schemas',
  exports: 'exports',
  estimates: 'estimates',
  aiUsage: 'ai_usage',
  auditLogs: 'audit_logs',
} as const;

export type ProjectStatus =
  | 'uploaded'
  | 'parsing'
  | 'ai_analyzing'
  | 'schema_generated'
  | 'waiting_review'
  | 'generating'
  | 'zipping'
  | 'completed'
  | 'failed';

export type GenerationMode = 'quick' | 'standard' | 'strict';

export const STEP_PROGRESS: Record<string, number> = {
  uploaded: 0,
  parsing: 15,
  ai_analyzing: 40,
  schema_generated: 60,
  waiting_review: 60,
  generating: 80,
  zipping: 95,
  completed: 100,
  failed: 100,
};
