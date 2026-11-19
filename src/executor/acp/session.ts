/** One ACP session of the executor's child, and the config options the agent reports for it. */

import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { PromptResponse, SessionConfigOption, SessionConfigOptionCategory } from "@agentclientprotocol/sdk";

import { errorMessage } from "../../core/errors.ts";
import { describeModelRequest } from "../model.ts";
import type { AcpConnection } from "./connection.ts";

/**
 * One open ACP session and the config options the agent last reported for it
 * (model, reasoning effort): selecting a model can change which efforts exist,
 * so the session replaces them with what each `set_config_option` returns.
 */
export class AcpSession {
  constructor(
    /** The executor's one connection; every session shares it and its child. */
    readonly connection: AcpConnection,
    readonly id: string,
    private options: SessionConfigOption[],
  ) {}

  /**
   * ACP selects the model per session (§6.15) through the session's config
   * options, found by their ACP category (`model`, `thought_level`) rather than
   * by id; the ACP server rejects unknown values. The effort is
   * written only when the task (or the node default) supplies one: DeepSeek
   * models expose a fixed default effort, and dsh-acp rejects the empty
   * "provider default" value for them. Returns why it failed, or null.
   */
  async selectModel(
    model: ModelSelection | undefined,
    reasoningEffort: ReasoningEffortId | undefined,
  ): Promise<string | null> {
    try {
      // dsh-acp names a model option by its route, `[provider, model]` as JSON.
      if (model !== undefined) await this.setOption("model", JSON.stringify([model.provider, model.model]));
      if (reasoningEffort !== undefined) await this.setOption("thought_level", reasoningEffort);
      return null;
    } catch (error) {
      return `cannot select ${describeModelRequest(model, reasoningEffort)}: ${errorMessage(error)}`;
    }
  }

  /** Run one prompt to its stop reason. */
  prompt(text: string): Promise<PromptResponse> {
    return this.connection.request("session/prompt", { sessionId: this.id, prompt: [{ type: "text", text }] });
  }

  /** Set the option the agent files under `category`; the agent answers with its options as they are now. */
  private async setOption(category: SessionConfigOptionCategory, value: string): Promise<void> {
    const option = this.options.find((candidate) => candidate.category === category);
    if (option === undefined) throw new Error(`the agent offers no "${category}" option`);
    const answer = await this.connection.request("session/set_config_option", {
      sessionId: this.id,
      configId: option.id,
      value,
    });
    this.options = answer?.configOptions ?? this.options;
  }
}
