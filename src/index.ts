// SPDX-License-Identifier: AGPL-3.0-or-later

export { defineTool, toJsonSchema, normalizeRequiredSecrets, requiredSecretKeys } from "./contract.js";
export type {
  ToolSpec,
  ToolDefinition,
  ToolInfo,
  ToolInputExample,
  RequiredSecretSpec,
  RequiredSecretsInput,
} from "./contract.js";
export type {
  InstanceSlug,
  ToolContext,
  AuditLogger,
  Attachment,
  ChannelStateIdentity,
  ConversationStateApi,
  ToolApiKeys,
} from "./context-types.js";
