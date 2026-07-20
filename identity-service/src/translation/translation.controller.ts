import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  Res,
  Headers,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { TranslationService } from './translation.service';

@Controller('translations')
export class TranslationController {
  private readonly logger = new Logger(TranslationController.name);

  constructor(private readonly translationService: TranslationService) {}

  @Get()
  async getAllTranslations(
    @Query('page') page = '1',
    @Query('limit') limit = '100',
    @Query('languageCode') languageCode?: string,
    @Query('search') search?: string,
  ) {
    const result = await this.translationService.getAllTranslations({
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      languageCode,
      search,
    });
    return { success: true, data: result, message: 'Translations fetched successfully' };
  }

  @Get('languages/list')
  async getAvailableLanguages() {
    const languages = await this.translationService.getAvailableLanguages();
    return { success: true, data: languages, message: 'Languages fetched successfully' };
  }

  @Get(':languageCode')
  async getTranslationsByLanguage(
    @Param('languageCode') languageCode: string,
    @Query('version') version?: string,
  ) {
    const result = await this.translationService.getTranslationsByLanguage(
      languageCode,
      version ? parseInt(version, 10) : undefined,
    );
    return { success: true, data: result, message: 'Translations fetched successfully' };
  }

  @Get(':languageCode/version')
  async getTranslationVersion(@Param('languageCode') languageCode: string) {
    const versionData = await this.translationService.getTranslationVersion(languageCode);
    return { success: true, data: versionData, message: 'Translation version fetched successfully' };
  }

  @Get(':languageCode/export')
  async exportTranslations(
    @Param('languageCode') languageCode: string,
    @Res() res: Response,
  ) {
    const translations = await this.translationService.exportTranslations(languageCode);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${languageCode}.json"`);
    res.send(JSON.stringify(translations, null, 2));
  }

  @Post()
  async createTranslation(
    @Body() body: { languageCode: string; key: string; value: string; namespace?: string; description?: string },
    @Headers('x-user-id') userId?: string,
  ) {
    const translation = await this.translationService.createTranslation({
      languageCode: body.languageCode,
      key: body.key,
      value: body.value,
      namespace: body.namespace || 'translation',
      description: body.description,
      createdBy: userId,
    });
    return { success: true, data: translation, message: 'Translation created successfully' };
  }

  @Post(':languageCode/import')
  async importTranslations(
    @Param('languageCode') languageCode: string,
    @Body() body: { translations: Record<string, any>; overwrite?: boolean },
    @Headers('x-user-id') userId?: string,
  ) {
    const result = await this.translationService.importTranslations(
      languageCode,
      body.translations,
      body.overwrite ?? false,
      userId,
    );
    return { success: true, data: result, message: 'Translations imported successfully' };
  }

  @Put('bulk/update')
  async bulkUpdateTranslations(
    @Body() body: { translations: Array<{ id: string; value: string; description?: string }> },
    @Headers('x-user-id') userId?: string,
  ) {
    const result = await this.translationService.bulkUpdateTranslations(body.translations, userId);
    return { success: true, data: result, message: 'Translations updated successfully' };
  }

  @Put(':id')
  async updateTranslation(
    @Param('id') id: string,
    @Body() body: { value: string; description?: string },
    @Headers('x-user-id') userId?: string,
  ) {
    const translation = await this.translationService.updateTranslation(id, {
      value: body.value,
      description: body.description,
      updatedBy: userId,
    });
    return { success: true, data: translation, message: 'Translation updated successfully' };
  }

  @Delete(':id')
  async deleteTranslation(@Param('id') id: string) {
    await this.translationService.deleteTranslation(id);
    return { success: true, message: 'Translation deleted successfully' };
  }

  @Get(':id/audit')
  async getTranslationAudit(
    @Param('id') id: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    const result = await this.translationService.getTranslationAudit(id, {
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
    return { success: true, data: result, message: 'Translation audit fetched successfully' };
  }
}
