import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { User, UserDocument } from './user.schema';

export type UserStatus = 'ACTIVE' | 'DISABLED' | 'BANNED' | 'PENDING_EMAIL' | 'DELETED';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  status: UserStatus;
  lastLoginAt?: Date;
  createdAt?: Date;
}

export function toPublicUser(doc: UserDocument): PublicUser {
  return {
    id: doc._id.toString(),
    name: doc.name,
    email: doc.email,
    role: doc.role,
    status: doc.status,
    lastLoginAt: doc.lastLoginAt,
    createdAt: (doc as unknown as { createdAt?: Date }).createdAt,
  };
}

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private readonly userModel: Model<UserDocument>) {}

  findByEmail(email: string) {
    return this.userModel.findOne({ email: email.toLowerCase().trim() }).exec();
  }

  findById(id: string) {
    return this.userModel.findById(id).exec();
  }

  create(data: { name: string; email: string; passwordHash: string; role?: 'admin' | 'user' }) {
    return this.userModel.create({
      name: data.name,
      email: data.email.toLowerCase().trim(),
      passwordHash: data.passwordHash,
      role: data.role ?? 'user',
    });
  }

  async findAll(filter: { role?: string; status?: string; email?: string }, page = 1, limit = 20) {
    const query: FilterQuery<UserDocument> = {};
    if (filter.role) query.role = filter.role;
    if (filter.status) query.status = filter.status;
    if (filter.email) query.email = { $regex: filter.email.trim(), $options: 'i' };

    const skip = Math.max(0, (page - 1) * limit);
    const [docs, total] = await Promise.all([
      this.userModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      this.userModel.countDocuments(query).exec(),
    ]);
    return { items: docs.map(toPublicUser), total, page, limit };
  }

  async updateStatus(id: string, status: UserStatus) {
    const doc = await this.userModel.findByIdAndUpdate(id, { status }, { new: true }).exec();
    return doc ? toPublicUser(doc) : null;
  }

  async updateRole(id: string, role: 'admin' | 'user') {
    const doc = await this.userModel.findByIdAndUpdate(id, { role }, { new: true }).exec();
    return doc ? toPublicUser(doc) : null;
  }

  async softDelete(id: string) {
    return this.updateStatus(id, 'DELETED');
  }

  async touchLastLogin(id: string) {
    await this.userModel.updateOne({ _id: id }, { lastLoginAt: new Date() }).exec();
  }

  countTotal() {
    return this.userModel.countDocuments().exec();
  }

  countActiveSince(since: Date) {
    return this.userModel.countDocuments({ lastLoginAt: { $gte: since } }).exec();
  }
}
