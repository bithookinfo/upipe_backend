import { Module, forwardRef } from "@nestjs/common";
import { EmailService } from "./email.service";
import { TemplatesModule } from "../templates/templates.module";

@Module({
  imports: [forwardRef(() => TemplatesModule)],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
