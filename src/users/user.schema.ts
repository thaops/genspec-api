import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { COLLECTIONS } from '../common/constants';

export type UserDocument = HydratedDocument<User>;

@Schema({ collection: COLLECTIONS.users, timestamps: true })
export class User {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true })
  passwordHash: string;

  @Prop({ required: true, enum: ['admin', 'user'], default: 'user' })
  role: 'admin' | 'user';

  @Prop({
    required: true,
    enum: ['ACTIVE', 'DISABLED', 'BANNED', 'PENDING_EMAIL', 'DELETED'],
    default: 'ACTIVE',
  })
  status: 'ACTIVE' | 'DISABLED' | 'BANNED' | 'PENDING_EMAIL' | 'DELETED';

  @Prop()
  lastLoginAt?: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);
