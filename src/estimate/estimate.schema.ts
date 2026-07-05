import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { COLLECTIONS } from '../common/constants';
import type {
  ActivityEntry,
  Costs,
  Labor,
  Markups,
  Material,
  ProjectInfo,
  TakeoffItem,
  UnitPriceAnalysis,
  Equipment,
} from './estimate.types';
import { DEFAULT_MARKUPS } from './estimate.types';

export type EstimateDocument = HydratedDocument<Estimate>;

@Schema({ collection: COLLECTIONS.estimates, timestamps: true, minimize: false })
export class Estimate {
  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: Object, default: {} })
  projectInfo: ProjectInfo;

  @Prop({ type: [Object], default: [] })
  takeoff: TakeoffItem[];

  @Prop({ type: [Object], default: [] })
  analyses: UnitPriceAnalysis[];

  @Prop({ type: [Object], default: [] })
  materials: Material[];

  @Prop({ type: [Object], default: [] })
  labor: Labor[];

  @Prop({ type: [Object], default: [] })
  equipment: Equipment[];

  @Prop({ type: Object, default: () => ({ ...DEFAULT_MARKUPS }) })
  markups: Markups;

  @Prop({ type: [Object], default: [] })
  sheets: any[];

  @Prop({ type: [Object], default: [] })
  entityMaps: any[];

  @Prop({ type: Object, default: { material: 0, labor: 0, machine: 0, total: 0 } })
  costs: Costs;

  @Prop({ type: [Object], default: [] })
  activityLog: ActivityEntry[];

  @Prop({ type: [Object], default: [] })
  patchHistory: any[];

  @Prop({ type: [Object], default: [] })
  conversationMessages: any[];

  /** Phiên chat độc lập: [{id, title, createdAt, updatedAt, messages}] — thay conversationMessages (giữ field cũ để migration mềm). */
  @Prop({ type: [Object], default: [] })
  chatSessions: any[];
}

export const EstimateSchema = SchemaFactory.createForClass(Estimate);
