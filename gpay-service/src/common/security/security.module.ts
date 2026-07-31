import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GpayEncryptionService } from './gpay-encryption.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [GpayEncryptionService],
  exports: [GpayEncryptionService],
})
export class SecurityModule {}
