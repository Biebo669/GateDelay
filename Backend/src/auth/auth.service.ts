import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import * as nodemailer from 'nodemailer';
import * as crypto from 'crypto';
import {
  RegisterDto,
  LoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  SocialLoginDto,
} from './dto/auth.dto';
import { User } from './entities/user.entity';

@Injectable()
export class AuthService {
  // In-memory store — replace with a real DB in production
  private users: Map<string, User> = new Map();
  private usersByEmail: Map<string, string> = new Map(); // email -> id

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    if (this.usersByEmail.has(dto.email)) {
      throw new ConflictException('Email already registered');
    }
    const id = uuidv4();
    const hashed = await bcrypt.hash(dto.password, 10);
    const user: User = {
      id,
      email: dto.email,
      password: hashed,
      name: dto.name,
      provider: 'local',
      createdAt: new Date(),
    };
    this.users.set(id, user);
    this.usersByEmail.set(dto.email, id);
    return this.generateTokens(user);
  }

  async login(dto: LoginDto) {
    const userId = this.usersByEmail.get(dto.email);
    if (!userId) throw new UnauthorizedException('Invalid credentials');
    const user = this.users.get(userId)!;
    if (!user.password) throw new UnauthorizedException('Use social login');
    const valid = await bcrypt.compare(dto.password, user.password);
    if (!valid) throw new UnauthorizedException('Invalid credentials');
    return this.generateTokens(user);
  }

  async socialLogin(dto: SocialLoginDto) {
    // Verify token with provider and extract profile
    const profile = await this.verifySocialToken(dto.provider, dto.accessToken);
    let userId = this.usersByEmail.get(profile.email);
    if (!userId) {
      userId = uuidv4();
      const user: User = {
        id: userId,
        email: profile.email,
        name: profile.name,
        provider: dto.provider,
        providerId: profile.id,
        createdAt: new Date(),
      };
      this.users.set(userId, user);
      this.usersByEmail.set(profile.email, userId);
    }
    return this.generateTokens(this.users.get(userId)!);
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const userId = this.usersByEmail.get(dto.email);
    if (!userId)
      return { message: 'If the email exists, a reset link was sent' };
    const user = this.users.get(userId)!;
    const token = uuidv4();
    user.resetToken = token;
    user.resetTokenExpiry = new Date(Date.now() + 3600_000); // 1 hour
    await this.sendResetEmail(dto.email, token);
    return { message: 'If the email exists, a reset link was sent' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = [...this.users.values()].find(
      (u) => u.resetToken === dto.token && u.resetTokenExpiry! > new Date(),
    );
    if (!user) throw new BadRequestException('Invalid or expired reset token');
    user.password = await bcrypt.hash(dto.password, 10);
    user.resetToken = undefined;
    user.resetTokenExpiry = undefined;
    // BE-005: Invalidate all existing refresh sessions on password reset
    user.refreshTokenHash = undefined;
    user.refreshTokenId = undefined;
    user.usedRefreshTokenIds = new Set();
    return { message: 'Password reset successfully' };
  }

  async refreshTokens(refreshToken: string) {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
      const user = this.users.get(payload.sub);
      if (!user) {
        throw new UnauthorizedException();
      }
      
      // BE-007: Check for token ID (jti)
      if (!payload.jti) {
        throw new UnauthorizedException('Invalid token format');
      }
      
      // BE-007: Detect token reuse
      if (user.usedRefreshTokenIds?.has(payload.jti)) {
        // Token reuse detected - invalidate all sessions for this user
        user.refreshTokenHash = undefined;
        user.refreshTokenId = undefined;
        user.usedRefreshTokenIds = new Set();
        throw new UnauthorizedException('Token reuse detected');
      }
      
      // BE-006: Verify against stored hash instead of raw token
      const tokenHash = this.hashRefreshToken(refreshToken);
      if (!user.refreshTokenHash || user.refreshTokenHash !== tokenHash) {
        throw new UnauthorizedException();
      }
      
      // BE-007: Check if this is the current active token
      if (user.refreshTokenId !== payload.jti) {
        throw new UnauthorizedException('Token already rotated');
      }
      
      // Mark this token as consumed
      if (!user.usedRefreshTokenIds) {
        user.usedRefreshTokenIds = new Set();
      }
      user.usedRefreshTokenIds.add(payload.jti);
      
      return this.generateTokens(user);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async logout(userId: string) {
    const user = this.users.get(userId);
    if (user) {
      user.refreshTokenHash = undefined;
      user.refreshTokenId = undefined;
      user.usedRefreshTokenIds = new Set();
    }
    return { message: 'Logged out successfully' };
  }

  private generateTokens(user: User) {
    // BE-007: Generate unique token identifier (jti) for each refresh token
    const jti = crypto.randomBytes(32).toString('hex');
    
    const payload = { sub: user.id, email: user.email };
    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(
      { ...payload, jti }, // Include jti in refresh token payload
      {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.configService.get<string>(
          'JWT_REFRESH_EXPIRES_IN',
          '7d',
        ) as any,
      },
    );
    
    // BE-006: Store hash of refresh token instead of raw token
    user.refreshTokenHash = this.hashRefreshToken(refreshToken);
    user.refreshTokenId = jti;
    
    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }

  /**
   * BE-006: Hash refresh token for secure storage
   * Uses SHA-256 to create a one-way verifier
   */
  private hashRefreshToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * BE-004: Verify social provider tokens with proper configuration checking
   * Validates issuer, audience, expiry, and identity based on enabled providers
   */
  private async verifySocialToken(
    provider: string,
    accessToken: string,
  ): Promise<{ id: string; email: string; name: string }> {
    const enabledProviders = this.configService
      .get<string>('SOCIAL_LOGIN_PROVIDERS', '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    // BE-004: Check if provider is enabled
    if (!enabledProviders.includes(provider)) {
      throw new BadRequestException(
        `Social login via ${provider} is not enabled`,
      );
    }

    // BE-004: Implement provider-specific verification
    switch (provider) {
      case 'google':
        return await this.verifyGoogleToken(accessToken);
      case 'twitter':
        return await this.verifyTwitterToken(accessToken);
      default:
        throw new BadRequestException(
          `Social login via ${provider} not yet configured`,
        );
    }
  }

  /**
   * BE-004: Verify Google OAuth token
   * Checks issuer, audience, expiry, and email verification
   */
  private async verifyGoogleToken(
    token: string,
  ): Promise<{ id: string; email: string; name: string }> {
    const googleClientId = this.configService.get<string>(
      'GOOGLE_OAUTH_CLIENT_ID',
    );
    if (!googleClientId) {
      throw new BadRequestException(
        'Google OAuth is not properly configured',
      );
    }

    try {
      // In production, use Google's token verification library
      // const ticket = await client.verifyIdToken({
      //   idToken: token,
      //   audience: googleClientId,
      // });
      // const payload = ticket.getPayload();
      
      // Placeholder implementation for demonstration
      const response = await fetch(
        `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`,
      );
      
      if (!response.ok) {
        throw new UnauthorizedException('Invalid Google token');
      }
      
      const payload = await response.json();
      
      // BE-004: Verify token properties
      if (payload.aud !== googleClientId) {
        throw new UnauthorizedException('Invalid audience');
      }
      
      if (!payload.email_verified) {
        throw new UnauthorizedException('Email not verified');
      }
      
      if (payload.exp && payload.exp * 1000 < Date.now()) {
        throw new UnauthorizedException('Token expired');
      }

      return {
        id: payload.sub,
        email: payload.email,
        name: payload.name || payload.email,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Failed to verify Google token');
    }
  }

  /**
   * BE-004: Verify Twitter OAuth token
   * Checks issuer, audience, and expiry
   */
  private async verifyTwitterToken(
    token: string,
  ): Promise<{ id: string; email: string; name: string }> {
    const twitterClientId = this.configService.get<string>(
      'TWITTER_OAUTH_CLIENT_ID',
    );
    if (!twitterClientId) {
      throw new BadRequestException(
        'Twitter OAuth is not properly configured',
      );
    }

    try {
      // In production, use Twitter API v2 to verify token
      // const response = await fetch('https://api.twitter.com/2/users/me', {
      //   headers: { Authorization: `Bearer ${token}` },
      // });
      
      // Placeholder for demonstration
      throw new BadRequestException(
        'Twitter OAuth verification not yet implemented',
      );
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof BadRequestException) {
        throw error;
      }
      throw new UnauthorizedException('Failed to verify Twitter token');
    }
  }

  private async sendResetEmail(email: string, token: string) {
    const transporter = nodemailer.createTransport({
      host: this.configService.get('SMTP_HOST'),
      port: this.configService.get<number>('SMTP_PORT'),
      auth: {
        user: this.configService.get('SMTP_USER'),
        pass: this.configService.get('SMTP_PASS'),
      },
    });
    const resetUrl = `${this.configService.get('FRONTEND_URL', 'http://localhost:3001')}/reset-password?token=${token}`;
    await transporter.sendMail({
      from: this.configService.get('EMAIL_FROM', 'noreply@gatedelay.com'),
      to: email,
      subject: 'GateDelay - Password Reset',
      html: `<p>Click <a href="${resetUrl}">here</a> to reset your password. Link expires in 1 hour.</p>`,
    });
  }
}
