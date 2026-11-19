/** What configures the ACP executor: the child to start and the MCP servers it hands to its sessions (§6.15). */

import { z } from "zod";

const NonEmpty = z.string().min(1);

/** One MCP server handed to the ACP session at session/new (§6.15). */
const AcpMcpServerSchema = z.object({
  name: NonEmpty,
  command: NonEmpty,
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type AcpMcpServer = z.infer<typeof AcpMcpServerSchema>;

/**
 * ACP executor options: the `dsh` stdio server (§6.15). It runs in the host's own
 * profile, which the plugin passes in; there is no profile to configure (D46).
 */
export const AcpExecutorConfigSchema = z.object({
  command: NonEmpty.optional(),
  extra_args: z.array(z.string()).optional(),
  /** MCP servers passed to session/new — how an ACP agent gets extra tools. */
  mcp_servers: z.array(AcpMcpServerSchema).optional(),
});
export type AcpExecutorConfig = z.infer<typeof AcpExecutorConfigSchema>;
