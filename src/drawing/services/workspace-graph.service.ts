import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { DrawingGraphBuiltEvent } from '../../events/domain-events';

/**
 * Workspace Graph — unified graph connecting ALL domain entities.
 *
 * Nodes: estimate, sheet, takeoff, boq, material, drawing, object, spec, price, revision
 * Edges: has_sheet, has_drawing, references_boq, priced_by, specified_by, supported_by, ...
 *
 * Built incrementally:
 *   - DrawingGraphBuiltEvent  → add drawing nodes + structural edges
 *   - (Future) ProposalApplied → add/update takeoff/boq edges
 *   - (Future) PriceUpdated    → update priced_by edges
 *
 * AI reads this graph to answer cross-domain questions:
 *   "Which takeoff items reference objects that changed in Rev B?"
 *   "What is the total cost impact of beams on floor 3?"
 */

export type NodeType =
  | 'estimate' | 'sheet' | 'takeoff_item' | 'boq_row'
  | 'material' | 'drawing' | 'drawing_object'
  | 'specification' | 'price_source' | 'revision';

export type EdgeType =
  | 'has_sheet' | 'has_drawing' | 'has_takeoff'
  | 'references_boq' | 'priced_by' | 'specified_by'
  | 'supported_by' | 'revised_from' | 'sourced_from';

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  estimateId: string;
  properties?: Record<string, unknown>;
  updatedAt: string;
}

export interface GraphEdge {
  fromId: string;
  toId: string;
  type: EdgeType;
  weight?: number;
  updatedAt: string;
}

// In-memory store per estimateId — swap for MongoDB/Redis in production
const graphStore = new Map<string, { nodes: Map<string, GraphNode>; edges: GraphEdge[] }>();

@Injectable()
export class WorkspaceGraphService {
  private readonly logger = new Logger(WorkspaceGraphService.name);

  @OnEvent(DrawingGraphBuiltEvent.EVENT)
  async onGraphBuilt(event: DrawingGraphBuiltEvent) {
    this.logger.log(`WorkspaceGraph: merging drawing graph ${event.drawingId}`);
    // Drawing structural edges are already in DrawingRelationship collection.
    // Here we register that the drawing node exists in the workspace graph.
    // Full merge (object → takeoff edges) will happen when proposal is applied.
  }

  getGraph(estimateId: string) {
    const store = graphStore.get(estimateId);
    if (!store) return { estimateId, nodes: [], edges: [] };
    return {
      estimateId,
      nodes: Array.from(store.nodes.values()),
      edges: store.edges,
    };
  }

  upsertNode(node: Omit<GraphNode, 'updatedAt'>) {
    this.ensureStore(node.estimateId);
    const store = graphStore.get(node.estimateId)!;
    store.nodes.set(node.id, { ...node, updatedAt: new Date().toISOString() });
  }

  addEdge(estimateId: string, edge: Omit<GraphEdge, 'updatedAt'>) {
    this.ensureStore(estimateId);
    const store = graphStore.get(estimateId)!;
    // Dedup by fromId+toId+type
    const exists = store.edges.some(
      (e) => e.fromId === edge.fromId && e.toId === edge.toId && e.type === edge.type,
    );
    if (!exists) store.edges.push({ ...edge, updatedAt: new Date().toISOString() });
  }

  // ---------- Query API ----------

  findByStableId(estimateId: string, stableId: string): GraphNode | undefined {
    return graphStore.get(estimateId)?.nodes.get(stableId);
  }

  findByType(estimateId: string, type: NodeType): GraphNode[] {
    const store = graphStore.get(estimateId);
    if (!store) return [];
    return Array.from(store.nodes.values()).filter((n) => n.type === type);
  }

  findRelated(
    estimateId: string,
    nodeId: string,
    edgeType?: EdgeType,
  ): GraphNode[] {
    const store = graphStore.get(estimateId);
    if (!store) return [];

    const edges = store.edges.filter(
      (e) =>
        (e.fromId === nodeId || e.toId === nodeId) &&
        (!edgeType || e.type === edgeType),
    );
    const relatedIds = edges.map((e) => (e.fromId === nodeId ? e.toId : e.fromId));
    return relatedIds
      .map((id) => store.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /** Find all drawing objects linked to a BOQ row */
  findObjectsByBoqRef(estimateId: string, boqRef: string): GraphNode[] {
    return this.findByType(estimateId, 'drawing_object').filter(
      (n) => n.properties?.['boqRef'] === boqRef,
    );
  }

  /** Find all BOQ rows impacted by a drawing revision */
  findBoqImpactedByRevision(estimateId: string, revisionId: string): GraphNode[] {
    const revNode = this.findByStableId(estimateId, revisionId);
    if (!revNode) return [];
    // Traverse: revision → drawing_object → boq_row
    const objects = this.findRelated(estimateId, revisionId, 'revised_from');
    return objects.flatMap((obj) =>
      this.findRelated(estimateId, obj.id, 'references_boq'),
    );
  }

  /** Find all nodes reachable from a starting node (BFS, max depth) */
  traverse(estimateId: string, fromId: string, maxDepth = 3): GraphNode[] {
    const store = graphStore.get(estimateId);
    if (!store) return [];

    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: fromId, depth: 0 }];
    const result: GraphNode[] = [];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);

      const node = store.nodes.get(id);
      if (node) result.push(node);

      for (const edge of store.edges) {
        if (edge.fromId === id && !visited.has(edge.toId)) {
          queue.push({ id: edge.toId, depth: depth + 1 });
        }
      }
    }
    return result;
  }

  /** Build AI context snippet for a node — used by ActionDispatcher to inject into prompts */
  buildContextSnippet(estimateId: string, nodeId: string): string {
    const neighbors = this.traverse(estimateId, nodeId, 2);
    if (neighbors.length === 0) return '';
    return neighbors
      .map((n) => `[${n.type}] ${n.label}${n.properties ? ': ' + JSON.stringify(n.properties) : ''}`)
      .join('\n');
  }

  private ensureStore(estimateId: string) {
    if (!graphStore.has(estimateId)) {
      graphStore.set(estimateId, { nodes: new Map(), edges: [] });
    }
  }
}
