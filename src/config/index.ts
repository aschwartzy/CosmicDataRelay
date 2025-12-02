import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';

const browserSchema = z.object({
  headless: z.boolean().default(true),
  timeout: z.number().int().positive().default(30000)
});

const scheduleSchema = z.object({
  minInterval: z.number().int().positive(),
  jitter: z.number().int().nonnegative().default(0),
  backoffMultiplier: z.number().positive().default(2),
  maxBackoff: z.number().int().positive().default(3600)
});

const selectorSchema = z.object({
  field: z.string(),
  selector: z.string(),
  attribute: z.string().optional()
});

const parseRuleSchema = z.object({
  field: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'date', 'json']).default('string'),
  regex: z.string().optional()
});

const outputFieldTypeSchema = z.enum(['string', 'number', 'boolean', 'date', 'json']);

const sourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().url(),
  description: z.string().optional(),
  browser: browserSchema.default({ headless: true, timeout: 30000 }),
  schedule: scheduleSchema,
  selectors: z.array(selectorSchema),
  parse: z.array(parseRuleSchema).optional().default([]),
  outputSchema: z.record(outputFieldTypeSchema)
});

export type SourceConfig = z.infer<typeof sourceSchema>;

export interface ResolvedSourceConfig extends SourceConfig {
  outputParser: z.ZodObject<Record<string, z.ZodTypeAny>>;
}

const typeToSchema: Record<string, () => z.ZodTypeAny> = {
  string: () => z.string(),
  number: () => z.number(),
  boolean: () => z.boolean(),
  date: () => z.preprocess((v) => (typeof v === 'string' || v instanceof Date ? new Date(v) : v), z.date()),
  json: () => z.any()
};

function buildOutputParser(outputSchema: SourceConfig['outputSchema']) {
  const shape: Record<string, z.ZodTypeAny> = {};
  Object.entries(outputSchema).forEach(([key, typeName]) => {
    const factory = typeToSchema[typeName];
    shape[key] = factory();
  });
  return z.object(shape);
}

function applyParseRule(value: unknown, rule: z.infer<typeof parseRuleSchema>) {
  if (value == null) return value;
  let parsedValue: unknown = value;
  if (typeof parsedValue === 'string') {
    const trimmed = parsedValue.trim();
    parsedValue = trimmed === '' ? parsedValue : trimmed;
    if (rule.regex) {
      const match = trimmed.match(new RegExp(rule.regex));
      parsedValue = match?.[1] ?? match?.[0] ?? parsedValue;
    }
  }

  switch (rule.type) {
    case 'number':
      return Number(parsedValue);
    case 'boolean':
      return typeof parsedValue === 'string'
        ? ['true', '1', 'yes'].includes(parsedValue.toLowerCase())
        : Boolean(parsedValue);
    case 'date':
      return new Date(parsedValue as string);
    case 'json':
      if (typeof parsedValue === 'string') {
        try {
          return JSON.parse(parsedValue);
        } catch (error) {
          return parsedValue;
        }
      }
      return parsedValue;
    default:
      return parsedValue;
  }
}

export async function loadSourceConfigs(sourcesDir = path.join(process.cwd(), 'sources')): Promise<ResolvedSourceConfig[]> {
  const files = (await fs.promises.readdir(sourcesDir)).filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'));

  const configs: ResolvedSourceConfig[] = [];
  for (const file of files) {
    const filePath = path.join(sourcesDir, file);
    const contents = await fs.promises.readFile(filePath, 'utf8');
    const parsedYaml = YAML.parse(contents);
    const config = sourceSchema.parse(parsedYaml);
    const outputParser = buildOutputParser(config.outputSchema);
    configs.push({ ...config, outputParser });
  }

  return configs;
}

export function applyParsers(raw: Record<string, unknown>, rules: SourceConfig['parse']) {
  const parsed: Record<string, unknown> = { ...raw };
  for (const rule of rules) {
    const value = parsed[rule.field];
    parsed[rule.field] = applyParseRule(value, rule);
  }
  return parsed;
}

export async function upsertSources(prisma: PrismaClient, configs: ResolvedSourceConfig[]) {
  for (const config of configs) {
    const { outputParser, ...persistable } = config;
    await prisma.source.upsert({
      where: { id: config.id },
      update: {
        name: config.name,
        url: config.url,
        description: config.description,
        config: persistable
      },
      create: {
        id: config.id,
        name: config.name,
        url: config.url,
        description: config.description,
        config: persistable
      }
    });
  }
}

export { browserSchema, scheduleSchema, selectorSchema, parseRuleSchema };
