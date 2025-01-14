import Handlebars from "npm:handlebars@4.7.8";
import { TemplateEngineConfig, HelperDelegate, RuntimeOptions } from '../types.ts';
import { join } from "jsr:@std/path@0.224.0";
import { exists } from "jsr:@std/fs@0.224.0";



export class TemplateEngine {
  private handlebars: typeof Handlebars;
  private config: TemplateEngineConfig;
  private compiledTemplates: Map<string, Handlebars.TemplateDelegate> = new Map();

  constructor(config: Partial<TemplateEngineConfig>) {
    this.config = {
      baseDir: 'templates',
      extname: '.hbs',
      layoutsDir: 'layouts/',
      partialsDir: 'partials/',
      defaultLayout: 'base',
      ...config,
    };
    this.handlebars = Handlebars.create();
    this.registerHelpers();
    this.registerPartials();
  }

  private registerHelpers() {
    if (this.config.helpers) {
      Object.entries(this.config.helpers).forEach(([name, helper]) => {
        this.handlebars.registerHelper(name, helper);
      });
    }
  }

  private async registerPartials() {
    const partialsDir = join(this.config.baseDir, this.config.partialsDir);
    for await (const dirEntry of Deno.readDir(partialsDir)) {
      if (dirEntry.isFile && dirEntry.name.endsWith(this.config.extname)) {
        const partialName = dirEntry.name.slice(0, -this.config.extname.length);
        const partialContent = await Deno.readTextFile(join(partialsDir, dirEntry.name));
        this.handlebars.registerPartial(partialName, partialContent);
      }
    }
  }

  async render(templateName: string, context: Record<string, unknown>): Promise<string> {
    console.log(`Rendering template: ${templateName}`);
    try {
      const templatePath = join(this.config.baseDir, `${templateName}${this.config.extname}`);
      const layoutPath = join(this.config.baseDir, this.config.layoutsDir, `${this.config.defaultLayout}${this.config.extname}`);
      
      if (!await exists(templatePath)) {
        throw new Error(`Template not found: ${templatePath}`);
      }

      let template = this.compiledTemplates.get(templatePath);
      if (!template) {
        const templateContent = await Deno.readTextFile(templatePath);
        template = this.handlebars.compile(templateContent, this.config.compilerOptions);
        this.compiledTemplates.set(templatePath, template);
      }

      let result = template(context);

      if (await exists(layoutPath)) {
        let layout = this.compiledTemplates.get(layoutPath);
        if (!layout) {
          const layoutContent = await Deno.readTextFile(layoutPath);
          layout = this.handlebars.compile(layoutContent, this.config.compilerOptions);
          this.compiledTemplates.set(layoutPath, layout);
        }
        result = layout({ ...context, body: result });
      }

      console.log(`Template rendered successfully: ${templateName}`);
      return result;
    } catch (error) {
      console.error(`Error rendering template ${templateName}:`, error);
      throw error;
    }
  }
}