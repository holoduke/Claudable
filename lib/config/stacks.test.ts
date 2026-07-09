import { describe, expect, it } from 'vitest';
import { STACKS, stackKind, isValidStack, DEFAULT_STACK } from './stacks';

describe('stacks', () => {
  it('maps the filament stack to the laravel kind', () => {
    expect(stackKind('filament')).toBe('laravel');
    expect(isValidStack('filament')).toBe(true);
    expect(STACKS.find((s) => s.id === 'filament')?.kind).toBe('laravel');
  });

  it('keeps the node stacks mapped correctly', () => {
    expect(stackKind('nuxt')).toBe('nuxt');
    expect(stackKind('next')).toBe('next');
    expect(stackKind('angular')).toBe('angular');
    expect(stackKind('document')).toBe('static');
  });

  it('defaults unknown/legacy stacks to nuxt', () => {
    expect(stackKind(undefined)).toBe('nuxt');
    expect(stackKind('who-knows')).toBe('nuxt');
    expect(isValidStack(DEFAULT_STACK)).toBe(true);
  });
});
