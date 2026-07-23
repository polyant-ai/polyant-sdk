// SPDX-License-Identifier: Apache-2.0

export { defineTool, toJsonSchema, normalizeRequiredSecrets, requiredSecretKeys, oauthRequiredSecrets } from "./contract.js";
export type {
  ToolSpec,
  ToolDefinition,
  ToolInfo,
  ToolInputExample,
  RequiredSecretSpec,
  RequiredSecretsInput,
  OAuthProviderSpec,
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
  OAuthTokenResult,
  OAuthAccessApi,
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
