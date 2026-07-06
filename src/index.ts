// SPDX-License-Identifier: Apache-2.0

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
  ConversationRole,
  ConversationMessage,
  RecentMessagesOptions,
  ConversationHistoryApi,
  ToolApiKeys,
} from "./context-types.js";
export { defineHook } from "./hooks.js";
export type {
  HookSpec,
  HookFunctionDefinition,
  HookResult,
  HookContext,
  HookEvent,
  HookEventPayload,
  HookAi,
} from "./hooks.js";
