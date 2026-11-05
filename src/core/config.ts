import { hasTemplate, render, templateErrors } from './template';
import { normalizeHttpUrl } from './url';
import type { AnyBlockDefinition, FieldSpec, Payload } from './types';

/**
 * - "design": validating what the user typed in the editor. Templated values such as
 *   `{{url}}` cannot be checked yet, so they are accepted as long as they are not empty.
 * - "run": validating the final values right before a block runs.
 */
export type ValidationMode = 'design' | 'run';

/** The first problem with one setting value, or null. */
function fieldError(field: FieldSpec, value: unknown, mode: ValidationMode): string | null {
  switch (field.kind) {
    case 'workflow': {
      const id = typeof value === 'string' ? value.trim() : '';
      return field.required && !id ? `${field.label} is required` : null;
    }
    case 'rows': {
      if (value !== undefined && !Array.isArray(value)) return `${field.label} must be a list`;
      const rows = (value ?? []) as Record<string, unknown>[];
      const [first] = field.columns;
      const filled = rows.filter((row) => field.columns.some((column) => String(row[column.key] ?? '').trim() !== ''));
      if (field.required && filled.length === 0) return `${field.label} needs at least one row`;
      const broken = filled.findIndex((row) => first && String(row[first.key] ?? '').trim() === '');
      if (broken >= 0 && first) return `${field.label}: row ${broken + 1} has no ${first.label}`;
      return null;
    }
    case 'text':
    case 'selector':
    case 'locator':
    case 'url': {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text) return field.required ? `${field.label} is required` : null;
      if (field.kind === 'url') {
        const deferred = mode === 'design' && hasTemplate(text);
        if (!deferred && !normalizeHttpUrl(text)) {
          return `${field.label} must be a valid http(s) URL`;
        }
      }
      return null;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${field.label} must be a number`;
      }
      if (field.min !== undefined && value < field.min) {
        return `${field.label} must be at least ${field.min}`;
      }
      if (field.max !== undefined && value > field.max) {
        return `${field.label} must be at most ${field.max}`;
      }
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${field.label} must be on or off`;
    case 'select':
      return field.options.some((option) => option.value === value)
        ? null
        : `${field.label} has an invalid choice`;
  }
}

/** Every problem with a block's settings. In design mode also reports broken `{{ }}` expressions. */
export function validateConfig(
  def: AnyBlockDefinition,
  config: Record<string, unknown>,
  mode: ValidationMode = 'run',
): string[] {
  const errors: string[] = [];
  for (const field of def.fields) {
    const error = fieldError(field, config[field.key], mode);
    if (error) errors.push(error);
    // While designing, catch broken {{ expressions }} before they render as ''.
    if (mode === 'design' && 'templated' in field && field.templated && typeof config[field.key] === 'string') {
      for (const problem of templateErrors(config[field.key] as string)) errors.push(`${field.label}: ${problem}`);
    }
  }
  return errors;
}

/** Applies defaults and coerces numeric strings, without rendering templates. */
export function withDefaults(
  def: AnyBlockDefinition,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...def.defaultConfig, ...raw };
  for (const field of def.fields) {
    const value = merged[field.key];
    if (field.kind === 'number' && typeof value === 'string' && value.trim() !== '') {
      merged[field.key] = Number(value);
    }
  }
  return merged;
}

/** Settings ready to run, plus any validation errors. */
export interface ResolvedConfig<C> {
  config: C;
  errors: string[];
}

/** Defaults + template rendering against `input` + validation. Used right before a block runs. */
export function resolveConfig<C extends object>(
  def: AnyBlockDefinition,
  raw: Record<string, unknown>,
  input: Payload,
): ResolvedConfig<C> {
  const merged = withDefaults(def, raw);
  for (const field of def.fields) {
    if (
      (field.kind === 'text' || field.kind === 'url' || field.kind === 'selector' || field.kind === 'locator') &&
      field.templated &&
      typeof merged[field.key] === 'string'
    ) {
      merged[field.key] = render(merged[field.key] as string, input);
    }
    if (field.kind === 'rows' && Array.isArray(merged[field.key])) {
      merged[field.key] = (merged[field.key] as Record<string, unknown>[]).map((row) => {
        const out: Record<string, string> = {};
        for (const column of field.columns) {
          const text = String(row[column.key] ?? '');
          out[column.key] = column.templated ? render(text, input) : text;
        }
        return out;
      });
    }
  }
  return { config: merged as C, errors: validateConfig(def, merged, 'run') };
}
