import { Injectable } from '@nestjs/common';

/**
 * Proposal Engine — assembles structured proposals from agent output.
 *
 * Hierarchy:
 *   ProposalSet  1 — one per AgentRun
 *     ProposalItem[]  N — one per change (upsert_takeoff, update_cells, etc.)
 *
 * The engine validates, deduplicates, and orders items before returning a set.
 * Consumers (AgentConsole, ActionDispatcher) only ever receive a ProposalSet.
 */

export type ProposalItemType =
  | 'upsert_takeoff'
  | 'delete_takeoff'
  | 'update_cells'
  | 'upsert_material'
  | 'update_price'
  | 'set_project_info';

export interface ProposalItem {
  id: string;
  type: ProposalItemType;
  // Human-readable change description for preview
  label: string;
  detail?: string;
  // Before/after for diff display
  before?: Record<string, unknown>;
  after: Record<string, unknown>;
  // Source context (which drawing object / sheet cell triggered this)
  sourceDrawingId?: string;
  sourceObjectId?: string;   // stableId
  sourceSheetId?: string;
  sourceCellRef?: string;
  // Confidence 0-1 (from AI or rule-based)
  confidence: number;
  // Whether user must explicitly confirm this item
  requiresConfirmation: boolean;
}

export interface ProposalSet {
  id: string;
  agentRunId: string;
  estimateId: string;
  action: string;         // AgentActionType
  summary: string;        // AI-generated summary
  items: ProposalItem[];
  // Aggregate cost impact
  costBefore?: number;
  costAfter?: number;
  costDelta?: number;
  // Status lifecycle
  status: 'pending' | 'partially_applied' | 'applied' | 'discarded';
  appliedItemIds: string[];
  createdAt: string;
}

@Injectable()
export class ProposalEngineService {
  /**
   * Build a ProposalSet from raw AI action array + context.
   * Called by ActionDispatcherService after AI stream completes.
   */
  build(params: {
    agentRunId: string;
    estimateId: string;
    action: string;
    summary: string;
    rawItems: Omit<ProposalItem, 'id'>[];
    costBefore?: number;
    costAfter?: number;
  }): ProposalSet {
    const items = this.dedup(
      params.rawItems.map((item, i) => ({ ...item, id: `item-${i}-${Date.now()}` }))
    );

    return {
      id: `pset-${Date.now()}`,
      agentRunId: params.agentRunId,
      estimateId: params.estimateId,
      action: params.action,
      summary: params.summary,
      items,
      costBefore: params.costBefore,
      costAfter: params.costAfter,
      costDelta:
        params.costBefore != null && params.costAfter != null
          ? params.costAfter - params.costBefore
          : undefined,
      status: 'pending',
      appliedItemIds: [],
      createdAt: new Date().toISOString(),
    };
  }

  /** Mark specific items as applied (partial confirmation flow) */
  applyItems(set: ProposalSet, itemIds: string[]): ProposalSet {
    const appliedItemIds = Array.from(
      new Set([...set.appliedItemIds, ...itemIds])
    );
    const allApplied = appliedItemIds.length === set.items.length;
    return {
      ...set,
      appliedItemIds,
      status: allApplied ? 'applied' : 'partially_applied',
    };
  }

  discard(set: ProposalSet): ProposalSet {
    return { ...set, status: 'discarded' };
  }

  /** Remove duplicate items by (type + sourceObjectId + after-key fingerprint) */
  private dedup(items: ProposalItem[]): ProposalItem[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = `${item.type}|${item.sourceObjectId ?? ''}|${JSON.stringify(item.after)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
