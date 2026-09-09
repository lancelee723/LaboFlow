import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AuthService } from './auth.service.js';
import type { Role } from '../teams/rbac.js';

/** Routes that skip authentication (health probe + login itself). */
const PUBLIC_ROUTES = new Set(['/healthz', '/auth/login']);

export const IS_PUBLIC = 'isPublic';
export const Public = (): MethodDecorator => SetMetadata(IS_PUBLIC, true);

export interface Actor {
  userId: string;
  role: Role;
  teamId: string | null;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<FastifyRequest & { __auth?: Actor }>();
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException('未登录');
    try {
      const payload = await this.auth.verifyToken(header.slice(7));
      if (payload.typ !== 'access') throw new Error('not an access token');
      req.__auth = { userId: payload.sub, role: payload.role, teamId: payload.teamId };
      return true;
    } catch {
      throw new UnauthorizedException('令牌无效或已过期');
    }
  }
}
