import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PublicUser, toPublicUser, UsersService } from '../users/users.service';
import { LoginDto, RegisterDto } from './dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  private sign(user: PublicUser): string {
    return this.jwt.sign({ sub: user.id, email: user.email, role: user.role });
  }

  async register(dto: RegisterDto): Promise<{ accessToken: string; user: PublicUser }> {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const doc = await this.users.create({
      name: dto.name,
      email: dto.email,
      passwordHash,
    });
    const user = toPublicUser(doc);
    return { accessToken: this.sign(user), user };
  }

  async login(dto: LoginDto): Promise<{ accessToken: string; user: PublicUser }> {
    const doc = await this.users.findByEmail(dto.email);
    if (!doc) throw new UnauthorizedException('Invalid credentials');

    const ok = await bcrypt.compare(dto.password, doc.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    if (doc.status && doc.status !== 'ACTIVE') {
      throw new UnauthorizedException(`Account is ${doc.status.toLowerCase()}`);
    }

    await this.users.touchLastLogin(doc._id.toString());
    const user = toPublicUser(doc);
    return { accessToken: this.sign(user), user };
  }

  async me(userId: string): Promise<PublicUser> {
    const doc = await this.users.findById(userId);
    if (!doc) throw new UnauthorizedException();
    return toPublicUser(doc);
  }

  async refresh(userId: string): Promise<{ accessToken: string }> {
    const user = await this.me(userId);
    return { accessToken: this.sign(user) };
  }
}
