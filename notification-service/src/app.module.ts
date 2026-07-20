import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'path';
import { EmailModule } from './email/email.module';
import { TemplatesModule } from './templates/templates.module';
import { PushModule } from './push/push.module';
import { InternalController } from './internal.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: join(__dirname, '..', '.env') }),
    EmailModule,
    TemplatesModule,
    PushModule,
  ],
  controllers: [InternalController],
})
export class AppModule {}