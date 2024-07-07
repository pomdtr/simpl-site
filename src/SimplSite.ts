import { join, extname } from "jsr:@std/path@0.224.0";
import { contentType } from "jsr:@std/media-types@0.224.0";
import type { WebsiteConfig, ContentSource, Plugin, PluginConfig, Metadata, PluginContext, TemplateContext } from "./types.ts";
import MarkdownProcessor from "./utils/MarkdownProcessor.ts";
import { TemplateEngine } from "./utils/TemplateEngine.ts";

export class SimplSite {
  private plugins: Map<string, Plugin> = new Map();
  private contentSources: ContentSource[];
  private defaultContentType: string;
  private templateDir: string;
  private customPluginsDir?: string;
  private assetsDir: string;
  private markdownProcessor: MarkdownProcessor;
  private templateEngine: TemplateEngine;
  private siteUrl: string;
  private siteTitle: string;

  constructor(private config: WebsiteConfig) {
    this.contentSources = config.contentSources;
    this.defaultContentType = config.defaultContentType;
    this.templateDir = config.templateDir;
    this.customPluginsDir = config.customPluginsDir;
    this.assetsDir = config.assetsDir || 'assets';
    this.siteUrl = config.siteUrl || 'http://localhost:8000';
    this.siteTitle = config.siteTitle || "My Simpl Site";
    this.markdownProcessor = new MarkdownProcessor();
    this.templateEngine = new TemplateEngine({
      baseDir: this.templateDir,
      helpers: config.templateHelpers,
      compilerOptions: config.templateCompilerOptions,
    });
    this.initializePlugins(config.plugins);
  }

  private async initializePlugins(pluginConfigs: PluginConfig[]) {
    console.log("Initializing plugins...");
    for (const pluginConfig of pluginConfigs) {
      if (this.customPluginsDir) {
        try {
          const pluginPath = join(Deno.cwd(), this.customPluginsDir, `${pluginConfig.name}.ts`);
          console.log(`Loading plugin from: ${pluginPath}`);
          const PluginClass = await import(pluginPath);
          const plugin = new PluginClass.default(pluginConfig.options) as Plugin;
          this.plugins.set(pluginConfig.name, plugin);
          console.log(`Successfully loaded and initialized plugin: ${pluginConfig.name}`);
        } catch (error) {
          console.error(`Error loading plugin ${pluginConfig.name}:`, error);
        }
      } else {
        console.error(`Unable to load plugin ${pluginConfig.name}: No custom plugins directory specified`);
      }
    }
    console.log(`Initialization complete. Loaded plugins: ${Array.from(this.plugins.keys()).join(', ')}`);
  }

  async getContent(path: string, type: string): Promise<string> {
    const source = this.contentSources.find(src => src.type === type);
    if (!source) {
      throw new Error(`Unknown content type: ${type}`);
    }
    const fullPath = join(source.path, path);
    return await Deno.readTextFile(fullPath);
  }

  async processContent(content: string, type: string, route: string): Promise<{ content: string; metadata: Metadata }> {
    let { content: processedContent, metadata } = await this.markdownProcessor.execute(content);
  
    const context: PluginContext = {
      contentType: type,
      route: route,
      templateDir: this.templateDir,
      contentSources: Object.fromEntries(
        this.contentSources.map(source => [source.type, source.path])
      ),
      siteUrl: this.siteUrl 
    };
  
    for (const plugin of this.plugins.values()) {
      if (plugin.transform) {
        const result = await plugin.transform(processedContent, context);
        processedContent = result.content;
        if (result.metadata) {
          metadata = { ...metadata, ...result.metadata };
        }
      }
    }
  
    return { content: processedContent, metadata };
  }
  
  async renderContent(path: string, type: string, route: string): Promise<{ content: string; status: number }> {
    try {
      console.log(`Rendering content for path: ${path}, type: ${type}, route: ${route}`);
      
      const content = await this.getContent(path, type);
      console.log('Raw content retrieved');
  
      const { content: processedContent, metadata } = await this.processContent(content, type, route);
      console.log('Content processed');
  
      let templateContext: TemplateContext = {
        content: processedContent,
        metadata: metadata,
        route: route,
        siteTitle: this.siteTitle,
      };
  
      // Allow plugins to extend template context
      for (const plugin of this.plugins.values()) {
        if (plugin.extendTemplate) {
          templateContext = await plugin.extendTemplate(templateContext);
        }
      }
  
      const renderedContent = await this.templateEngine.render(type, templateContext);
      console.log('Template rendering complete');
      
      return { content: renderedContent, status: 200 };
    } catch (error) {
      console.error('Error during content rendering:', error);
  
      // If the error is NotFound and we're not already trying to render the 404 page
      if (error.name === "NotFound" && path !== "404.md") {
        try {
          console.log('Attempting to render 404 page');
          const { content: notFoundContent } = await this.renderContent("404.md", this.defaultContentType, "/404");
          return { content: notFoundContent, status: 404 };
        } catch (notFoundError) {
          console.error('Error rendering 404 page:', notFoundError);
        }
      }
  
      // Default error message if 404 page is not found or for other types of errors
      return {
        content: "<h1>404 - Page Not Found</h1><p>The requested page could not be found.</p>",
        status: 404
      };
    }
  }


  private async serveStaticFile(path: string): Promise<{ content: Uint8Array; contentType: string } | null> {
    const fullPath = join(this.assetsDir, path);
    try {
      const content = await Deno.readFile(fullPath);
      const mimeType = contentType(extname(fullPath)) || "application/octet-stream";
      return { content, contentType: mimeType };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async handleRequest(path: string): Promise<{ content: string | Uint8Array; contentType: string; status: number }> {
    console.log(`Handling request for path: ${path}`);
  
    // Remove leading slash and handle root path
    path = path.replace(/^\//, '');
    if (path === '') {
      path = 'index';
    }
  
    // Check if the request is for a static file
    const staticFile = await this.serveStaticFile(path);
    if (staticFile) {
      console.log(`Serving static file: ${path}`);
      return { ...staticFile, status: 200 };
    }
  
    // If not a static file, proceed with content rendering
    console.log(`Rendering content for path: ${path}`);
    const originalPath = path;
    path = path.endsWith('.md') ? path : path + '.md';
  
    for (const source of this.contentSources) {
      if (originalPath.startsWith(source.route)) {
        const contentPath = path.slice(source.route.length);
        const { content, status } = await this.renderContent(contentPath, source.type, '/' + originalPath);
        return { content, contentType: "text/html", status };
      }
    }
  
    const { content, status } = await this.renderContent(path, this.defaultContentType, '/' + originalPath);
    return { content, contentType: "text/html", status };
  }
}