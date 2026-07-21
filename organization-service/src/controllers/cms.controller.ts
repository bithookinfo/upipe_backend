import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  Logger,
} from '@nestjs/common';
import { CmsService } from '../services/cms.service';
import { Request, Response } from 'express';

// =============================================
// ADMIN CMS CONTROLLER (requires auth via gateway)
// =============================================

@Controller('cms/admin')
export class CmsAdminController {
  private readonly logger = new Logger(CmsAdminController.name);

  constructor(private readonly cmsService: CmsService) {}

  // ---------- Pages ----------
  @Get('pages')
  async getPages() {
    const data = await this.cmsService.getPages();
    return { success: true, data };
  }

  @Get('pages/:id')
  async getPageById(@Param('id') id: string) {
    const data = await this.cmsService.getPageById(id);
    return { success: true, data };
  }

  @Post('pages')
  async createPage(@Body() body: any) {
    const data = await this.cmsService.createPage(body);
    return { success: true, data };
  }

  @Put('pages/:id')
  async updatePage(@Param('id') id: string, @Body() body: any) {
    const data = await this.cmsService.updatePage(id, body);
    return { success: true, data };
  }

  @Delete('pages/:id')
  async deletePage(@Param('id') id: string) {
    await this.cmsService.deletePage(id);
    return { success: true, data: null };
  }

  // ---------- Sections ----------
  @Get('sections')
  async getSections(@Query('pageSlug') pageSlug?: string, @Query('pageId') pageId?: string) {
    const data = await this.cmsService.getSections(pageSlug, pageId);
    return { success: true, data };
  }

  @Get('sections/:id')
  async getSectionById(@Param('id') id: string) {
    const data = await this.cmsService.getSectionById(id);
    return { success: true, data };
  }

  @Post('sections/:pageSlug/:sectionType')
  async upsertSection(
    @Param('pageSlug') pageSlug: string,
    @Param('sectionType') sectionType: string,
    @Body() body: any,
  ) {
    const data = await this.cmsService.upsertSection(pageSlug, sectionType, body);
    return { success: true, data };
  }

  @Delete('sections/:id')
  async deleteSection(@Param('id') id: string) {
    await this.cmsService.deleteSection(id);
    return { success: true, data: null };
  }

  // ---------- Global SEO ----------
  @Get('global-seo')
  async getGlobalSeo() {
    const data = await this.cmsService.getGlobalSeo();
    return { success: true, data };
  }

  @Put('global-seo')
  async updateGlobalSeo(@Body() body: any) {
    const data = await this.cmsService.updateGlobalSeo(body);
    return { success: true, data };
  }

  // ---------- Brand Assets ----------
  @Get('brand-assets')
  async getBrandAssets() {
    const data = await this.cmsService.getBrandAssets();
    return { success: true, data };
  }

  @Put('brand-assets')
  async updateBrandAssets(@Body() body: any) {
    const data = await this.cmsService.updateBrandAssets(body);
    return { success: true, data };
  }

  // ---------- Navigation ----------
  @Get('navigation')
  async getNavigation(@Query('type') navType?: string) {
    const data = await this.cmsService.getNavigation(navType);
    return { success: true, data };
  }

  @Get('navigation/:id')
  async getNavigationById(@Param('id') id: string) {
    const data = await this.cmsService.getNavigationById(id);
    return { success: true, data };
  }

  @Post('navigation')
  async createNavigation(@Body() body: any) {
    const data = await this.cmsService.createNavigation(body);
    return { success: true, data };
  }

  @Put('navigation/:id')
  async updateNavigation(@Param('id') id: string, @Body() body: any) {
    const data = await this.cmsService.updateNavigation(id, body);
    return { success: true, data };
  }

  @Delete('navigation/:id')
  async deleteNavigation(@Param('id') id: string) {
    await this.cmsService.deleteNavigation(id);
    return { success: true, data: null };
  }

  // ---------- Footer Categories ----------
  @Get('footer-categories')
  async getFooterCategories() {
    const data = await this.cmsService.getFooterCategories();
    return { success: true, data };
  }

  @Get('footer-categories/:id')
  async getFooterCategoryById(@Param('id') id: string) {
    const data = await this.cmsService.getFooterCategoryById(id);
    return { success: true, data };
  }

  @Post('footer-categories')
  async createFooterCategory(@Body() body: any) {
    const data = await this.cmsService.createFooterCategory(body);
    return { success: true, data };
  }

  @Put('footer-categories/:id')
  async updateFooterCategory(@Param('id') id: string, @Body() body: any) {
    const data = await this.cmsService.updateFooterCategory(id, body);
    return { success: true, data };
  }

  @Delete('footer-categories/:id')
  async deleteFooterCategory(@Param('id') id: string) {
    await this.cmsService.deleteFooterCategory(id);
    return { success: true, data: null };
  }

  // ---------- Root Files ----------
  @Get('root-files')
  async getRootFiles() {
    const data = await this.cmsService.getRootFiles();
    return { success: true, data };
  }

  @Post('root-files')
  async upsertRootFile(@Body() body: { filename: string; content?: string }) {
    const data = await this.cmsService.upsertRootFile(body);
    return { success: true, data };
  }

  @Delete('root-files/:id')
  async deleteRootFile(@Param('id') id: string) {
    await this.cmsService.deleteRootFile(id);
    return { success: true, data: null };
  }

  // ---------- Media ----------
  @Get('media')
  async getMedia(@Query('folder') folder?: string) {
    const data = await this.cmsService.getMedia(folder);
    return { success: true, data };
  }

  @Get('media/:id')
  async getMediaById(@Param('id') id: string) {
    const data = await this.cmsService.getMediaById(id);
    return { success: true, data };
  }

  @Post('media')
  async createMedia(@Body() body: any) {
    const data = await this.cmsService.createMedia(body);
    return { success: true, data };
  }

  @Put('media/:id')
  async updateMedia(@Param('id') id: string, @Body() body: any) {
    const data = await this.cmsService.updateMedia(id, body);
    return { success: true, data };
  }

  @Delete('media/:id')
  async deleteMedia(@Param('id') id: string) {
    await this.cmsService.deleteMedia(id);
    return { success: true, data: null };
  }

  // ---------- Forms ----------
  @Get('forms')
  async getForms() {
    const data = await this.cmsService.getForms();
    return { success: true, data };
  }

  @Get('forms/:id')
  async getFormById(@Param('id') id: string) {
    const data = await this.cmsService.getFormById(id);
    return { success: true, data };
  }

  @Post('forms')
  async createForm(@Body() body: any) {
    const data = await this.cmsService.createForm(body);
    return { success: true, data };
  }

  @Put('forms/:id')
  async updateForm(@Param('id') id: string, @Body() body: any) {
    const data = await this.cmsService.updateForm(id, body);
    return { success: true, data };
  }

  @Delete('forms/:id')
  async deleteForm(@Param('id') id: string) {
    await this.cmsService.deleteForm(id);
    return { success: true, data: null };
  }

  // ---------- Form Submissions ----------
  @Get('form-submissions')
  async getFormSubmissions(@Query('formId') formId?: string) {
    const data = await this.cmsService.getFormSubmissions(formId);
    return { success: true, data };
  }

  @Put('form-submissions/:id/read')
  async markSubmissionAsRead(@Param('id') id: string) {
    const data = await this.cmsService.markSubmissionAsRead(id);
    return { success: true, data };
  }

  // ---------- Themes ----------
  @Get('themes')
  async getThemes() {
    const data = await this.cmsService.getThemes();
    return { success: true, data };
  }

  @Get('themes/:id')
  async getThemeById(@Param('id') id: string) {
    const data = await this.cmsService.getThemeById(id);
    return { success: true, data };
  }

  @Post('themes')
  async createTheme(@Body() body: any) {
    const data = await this.cmsService.createTheme(body);
    return { success: true, data };
  }

  @Put('themes/:id')
  async updateTheme(@Param('id') id: string, @Body() body: any) {
    const data = await this.cmsService.updateTheme(id, body);
    return { success: true, data };
  }

  @Delete('themes/:id')
  async deleteTheme(@Param('id') id: string) {
    await this.cmsService.deleteTheme(id);
    return { success: true, data: null };
  }

  @Put('themes/:id/active')
  async setActiveTheme(@Param('id') id: string) {
    const data = await this.cmsService.setActiveTheme(id);
    return { success: true, data };
  }

  // ---------- Redirects ----------
  @Get('redirects')
  async getRedirects() {
    const data = await this.cmsService.getRedirects();
    return { success: true, data };
  }

  @Post('redirects')
  async createRedirect(@Body() body: any) {
    const data = await this.cmsService.createRedirect(body);
    return { success: true, data };
  }

  @Put('redirects/:id')
  async updateRedirect(@Param('id') id: string, @Body() body: any) {
    const data = await this.cmsService.updateRedirect(id, body);
    return { success: true, data };
  }

  @Delete('redirects/:id')
  async deleteRedirect(@Param('id') id: string) {
    await this.cmsService.deleteRedirect(id);
    return { success: true, data: null };
  }

  // ---------- Blogs ----------
  @Get('blogs')
  async getBlogs(@Query('status') status?: string) {
    const data = await this.cmsService.getBlogs(status);
    return { success: true, data };
  }

  @Get('blogs/:id')
  async getBlogById(@Param('id') id: string) {
    const data = await this.cmsService.getBlogById(id);
    return { success: true, data };
  }

  @Post('blogs')
  async createBlog(@Body() body: any) {
    const data = await this.cmsService.createBlog(body);
    return { success: true, data };
  }

  @Put('blogs/:id')
  async updateBlog(@Param('id') id: string, @Body() body: any) {
    const data = await this.cmsService.updateBlog(id, body);
    return { success: true, data };
  }

  @Delete('blogs/:id')
  async deleteBlog(@Param('id') id: string) {
    await this.cmsService.deleteBlog(id);
    return { success: true, data: null };
  }
}

// =============================================
// PUBLIC CMS CONTROLLER (no auth required)
// =============================================

@Controller('cms/public')
export class CmsPublicController {
  private readonly logger = new Logger(CmsPublicController.name);

  constructor(private readonly cmsService: CmsService) {}

  @Get('pages/:slug')
  async getPageBySlug(@Param('slug') slug: string) {
    const data = await this.cmsService.getPageBySlug(slug);
    return { success: true, data };
  }

  @Get('navigation')
  async getNavigation(@Query('type') navType?: string) {
    const data = await this.cmsService.getPublicNavigation(navType);
    return { success: true, data };
  }

  @Get('footer-categories')
  async getPublicFooterCategories() {
    const data = await this.cmsService.getPublicFooterCategories();
    return { success: true, data };
  }

  @Get('global-seo')
  async getGlobalSeo() {
    const data = await this.cmsService.getGlobalSeo();
    return { success: true, data };
  }

  @Get('brand-assets')
  async getBrandAssets() {
    const data = await this.cmsService.getBrandAssets();
    return { success: true, data };
  }

  @Get('root-files/:filename')
  async getRootFile(@Param('filename') filename: string, @Res() res: Response) {
    const data = await this.cmsService.getRootFileByFilename(filename);
    res.setHeader('Content-Type', 'text/plain');
    res.send(data.content);
  }

  @Get('blogs')
  async getPublishedBlogs() {
    const data = await this.cmsService.getPublishedBlogs();
    return { success: true, data };
  }

  @Get('blogs/:slug')
  async getBlogBySlug(@Param('slug') slug: string) {
    const data = await this.cmsService.getBlogBySlug(slug);
    return { success: true, data };
  }

  @Get('redirect')
  async checkRedirect(@Query('path') path: string) {
    const data = await this.cmsService.checkRedirect(path);
    return { success: true, data };
  }

  @Post('forms/:formId/submissions')
  async submitForm(@Param('formId') formId: string, @Body() body: any, @Req() req: Request) {
    const ipAddress = (req.headers['x-forwarded-for'] as string) || req.ip;
    const userAgent = req.headers['user-agent'];
    const data = await this.cmsService.createFormSubmission(formId, body, ipAddress, userAgent);
    return { success: true, data };
  }

  @Get('theme')
  async getActiveTheme() {
    const data = await this.cmsService.getActiveTheme();
    return { success: true, data };
  }
}
