import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { MIN_CRAWL_INTERVAL_MS } from '../shared/constants';

const browserTimeoutSchema = z.object({
  navigationMs: z.number().int().positive().default(30000),
  actionMs: z.number().int().positive().default(10000)
});

const viewportSchema = z.object({
  width: z.number().int().positive().default(1280),
  height: z.number().int().positive().default(720)
});

const browserSchema = z.object({
  headless: z.boolean().default(true),
  userAgent: z.string().min(1).optional(),
  viewport: viewportSchema.default({ width: 1280, height: 720 }),
  timeouts: browserTimeoutSchema.default({ navigationMs: 30000, actionMs: 10000 })
});

const scheduleSchema = z.object({
  intervalMs: z.number().int().positive(),
  jitterMs: z.number().int().nonnegative().default(0),
  backoffMultiplier: z.number().positive().default(2),
  maxBackoffMs: z.number().int().positive().default(3_600_000),
  failureLimit: z.number().int().positive().default(5)
});

const selectorSchema = z
  .object({
    css: z.string().min(1).optional(),
    xpath: z.string().min(1).optional(),
    attribute: z.string().min(1).optional()
  })
  .refine((value) => value.css || value.xpath, { message: 'Provide either css or xpath for a selector' });

const selectorsSchema = z.record(selectorSchema);

const parseRuleSchema = z.object({
  field: z.string(),
  targetField: z.string().optional(),
  type: z.enum(['string', 'int', 'float', 'datetime', 'number']).default('string'),
  regex: z.string().optional(),
  unit: z.string().optional()
});

const outputFieldTypeSchema = z.enum(['string', 'int', 'float', 'number', 'boolean', 'datetime', 'json']);

export const sourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().url(),
  description: z.string().optional(),
  allowedToScrape: z.boolean().default(false),
  enabled: z.boolean().default(true),
  browser: browserSchema.default({
    headless: true,
    viewport: { width: 1280, height: 720 },
    timeouts: { navigationMs: 30000, actionMs: 10000 }
  }),
  schedule: scheduleSchema,
  selectors: selectorsSchema,
  parse: z.array(parseRuleSchema).optional().default([]),
  outputSchema: z.record(outputFieldTypeSchema)
});

export type SourceConfig = z.infer<typeof sourceSchema>;
export type SelectorConfig = z.infer<typeof selectorsSchema>;

export interface ResolvedSelector extends z.infer<typeof selectorSchema> {
  field: string;
}

export interface ResolvedSchedule extends z.infer<typeof scheduleSchema> {
  effectiveIntervalMs: number;
}

export interface ResolvedSourceConfig extends Omit<SourceConfig, 'selectors' | 'schedule'> {
  selectors: SelectorConfig;
  selectorList: ResolvedSelector[];
  schedule: ResolvedSchedule;
  outputParser: z.ZodObject<Record<string, z.ZodTypeAny>>;
  enabled: boolean;
}

const typeToSchema: Record<string, () => z.ZodTypeAny> = {
  string: () => z.string(),
  number: () => z.number(),
  float: () => z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number()),
  int: () =>
    z.preprocess(
      (v) =>
        typeof v === 'string'
          ? Number.parseInt(v as string, 10)
          : typeof v === 'number'
            ? Math.trunc(v)
            : v,
      z.number().int()
    ),
  boolean: () => z.boolean(),
  datetime: () => z.preprocess((v) => (typeof v === 'string' || v instanceof Date ? new Date(v) : v), z.date()),
  json: () => z.any()
};

function buildOutputParser(outputSchema: SourceConfig['outputSchema']) {
  const shape: Record<string, z.ZodTypeAny> = {};
  Object.entries(outputSchema).forEach(([key, typeName]) => {
    const factory = typeToSchema[typeName];
    if (!factory) {
      throw new Error(`Unsupported output type "${typeName}" for field ${key}`);
    }
    shape[key] = factory();
  });
  return z.object(shape);
}

export function resolveSourceConfig(baseConfig: SourceConfig): ResolvedSourceConfig {
  const effectiveIntervalMs = Math.max(MIN_CRAWL_INTERVAL_MS, baseConfig.schedule.intervalMs);
  const schedule: ResolvedSchedule = {
    ...baseConfig.schedule,
    effectiveIntervalMs
  };

  const selectorList: ResolvedSelector[] = Object.entries(baseConfig.selectors).map(([field, selector]) => ({
    field,
    ...selector
  }));

  const outputParser = buildOutputParser(baseConfig.outputSchema);
  const resolvedEnabled = baseConfig.allowedToScrape && baseConfig.enabled;

  return {
    ...baseConfig,
    enabled: resolvedEnabled,
    selectorList,
    schedule,
    outputParser
  };
}

function applyParseRule(value: unknown, rule: z.infer<typeof parseRuleSchema>) {
  if (value == null) return value;
  let parsedValue: unknown = value;

  if (typeof parsedValue === 'string') {
    const trimmed = parsedValue.trim();
    parsedValue = trimmed === '' ? parsedValue : trimmed;

    if (rule.unit) {
      parsedValue = trimmed.replace(new RegExp(rule.unit, 'gi'), '').trim();
    }

    if (rule.regex) {
      const regex = new RegExp(rule.regex);
      const match = trimmed.match(regex);
      parsedValue = match?.[1] ?? match?.[0] ?? parsedValue;
    }
  }

  switch (rule.type) {
    case 'float':
    case 'number':
      return Number.parseFloat(String(parsedValue));
    case 'int':
      return Number.parseInt(String(parsedValue), 10);
    case 'datetime': {
      const dateValue = parsedValue instanceof Date ? parsedValue : new Date(String(parsedValue));
      return Number.isNaN(dateValue.getTime()) ? parsedValue : dateValue;
    }
    default:
      return parsedValue;
  }
}

function formatZodError(error: z.ZodError) {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
    .join('; ');
}

async function collectYamlFiles(directory: string): Promise<string[]> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectYamlFiles(fullPath);
      }
      if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
        return [fullPath];
      }
      return [] as string[];
    })
  );

  return files.flat();
}

export async function loadSourceConfigs(
  sourcesDir = path.join(process.cwd(), 'sources')
): Promise<ResolvedSourceConfig[]> {
  const files = await collectYamlFiles(sourcesDir);

  const configs: ResolvedSourceConfig[] = [];
  for (const filePath of files) {
    try {
      const contents = await fs.promises.readFile(filePath, 'utf8');
      const parsedYaml = YAML.parse(contents) ?? {};
      const parsed = sourceSchema.safeParse(parsedYaml);

      if (!parsed.success) {
        console.error(`[config] Validation failed for ${filePath}: ${formatZodError(parsed.error)}`);
        throw new Error(`Invalid source config at ${filePath}`);
      }

      const baseConfig = parsed.data;
      const resolved = resolveSourceConfig(baseConfig);
      configs.push(resolved);
      console.info(`[config] loaded source ${baseConfig.id} from ${path.basename(filePath)}`);
    } catch (error) {
      console.error(
        `[config] Failed to load config from ${filePath}:`,
        error instanceof Error ? error.message : error
      );
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  return configs;
}

export function applyParsers(raw: Record<string, unknown>, rules: SourceConfig['parse'] = []) {
  const parsed: Record<string, unknown> = { ...raw };
  for (const rule of rules) {
    const value = parsed[rule.field];
    const target = rule.targetField ?? rule.field;
    parsed[target] = applyParseRule(value, rule);
  }
  return parsed;
}

export async function upsertSources(prisma: PrismaClient, configs: ResolvedSourceConfig[]) {
  for (const config of configs) {
    const { outputParser, selectorList, ...persistable } = config;
    await prisma.source.upsert({
      where: { id: config.id },
      update: {
        name: config.name,
        url: config.url,
        description: config.description,
        enabled: config.enabled,
        config: persistable
      },
      create: {
        id: config.id,
        name: config.name,
        url: config.url,
        description: config.description,
        enabled: config.enabled,
        config: persistable
      }
    });
  }
}

export { browserSchema, scheduleSchema, selectorSchema, parseRuleSchema, formatZodError };
