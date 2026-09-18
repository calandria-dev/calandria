import type {
  CatalogDescriptor,
  EnvScope,
  PresentedVariable,
  StoredVariable,
  ValidationResult,
} from "./types.js";

export const CATALOG: readonly CatalogDescriptor[];

export function isGloballyReservedName(name: string): boolean;
export function isAgentScopeReservedName(name: string): boolean;
export function lookupDescriptor(name: string): CatalogDescriptor | undefined;
export function listEditableDescriptors(scope?: EnvScope): CatalogDescriptor[];
export function validateNameShape(name: string): ValidationResult;
export function validateNameForScope(name: string, scope: EnvScope): ValidationResult;
export function validateValue(descriptor: CatalogDescriptor | undefined, value: string): ValidationResult;
export function canonicalizeForUniqueness(name: string): string;
export function findDuplicateRow(
  rows: readonly StoredVariable[],
  scope: EnvScope,
  name: string,
  excludeId?: string,
): StoredVariable | undefined;
export function redactStoredVariable(
  row: StoredVariable,
  opts?: { overriddenByHost?: boolean },
): PresentedVariable;
