import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Injectable()
export class CmsService {
  private readonly logger = new Logger(CmsService.name);

  constructor(private prisma: PrismaService) {}

  // =============================================
  // PAGES
  // =============================================

  async getPages() {
    const pages = await this.prisma.cmsPage.findMany({
      orderBy: { createdAt: 'desc' },
      include: { sections: { orderBy: { order: 'asc' } } },
    });
    return pages.map(page => ({
      ...page,
      sections: page.sections.map(s => ({
        ...s,
        content: typeof s.content === 'string' ? JSON.parse(s.content) : s.content
      }))
    }));
  }

  async getPageById(id: string) {
    const page = await this.prisma.cmsPage.findUnique({
      where: { id },
      include: { sections: { orderBy: { order: 'asc' } } },
    });
    if (!page) throw new NotFoundException('Page not found');
    return {
      ...page,
      sections: page.sections.map(s => ({
        ...s,
        content: typeof s.content === 'string' ? JSON.parse(s.content) : s.content
      }))
    };
  }

  async getPageBySlug(slug: string) {
    const page = await this.prisma.cmsPage.findUnique({
      where: { slug },
      include: { sections: { where: { isVisible: true }, orderBy: { order: 'asc' } } },
    });
    if (!page || page.status !== 'published') throw new NotFoundException('Page not found');
    return {
      ...page,
      sections: page.sections.map(s => ({
        ...s,
        content: typeof s.content === 'string' ? JSON.parse(s.content) : s.content
      }))
    };
  }

  async createPage(data: any) {
    const { sections, id, createdAt, updatedAt, ...pageData } = data;
    return this.prisma.cmsPage.create({ data: pageData });
  }

  async updatePage(id: string, data: any) {
    const { sections, createdAt, updatedAt, ...pageData } = data;
    delete pageData.id;
    await this.getPageById(id);
    return this.prisma.cmsPage.update({ where: { id }, data: pageData });
  }

  async deletePage(id: string) {
    await this.getPageById(id);
    return this.prisma.cmsPage.delete({ where: { id } });
  }

  // =============================================
  // SECTIONS
  // =============================================

  async getSections(pageSlug?: string, pageId?: string) {
    const where: any = {};
    if (pageSlug) where.pageSlug = pageSlug;
    if (pageId) where.pageId = pageId;
    const sections = await this.prisma.cmsSection.findMany({
      where,
      orderBy: { order: 'asc' },
    });
    return sections.map(s => ({
      ...s,
      content: typeof s.content === 'string' ? JSON.parse(s.content) : s.content
    }));
  }

  async getSectionById(id: string) {
    const section = await this.prisma.cmsSection.findUnique({ where: { id } });
    if (!section) throw new NotFoundException('Section not found');
    return {
      ...section,
      content: typeof section.content === 'string' ? JSON.parse(section.content) : section.content
    };
  }

  async upsertSection(pageSlug: string, sectionType: string, data: any) {
    const { id, createdAt, updatedAt, ...sectionData } = data;
    if (sectionData.content && typeof sectionData.content === 'object') {
      sectionData.content = JSON.stringify(sectionData.content);
    }
    // Try to find existing section for this page + type
    const existing = await this.prisma.cmsSection.findFirst({
      where: { pageSlug, sectionType },
    });

    if (existing) {
      const updated = await this.prisma.cmsSection.update({
        where: { id: existing.id },
        data: { ...sectionData, pageSlug, sectionType },
      });
      return { ...updated, content: typeof updated.content === 'string' ? JSON.parse(updated.content) : updated.content };
    }

    // Find the page to link
    const page = await this.prisma.cmsPage.findUnique({ where: { slug: pageSlug } });

    const created = await this.prisma.cmsSection.create({
      data: {
        ...sectionData,
        pageSlug,
        sectionType,
        pageId: page?.id || null,
      },
    });
    return { ...created, content: typeof created.content === 'string' ? JSON.parse(created.content) : created.content };
  }

  async deleteSection(id: string) {
    await this.getSectionById(id);
    return this.prisma.cmsSection.delete({ where: { id } });
  }

  // =============================================
  // GLOBAL SEO
  // =============================================

  async getGlobalSeo() {
    let seo = await this.prisma.cmsGlobalSeo.findUnique({ where: { id: 'global-seo' } });
    if (!seo) {
      seo = await this.prisma.cmsGlobalSeo.create({ data: { id: 'global-seo' } });
    }
    return seo;
  }

  async updateGlobalSeo(data: any) {
    const { id, createdAt, updatedAt, ...seoData } = data;
    return this.prisma.cmsGlobalSeo.upsert({
      where: { id: 'global-seo' },
      update: seoData,
      create: { id: 'global-seo', ...seoData },
    });
  }

  // =============================================
  // BRAND ASSETS
  // =============================================

  async getBrandAssets() {
    let assets = await this.prisma.cmsBrandAsset.findUnique({ where: { id: 'brand-assets' } });
    if (!assets) {
      assets = await this.prisma.cmsBrandAsset.create({ data: { id: 'brand-assets' } });
    }
    return assets;
  }

  async updateBrandAssets(data: any) {
    const { id, createdAt, updatedAt, ...assetsData } = data;
    return this.prisma.cmsBrandAsset.upsert({
      where: { id: 'brand-assets' },
      update: assetsData,
      create: { id: 'brand-assets', ...assetsData },
    });
  }

  // =============================================
  // NAVIGATION
  // =============================================

  async getNavigation(navType?: string) {
    const where: any = {};
    if (navType) where.navType = navType;
    return this.prisma.cmsNavigation.findMany({
      where,
      orderBy: { order: 'asc' },
    });
  }

  async getNavigationById(id: string) {
    const nav = await this.prisma.cmsNavigation.findUnique({ where: { id } });
    if (!nav) throw new NotFoundException('Navigation item not found');
    return nav;
  }

  async getPublicNavigation(navType?: string) {
    const where: any = { isVisible: true };
    if (navType) where.navType = navType;

    const items = await this.prisma.cmsNavigation.findMany({
      where,
      orderBy: { order: 'asc' },
    });

    // Build tree structure (parent-child)
    const rootItems = items.filter(i => !i.parentId);
    return rootItems.map(root => ({
      ...root,
      children: items.filter(i => i.parentId === root.id),
    }));
  }

  async createNavigation(data: any) {
    const { id, createdAt, updatedAt, ...navData } = data;
    return this.prisma.cmsNavigation.create({ data: navData });
  }

  async updateNavigation(id: string, data: any) {
    const { createdAt, updatedAt, ...navData } = data;
    delete navData.id;
    await this.getNavigationById(id);
    return this.prisma.cmsNavigation.update({ where: { id }, data: navData });
  }

  async deleteNavigation(id: string) {
    await this.getNavigationById(id);
    return this.prisma.cmsNavigation.delete({ where: { id } });
  }

  // =============================================
  // ROOT FILES
  // =============================================

  async getRootFiles() {
    return this.prisma.cmsRootFile.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async getRootFileByFilename(filename: string) {
    const file = await this.prisma.cmsRootFile.findUnique({ where: { filename } });
    if (!file) throw new NotFoundException('Root file not found');
    return file;
  }

  async upsertRootFile(data: { filename: string; content?: string; mimeType?: string }) {
    const existing = await this.prisma.cmsRootFile.findUnique({ where: { filename: data.filename } });
    if (existing) {
      return this.prisma.cmsRootFile.update({
        where: { id: existing.id },
        data: { content: data.content, mimeType: data.mimeType },
      });
    }
    return this.prisma.cmsRootFile.create({ data });
  }

  async deleteRootFile(id: string) {
    return this.prisma.cmsRootFile.delete({ where: { id } });
  }

  // =============================================
  // MEDIA
  // =============================================

  async getMedia(folder?: string) {
    const where: any = {};
    if (folder) where.folder = folder;
    return this.prisma.cmsMedia.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async getMediaById(id: string) {
    const media = await this.prisma.cmsMedia.findUnique({ where: { id } });
    if (!media) throw new NotFoundException('Media not found');
    return media;
  }

  async createMedia(data: any) {
    const { id, createdAt, updatedAt, ...mediaData } = data;
    return this.prisma.cmsMedia.create({ data: mediaData });
  }

  async updateMedia(id: string, data: any) {
    const { createdAt, updatedAt, ...mediaData } = data;
    delete mediaData.id;
    await this.getMediaById(id);
    return this.prisma.cmsMedia.update({ where: { id }, data: mediaData });
  }

  async deleteMedia(id: string) {
    await this.getMediaById(id);
    return this.prisma.cmsMedia.delete({ where: { id } });
  }

  // =============================================
  // FORMS
  // =============================================

  async getForms() {
    return this.prisma.cmsForm.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async getFormById(id: string) {
    const form = await this.prisma.cmsForm.findUnique({ where: { id } });
    if (!form) throw new NotFoundException('Form not found');
    return form;
  }

  async createForm(data: any) {
    const { id, createdAt, updatedAt, submissions, ...formData } = data;
    if (typeof formData.fields === 'object') {
      formData.fields = JSON.stringify(formData.fields);
    }
    return this.prisma.cmsForm.create({ data: formData });
  }

  async updateForm(id: string, data: any) {
    const { createdAt, updatedAt, submissions, ...formData } = data;
    delete formData.id;
    if (typeof formData.fields === 'object') {
      formData.fields = JSON.stringify(formData.fields);
    }
    await this.getFormById(id);
    return this.prisma.cmsForm.update({ where: { id }, data: formData });
  }

  async deleteForm(id: string) {
    await this.getFormById(id);
    return this.prisma.cmsForm.delete({ where: { id } });
  }

  // =============================================
  // FORM SUBMISSIONS
  // =============================================

  async getFormSubmissions(formId?: string) {
    const where: any = {};
    if (formId) where.formId = formId;
    return this.prisma.cmsFormSubmission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async createFormSubmission(formId: string, data: any, ipAddress?: string, userAgent?: string) {
    // Verify form exists and is public
    const form = await this.prisma.cmsForm.findUnique({ where: { id: formId } });
    if (!form) throw new NotFoundException('Form not found');

    return this.prisma.cmsFormSubmission.create({
      data: {
        formId,
        data: typeof data === 'string' ? data : JSON.stringify(data),
        ipAddress,
        userAgent,
      },
    });
  }

  async markSubmissionAsRead(id: string) {
    return this.prisma.cmsFormSubmission.update({
      where: { id },
      data: { isRead: true },
    });
  }

  // =============================================
  // THEMES
  // =============================================

  async getThemes() {
    return this.prisma.cmsTheme.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async getThemeById(id: string) {
    const theme = await this.prisma.cmsTheme.findUnique({ where: { id } });
    if (!theme) throw new NotFoundException('Theme not found');
    return theme;
  }

  async getActiveTheme() {
    return this.prisma.cmsTheme.findFirst({ where: { isActive: true } });
  }

  async createTheme(data: any) {
    const { id, createdAt, updatedAt, ...themeData } = data;
    if (typeof themeData.config === 'object') {
      themeData.config = JSON.stringify(themeData.config);
    }
    return this.prisma.cmsTheme.create({ data: themeData });
  }

  async updateTheme(id: string, data: any) {
    const { createdAt, updatedAt, ...themeData } = data;
    delete themeData.id;
    if (typeof themeData.config === 'object') {
      themeData.config = JSON.stringify(themeData.config);
    }
    await this.getThemeById(id);
    return this.prisma.cmsTheme.update({ where: { id }, data: themeData });
  }

  async deleteTheme(id: string) {
    await this.getThemeById(id);
    return this.prisma.cmsTheme.delete({ where: { id } });
  }

  async setActiveTheme(id: string) {
    await this.getThemeById(id);
    // Deactivate all themes first
    await this.prisma.cmsTheme.updateMany({ data: { isActive: false } });
    // Activate the selected theme
    return this.prisma.cmsTheme.update({
      where: { id },
      data: { isActive: true },
    });
  }

  // =============================================
  // REDIRECTS
  // =============================================

  async getRedirects() {
    return this.prisma.cmsRedirect.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async checkRedirect(path: string) {
    return this.prisma.cmsRedirect.findFirst({
      where: { oldUrl: path, isActive: true },
    });
  }

  async createRedirect(data: any) {
    const { id, createdAt, updatedAt, ...redirectData } = data;
    return this.prisma.cmsRedirect.create({ data: redirectData });
  }

  async updateRedirect(id: string, data: any) {
    const { createdAt, updatedAt, ...redirectData } = data;
    delete redirectData.id;
    return this.prisma.cmsRedirect.update({ where: { id }, data: redirectData });
  }

  async deleteRedirect(id: string) {
    return this.prisma.cmsRedirect.delete({ where: { id } });
  }

  // =============================================
  // BLOGS
  // =============================================

  async getBlogs(status?: string) {
    const where: any = {};
    if (status) where.status = status;
    return this.prisma.cmsBlog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getBlogById(id: string) {
    const blog = await this.prisma.cmsBlog.findUnique({ where: { id } });
    if (!blog) throw new NotFoundException('Blog not found');
    return blog;
  }

  async getBlogBySlug(slug: string) {
    const blog = await this.prisma.cmsBlog.findUnique({ where: { slug } });
    if (!blog || blog.status !== 'published') throw new NotFoundException('Blog not found');
    return blog;
  }

  async getPublishedBlogs() {
    return this.prisma.cmsBlog.findMany({
      where: { status: 'published' },
      orderBy: { publishedAt: 'desc' },
    });
  }

  async createBlog(data: any) {
    const { id, createdAt, updatedAt, ...blogData } = data;
    if (blogData.publishedAt) blogData.publishedAt = new Date(blogData.publishedAt);
    return this.prisma.cmsBlog.create({ data: blogData });
  }

  async updateBlog(id: string, data: any) {
    const { createdAt, updatedAt, ...blogData } = data;
    delete blogData.id;
    if (blogData.publishedAt) blogData.publishedAt = new Date(blogData.publishedAt);
    await this.getBlogById(id);
    return this.prisma.cmsBlog.update({ where: { id }, data: blogData });
  }

  async deleteBlog(id: string) {
    await this.getBlogById(id);
    return this.prisma.cmsBlog.delete({ where: { id } });
  }
}
