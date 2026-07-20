import { Injectable } from '@nestjs/common';

@Injectable()
export class AuthService {
  // Simple auth service for now - will integrate with Identity Service later
  async validateUser(payload: any) {
    // This is called by JWT strategy
    return payload;
  }
}
