/**
 * Types for the registry layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */

/** The subset of NeuroLink this module drives. Kept structural so it is testable. */
export type McpHost = {
  addExternalMCPServer(
    id: string,
    config: Record<string, unknown>,
  ): Promise<
    | {
        success?: boolean;
        error?: string;
        metadata?: { toolsDiscovered?: number };
      }
    | undefined
  >;
  removeExternalMCPServer(id: string): Promise<unknown>;
  getExternalMCPServerTools(
    id: string,
  ): Array<{ name?: string }> | Promise<Array<{ name?: string }>>;
};

export type RegistryLogger = {
  info(message: string): void;
  warn(message: string): void;
};
