import { Module, forwardRef } from "@nestjs/common";
import { TemplateStoreService } from "./template-store.service";
import { TemplatesController } from "./templates.controller";
import { EmailModule } from "../email/email.module";

@Module({
  imports: [forwardRef(() => EmailModule)],
  controllers: [TemplatesController],
  providers: [TemplateStoreService],
  exports: [TemplateStoreService],
})
export class TemplatesModule {}
