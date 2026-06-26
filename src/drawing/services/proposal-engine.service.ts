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
  label: string;
  detail?: string;
  before?: Record<string, unknown>;
  after: Record<string, unknown>;
  // Source context
  sourceDrawingId?: string;
  sourceObjectId?: string;    // stableId
  sourceSheetId?: string;
  sourceCellRef?: string;
  confidence: number;
  requiresConfirmation: boolean;
  /**
   * Other item ids that must be applied before/alongside this one.
   * Example: a beam takeoff item depends on its supporting column item.
   * UI applies all dependencies automatically when user confirms this item.
   */
  dependencies?: string[];
  /**
   * Order hint — lower = applied first when resolving dependency chain.
   * Set by ProposalEngineService.build() via topological sort.
   */
  applyOrder?: number;
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
    const itemsWithId = params.rawItems.map((item, i) => ({
      ...item,
      id: `item-${i}-${Date.now()}`,
    }));
    const deduped = this.dedup(itemsWithId);
    const items = this.topoSort(deduped);

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

  /** Topological sort by dependencies — sets applyOrder */
  private topoSort(items: ProposalItem[]): ProposalItem[] {
    const byId = new Map(items.map((it) => [it.id, it]));
    const order: string[] = [];
    const visited = new Set<string>();

    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const item = byId.get(id);
      for (const depId of item?.dependencies ?? []) visit(depId);
      order.push(id);
    };
    for (const item of items) visit(item.id);

    return order.map((id, idx) => ({
      ...byId.get(id)!,
      applyOrder: idx,
    }));
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
