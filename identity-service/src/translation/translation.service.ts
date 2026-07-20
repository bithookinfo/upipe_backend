import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction } from '@prisma/client';

@Injectable()
export class TranslationService {
  private readonly logger = new Logger(TranslationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getTranslationsByLanguage(languageCode: string, clientVersion?: number) {
    const versionData = await this.prisma.translationVersion.findUnique({
      where: { languageCode },
    });

    const currentVersion = versionData?.version || 1;

    if (clientVersion && clientVersion === currentVersion) {
      return {
        version: currentVersion,
        hasUpdate: false,
        translations: null,
      };
    }

    const translations = await this.prisma.translation.findMany({
      where: {
        languageCode,
        isActive: true,
        isDeleted: false,
      },
      select: {
        id: true,
        key: true,
        value: true,
        namespace: true,
      },
    });

    const nestedTranslations = this.flatToNested(translations);

    return {
      version: currentVersion,
      hasUpdate: true,
      translations: nestedTranslations,
      count: translations.length,
    };
  }

  async getAllTranslations(filters: {
    page: number;
    limit: number;
    languageCode?: string;
    search?: string;
  }) {
    const { page, limit, languageCode, search } = filters;
    const skip = (page - 1) * limit;

    const where: any = {
      isActive: true,
      isDeleted: false,
    };

    if (languageCode) {
      where.languageCode = languageCode;
    }

    if (search) {
      where.OR = [{ key: { contains: search } }, { value: { contains: search } }];
    }

    const [translations, total] = await Promise.all([
      this.prisma.translation.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ languageCode: 'asc' }, { key: 'asc' }],
      }),
      this.prisma.translation.count({ where }),
    ]);

    return {
      translations,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getTranslationVersion(languageCode: string) {
    const versionData = await this.prisma.translationVersion.findUnique({
      where: { languageCode },
    });

    return {
      languageCode,
      version: versionData?.version || 1,
      updatedAt: versionData?.updatedAt || new Date(),
    };
  }

  async createTranslation(data: {
    languageCode: string;
    key: string;
    value: string;
    namespace?: string;
    description?: string;
    createdBy?: string;
  }) {
    const existing = await this.prisma.translation.findUnique({
      where: {
        languageCode_namespace_key: {
          languageCode: data.languageCode,
          namespace: data.namespace || 'translation',
          key: data.key,
        },
      },
    });

    if (existing) {
      throw new BadRequestException('Translation already exists for this key');
    }

    const translation = await this.prisma.translation.create({
      data: {
        languageCode: data.languageCode,
        namespace: data.namespace || 'translation',
        key: data.key,
        value: data.value,
        description: data.description || null,
        createdBy: data.createdBy || null,
      },
    });

    await this.createAuditLog(translation.id, {
      languageCode: data.languageCode,
      key: data.key,
      newValue: data.value,
      changedBy: data.createdBy || null,
      action: AuditAction.create,
    });

    await this.incrementVersion(data.languageCode);

    return translation;
  }

  async updateTranslation(
    id: string,
    data: {
      value: string;
      description?: string | null;
      updatedBy?: string | null;
    },
  ) {
    const translation = await this.prisma.translation.findUnique({
      where: { id },
    });

    if (!translation) {
      throw new NotFoundException('Translation not found');
    }

    const oldValue = translation.value;

    const updated = await this.prisma.translation.update({
      where: { id },
      data: {
        value: data.value,
        description: data.description ?? null,
        updatedBy: data.updatedBy ?? null,
      },
    });

    await this.createAuditLog(id, {
      languageCode: translation.languageCode,
      key: translation.key,
      oldValue,
      newValue: data.value,
      changedBy: data.updatedBy || null,
      action: AuditAction.update,
    });

    await this.incrementVersion(translation.languageCode);

    return updated;
  }

  async deleteTranslation(id: string) {
    const translation = await this.prisma.translation.findUnique({
      where: { id },
    });

    if (!translation) {
      throw new NotFoundException('Translation not found');
    }

    await this.prisma.translation.update({
      where: { id },
      data: {
        isDeleted: true,
        isActive: false,
      },
    });

    await this.createAuditLog(id, {
      languageCode: translation.languageCode,
      key: translation.key,
      oldValue: translation.value,
      newValue: '',
      action: AuditAction.delete,
    });

    await this.incrementVersion(translation.languageCode);
  }

  async bulkUpdateTranslations(
    updates: Array<{ id: string; value: string; description?: string }>,
    updatedBy?: string,
  ) {
    const results = [];

    for (const update of updates) {
      try {
        const translation = await this.updateTranslation(update.id, {
          value: update.value,
          description: update.description ?? null,
          updatedBy: updatedBy ?? null,
        });
        results.push({ id: update.id, success: true, translation });
      } catch (error) {
        results.push({ id: update.id, success: false, error: (error as Error).message });
      }
    }

    return {
      total: updates.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    };
  }

  async getTranslationAudit(translationId: string, options: { page: number; limit: number }) {
    const { page, limit } = options;
    const skip = (page - 1) * limit;

    const [audits, total] = await Promise.all([
      this.prisma.translationAudit.findMany({
        where: { translationId },
        skip,
        take: limit,
        orderBy: { changedAt: 'desc' },
      }),
      this.prisma.translationAudit.count({ where: { translationId } }),
    ]);

    return {
      audits,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getAvailableLanguages() {
    const languages = await this.prisma.translation.groupBy({
      by: ['languageCode'],
      where: {
        isActive: true,
        isDeleted: false,
      },
      _count: {
        id: true,
      },
    });

    const versions = await this.prisma.translationVersion.findMany();

    return languages.map((lang) => {
      const version = versions.find((v) => v.languageCode === lang.languageCode);
      return {
        languageCode: lang.languageCode,
        translationCount: lang._count.id,
        version: version?.version || 1,
        updatedAt: version?.updatedAt || new Date(),
      };
    });
  }

  async exportTranslations(languageCode: string) {
    const translations = await this.prisma.translation.findMany({
      where: {
        languageCode,
        isActive: true,
        isDeleted: false,
      },
      select: {
        key: true,
        value: true,
      },
    });

    return this.flatToNested(translations);
  }

  async importTranslations(
    languageCode: string,
    translations: Record<string, any>,
    overwrite: boolean,
    createdBy?: string,
  ) {
    const flatTranslations = this.nestedToFlat(translations);
    const results = {
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [] as string[],
      createdKeys: [] as string[],
      updatedKeys: [] as Array<{ key: string; oldValue: string; newValue: string }>,
      skippedKeys: [] as string[],
    };

    const existingTranslations = await this.prisma.translation.findMany({
      where: {
        languageCode,
        namespace: 'translation',
      },
      select: {
        id: true,
        key: true,
        value: true,
      },
    });

    const existingMap = new Map(
      existingTranslations.map((t) => [t.key, { id: t.id, value: t.value }]),
    );

    const toCreate: Array<{
      languageCode: string;
      namespace: string;
      key: string;
      value: string;
      isActive: boolean;
      isDeleted: boolean;
    }> = [];

    const toUpdate: Array<{ id: string; key: string; oldValue: string; newValue: string }> = [];

    for (const [key, value] of Object.entries(flatTranslations)) {
      const valueStr = String(value);
      const existing = existingMap.get(key);

      if (existing) {
        if (overwrite || existing.value !== valueStr) {
          toUpdate.push({
            id: existing.id,
            key,
            oldValue: existing.value,
            newValue: valueStr,
          });
          results.updatedKeys.push({
            key,
            oldValue: existing.value,
            newValue: valueStr,
          });
        } else {
          results.skipped++;
          results.skippedKeys.push(key);
        }
      } else {
        toCreate.push({
          languageCode,
          namespace: 'translation',
          key,
          value: valueStr,
          isActive: true,
          isDeleted: false,
        });
        results.createdKeys.push(key);
      }
    }

    try {
      if (toCreate.length > 0) {
        await this.prisma.translation.createMany({
          data: toCreate,
          skipDuplicates: true,
        });
        results.created = toCreate.length;
      }

      if (toUpdate.length > 0) {
        for (const update of toUpdate) {
          await this.prisma.translation.update({
            where: { id: update.id },
            data: {
              value: update.newValue,
              updatedAt: new Date(),
            },
          });

          await this.createAuditLog(update.id, {
            languageCode,
            key: update.key,
            oldValue: update.oldValue,
            newValue: update.newValue,
            changedBy: createdBy ?? null,
            action: AuditAction.update,
          });
        }
        results.updated = toUpdate.length;
      }

      if (results.created > 0 || results.updated > 0) {
        await this.incrementVersion(languageCode);
      }
    } catch (error) {
      results.errors.push(`Batch operation failed: ${(error as Error).message}`);
    }

    return results;
  }

  private async incrementVersion(languageCode: string) {
    await this.prisma.translationVersion.upsert({
      where: { languageCode },
      update: {
        version: { increment: 1 },
      },
      create: {
        languageCode,
        version: 1,
      },
    });
  }

  private async createAuditLog(
    translationId: string,
    data: {
      languageCode: string;
      key: string;
      oldValue?: string | null;
      newValue: string;
      changedBy?: string | null;
      action: AuditAction;
    },
  ) {
    await this.prisma.translationAudit.create({
      data: {
        translationId,
        languageCode: data.languageCode,
        key: data.key,
        oldValue: data.oldValue ?? null,
        newValue: data.newValue,
        changedBy: data.changedBy ?? null,
        action: data.action,
      },
    });
  }

  private flatToNested(translations: Array<{ key: string; value: string }>): Record<string, any> {
    const nested: Record<string, any> = {};

    for (const { key, value } of translations) {
      const keys = key.split('.');
      let current: any = nested;

      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (k) {
          if (current[k] !== undefined && typeof current[k] !== 'object') {
            this.logger.warn(`Skipping key "${key}" due to conflict with existing value at "${k}"`);
            break;
          }

          if (!current[k]) {
            current[k] = {};
          }
          current = current[k];
        }
      }

      const lastKey = keys[keys.length - 1];
      if (lastKey && current && typeof current === 'object') {
        current[lastKey] = value;
      }
    }

    return nested;
  }

  private nestedToFlat(obj: Record<string, any>, prefix = ''): Record<string, string> {
    const flat: Record<string, string> = {};

    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}.${key}` : key;

      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        Object.assign(flat, this.nestedToFlat(value, newKey));
      } else {
        flat[newKey] = String(value);
      }
    }

    return flat;
  }
}
